"use strict";

// Starts T3 Code through LaunchServices with --inspect-brk, loads the extension host
// before T3's own main script runs, then closes the inspector.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
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

// Result: { kind: "activated", pid } | { kind: "injected", pid, port }
//       | { kind: "no-inspector", port, error } | { kind: "inject-failed", pid, port, error }
async function launch({ app, env = {}, appArgs = [], timeoutMs = 20_000, hostEntry = HOST_ENTRY }) {
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
