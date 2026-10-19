"use strict";

// Drives one T3 Code instance to "running with the extension host". The instance is in one of
// four states, read fresh before every step:
//   stopped   no process for this bundle path
//   starting  a process, but it has not finished launching (LaunchServices "ready" flag unset)
//   bare      running without the host
//   hosted    running, and the host answers on its presence socket
// launch: stopped -> start with --inspect-brk; bare -> attach over SIGUSR1; then bring T3 forward.
// attach: the same, except it never starts or activates T3.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { Cdp, targets, waitFor } = require("./cdp.cjs");
const { readFuses } = require("./fuses.cjs");
const { hostAnswers, userTempDir } = require("../host/presence.cjs");

const HOST_ENTRY = path.join(__dirname, "..", "host", "index.cjs");
// SIGUSR1 makes Node open its inspector on the default port; there is no way to pick another.
const SIGNAL_PORT = 9229;
const INSPECTOR_OPEN_MS = 5000;

function plistValue(app, key) {
  return execFileSync("plutil", ["-extract", key, "raw", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
}

// The GUI instance LaunchServices knows for exactly this bundle path, if any.
function instance(app) {
  const wanted = fs.realpathSync(app);
  const asns = execFileSync("lsappinfo", ["find", `bundleid=${plistValue(app, "CFBundleIdentifier")}`], { encoding: "utf8" }).match(/ASN:[^:\s]+:/g) ?? [];
  for (const asn of asns) {
    const info = execFileSync("lsappinfo", ["info", "-only", "pid", "-only", "bundlepath", "-only", "LSApplicationHasSignalledItIsReady", asn], { encoding: "utf8" });
    const pid = Number(info.match(/"pid"=(\d+)/)?.[1]);
    const bundlePath = info.match(/"LSBundlePath"="(.*)"/)?.[1];
    if (pid && bundlePath && fs.existsSync(bundlePath) && fs.realpathSync(bundlePath) === wanted) {
      return { pid, ready: /"LSApplicationHasSignalledItIsReady"=true/.test(info) };
    }
  }
  return null;
}

function runningPid(app) {
  return instance(app)?.pid ?? null;
}

async function observe(app) {
  const running = instance(app);
  if (!running) return { state: "stopped" };
  if (await hostAnswers(running.pid)) return { state: "hosted", pid: running.pid };
  return { state: running.ready ? "bare" : "starting", pid: running.pid };
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

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function portOwner(port) {
  try {
    const fields = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8" });
    const pid = fields.match(/^p(\d+)$/m)?.[1];
    const command = fields.match(/^c(.*)$/m)?.[1];
    return pid ? ` by ${command} (pid ${pid})` : "";
  } catch {
    return "";
  }
}

function accepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const inspectorClosed = (port) =>
  waitFor("the inspector to close", async () => !(await accepts(port)), { timeoutMs: 5000, intervalMs: 250 }).then(
    () => true,
    () => false,
  );

// `open` would otherwise leak ELECTRON_RUN_AS_NODE when the launcher itself runs on T3's binary.
function openEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function openApp(app, { env = {}, appArgs = [] } = {}) {
  const envFlags = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  execFileSync("open", ["-a", app, ...envFlags, ...(appArgs.length ? ["--args", ...appArgs] : [])], { env: openEnv() });
}

// Loads the host and schedules the inspector to close. Works paused at T3's first line (the
// module's own `require`) and in a running process (the console's `require`, which
// Runtime.evaluate provides with includeCommandLineAPI). With `pid`, it refuses to touch any
// other process that happens to own the inspector port, and leaves that inspector open.
function hostExpression(hostEntry, pid) {
  return `(() => {
    const load = require;
    ${pid ? `if (process.pid !== ${pid}) return { error: "the inspector on this port belongs to pid " + process.pid + ", not " + ${pid} };` : ""}
    try { return { value: load(${JSON.stringify(hostEntry)}).start() }; }
    catch (error) { return { error: String((error && error.stack) || error) }; }
    finally { setImmediate(() => load("node:inspector").close()); }
  })()`;
}

function evaluated({ result, exceptionDetails }) {
  if (exceptionDetails) return { error: exceptionDetails.exception?.description ?? exceptionDetails.text };
  return result.value ?? { error: "the evaluation returned nothing" };
}

const failed = (reason, pid, message) => ({ kind: "failed", reason, pid, message });

async function startWithHost({ app, env, appArgs, timeoutMs, hostEntry }) {
  const port = await freePort();
  openApp(app, { env, appArgs: [`--inspect-brk=127.0.0.1:${port}`, ...appArgs] });

  let target;
  try {
    target = await waitFor("T3's inspector", async () => (await targets(port))[0], { timeoutMs });
  } catch (error) {
    return failed(
      "no-inspector",
      runningPid(app),
      `${app} did not open its inspector on 127.0.0.1:${port} (${error.message}). Extensions were not loaded. ` +
        "If T3 Code is open but blank, it is waiting for a debugger: quit it and launch again.",
    );
  }

  let outcome;
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Debugger.enable");
    await cdp.send("Runtime.runIfWaitingForDebugger");
    const paused = await cdp.event("Debugger.paused", timeoutMs);
    outcome = evaluated(
      await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: paused.callFrames[0].callFrameId, expression: hostExpression(hostEntry), returnByValue: true }),
    );
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    await cdp.send("Debugger.resume").catch(() => {});
    cdp.close();
  }
  const pid = runningPid(app);
  if (outcome.error) return failed("inject-failed", pid, `${app} (pid ${pid}) continues without extensions; loading the host failed: ${outcome.error}`);
  if (!(await inspectorClosed(port))) return failed("inspector-open", pid, `Started ${app} (pid ${pid}) with the extension host, but its inspector on 127.0.0.1:${port} is still open.`);
  return { kind: "started", pid, port };
}

async function attachHost({ app, hostEntry }, pid) {
  if (!(await portFree(SIGNAL_PORT))) {
    return failed(
      "port-busy",
      pid,
      `Port ${SIGNAL_PORT} on 127.0.0.1 is in use${portOwner(SIGNAL_PORT)}. A running T3 opens its inspector on that port only, ` +
        `so the extension host was not loaded. ${app} (pid ${pid}) keeps running. Free the port and try again.`,
    );
  }
  process.kill(pid, "SIGUSR1");
  let target;
  try {
    target = await waitFor("the inspector", async () => (await targets(SIGNAL_PORT))[0], { timeoutMs: INSPECTOR_OPEN_MS, intervalMs: 100 });
  } catch {
    return failed(
      "no-inspector",
      pid,
      `${app} (pid ${pid}) did not open its inspector on 127.0.0.1:${SIGNAL_PORT} within ${INSPECTOR_OPEN_MS / 1000} s of SIGUSR1. ` +
        "The extension host was not loaded; T3 keeps running.",
    );
  }

  let outcome;
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    outcome = evaluated(
      await cdp.send("Runtime.evaluate", { expression: hostExpression(hostEntry, pid), includeCommandLineAPI: true, returnByValue: true }),
    );
  } catch (error) {
    outcome = { error: error.message };
  } finally {
    cdp.close();
  }
  if (outcome.error) return failed("inject-failed", pid, `Loading the extension host into ${app} (pid ${pid}) failed; T3 keeps running without it: ${outcome.error}`);
  if (!(await inspectorClosed(SIGNAL_PORT))) {
    return failed("inspector-open", pid, `Loaded the extension host into ${app} (pid ${pid}), but its inspector on 127.0.0.1:${SIGNAL_PORT} is still open.`);
  }
  return { kind: "attached", pid, reloaded: outcome.value.reloaded };
}

async function untilReady({ app, timeoutMs }, pid) {
  try {
    await waitFor("T3 to finish starting", () => instance(app)?.pid !== pid || instance(app).ready, { timeoutMs, intervalMs: 250 });
    return null;
  } catch {
    return failed(
      "not-ready",
      pid,
      `${app} (pid ${pid}) has not finished starting after ${timeoutMs} ms. If it shows no window, it is waiting for a debugger: quit it and launch again.`,
    );
  }
}

// Each handler returns a final result, or null to observe the instance again.
const STEPS = {
  launch: {
    stopped: (context) => startWithHost(context),
    starting: (context, { pid }) => untilReady(context, pid),
    bare: (context, { pid }) => attachHost(context, pid),
    hosted: (_context, { pid }) => ({ kind: "already-hosted", pid }),
  },
  attach: {
    stopped: () => ({ kind: "not-running" }),
    starting: (context, { pid }) => untilReady(context, pid),
    bare: (context, { pid }) => attachHost(context, pid),
    hosted: (_context, { pid }) => ({ kind: "already-hosted", pid }),
  },
};

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One launch or attach per app at a time. Otherwise two launchers both see "stopped" (or "bare"),
// and the second waits for an inspector that never opens. The lock file holds the owner's pid;
// it is linked into place whole, so a reader never sees it half written.
async function acquireLaunchLock(app, timeoutMs) {
  const id = crypto.createHash("sha256").update(fs.realpathSync(app)).digest("hex").slice(0, 16);
  const lock = path.join(userTempDir(), `t3ext-launch-${id}.lock`);
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

// Result: { kind: "started", pid, port } | { kind: "attached", pid, reloaded }
//       | { kind: "already-hosted", pid } | { kind: "not-running" }
//       | { kind: "failed", reason, pid, message }
// reason: fuse-off | port-busy | no-inspector | inject-failed | inspector-open | not-ready
async function run({ app, mode, waitMs = 0, timeoutMs = 20_000, env = {}, appArgs = [], hostEntry = HOST_ENTRY }) {
  const inspectFuse = readFuses(app).fuses.EnableNodeCliInspectArguments;
  if (inspectFuse !== "on") {
    if (mode === "launch") openApp(app, { env, appArgs });
    return failed(
      "fuse-off",
      runningPid(app),
      `${app} has its EnableNodeCliInspectArguments Electron fuse ${inspectFuse}, so neither --inspect-brk nor SIGUSR1 can open its inspector. ` +
        "t3ext cannot load extensions into this build; T3 runs normally without them.",
    );
  }
  // Waiting for T3 to appear holds no lock, so a T3 Code+ launch meanwhile is never blocked.
  if (waitMs > 0) await waitFor("T3 to start", () => runningPid(app), { timeoutMs: waitMs, intervalMs: 500 }).catch(() => {});

  const release = await acquireLaunchLock(app, timeoutMs * 3);
  let result;
  try {
    const context = { app, env, appArgs, timeoutMs, hostEntry };
    while (!result) {
      const observed = await observe(app);
      result = await STEPS[mode][observed.state](context, observed);
    }
  } finally {
    release();
  }
  if (mode === "launch" && runningPid(app)) openApp(app);
  return result;
}

module.exports = { run, observe, runningPid, plistValue, HOST_ENTRY, SIGNAL_PORT };
