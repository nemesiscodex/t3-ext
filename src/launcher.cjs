"use strict";

// Starts T3 Code through LaunchServices with --inspect-brk, loads the extension host
// before T3's own main script runs, then closes the inspector.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Cdp, targets, waitFor } = require("./cdp.cjs");

const HOST_ENTRY = path.join(__dirname, "..", "host", "index.cjs");

function plistValue(app, key) {
  return execFileSync("plutil", ["-extract", key, "raw", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
}

// PID of the GUI instance LaunchServices knows for exactly this bundle path, if any.
function runningPid(app) {
  const wanted = fs.realpathSync(app);
  const asns = execFileSync("lsappinfo", ["find", `bundleid=${plistValue(app, "CFBundleIdentifier")}`], { encoding: "utf8" }).match(/ASN:[^:\s]+:/g) ?? [];
  for (const asn of asns) {
    const info = execFileSync("lsappinfo", ["info", "-only", "pid", "-only", "bundlepath", asn], { encoding: "utf8" });
    const pid = Number(info.match(/"pid"=(\d+)/)?.[1]);
    const bundlePath = info.match(/"LSBundlePath"="(.*)"/)?.[1];
    if (pid && bundlePath && fs.existsSync(bundlePath) && fs.realpathSync(bundlePath) === wanted) return pid;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// `open` would otherwise leak ELECTRON_RUN_AS_NODE when the launcher itself runs on T3's binary.
function openEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function injectExpression(hostEntry) {
  return `(() => {
    try { require(${JSON.stringify(hostEntry)}).start(); return null; }
    catch (error) { return String((error && error.stack) || error); }
    finally { setImmediate(() => require("node:inspector").close()); }
  })()`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One launch per app at a time. Otherwise two launchers both see "not running", LaunchServices
// starts one instance, and the other waits for an inspector that never opens. The lock file
// holds the owner's pid; it is linked into place whole, so a reader never sees it half written.
async function acquireLaunchLock(app, timeoutMs) {
  const id = crypto.createHash("sha256").update(fs.realpathSync(app)).digest("hex").slice(0, 16);
  const lock = path.join(os.tmpdir(), `t3ext-launch-${id}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tmp = `${lock}.${process.pid}`;
    fs.writeFileSync(tmp, String(process.pid));
    try {
      fs.linkSync(tmp, lock);
      return () => fs.rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    let holder;
    try {
      holder = Number(fs.readFileSync(lock, "utf8"));
    } catch {
      continue;
    }
    if (!isAlive(holder)) {
      fs.rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Another launch of ${app} (pid ${holder}) is still running; lock ${lock}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Result: { kind: "activated", pid } | { kind: "injected", pid, port }
//       | { kind: "no-inspector", port, error } | { kind: "inject-failed", pid, port, error }
async function launch({ timeoutMs = 20_000, ...options }) {
  const release = await acquireLaunchLock(options.app, timeoutMs * 3);
  try {
    return await launchUnlocked({ ...options, timeoutMs });
  } finally {
    release();
  }
}

async function launchUnlocked({ app, env = {}, appArgs = [], timeoutMs, hostEntry = HOST_ENTRY }) {
  const existing = runningPid(app);
  if (existing) {
    execFileSync("open", ["-a", app], { env: openEnv() });
    return { kind: "activated", pid: existing };
  }

  const port = await freePort();
  const envFlags = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  execFileSync("open", ["-a", app, ...envFlags, "--args", `--inspect-brk=127.0.0.1:${port}`, ...appArgs], { env: openEnv() });

  let target;
  try {
    target = await waitFor("T3's inspector", async () => (await targets(port))[0], { timeoutMs });
  } catch (error) {
    return { kind: "no-inspector", port, error: error.message };
  }

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Debugger.enable");
    await cdp.send("Runtime.runIfWaitingForDebugger");
    const paused = await cdp.event("Debugger.paused", timeoutMs);
    const { result, exceptionDetails } = await cdp.send("Debugger.evaluateOnCallFrame", {
      callFrameId: paused.callFrames[0].callFrameId,
      expression: injectExpression(hostEntry),
      returnByValue: true,
    });
    const error = exceptionDetails ? (exceptionDetails.exception?.description ?? exceptionDetails.text) : result.value;
    const pid = runningPid(app);
    return error ? { kind: "inject-failed", pid, port, error } : { kind: "injected", pid, port };
  } catch (error) {
    return { kind: "inject-failed", pid: runningPid(app), port, error: error.message };
  } finally {
    await cdp.send("Debugger.resume").catch(() => {});
    cdp.close();
  }
}

module.exports = { launch, runningPid, plistValue, HOST_ENTRY };
