"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { SENTINEL, frameworkBinary } = require("../src/fuses.cjs");
const { acquireLaunchLock, removeIfStillHeldBy, run, runningPid } = require("../src/launcher.cjs");
const { killUnder, waitFor } = require("./harness.cjs");

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const PRESENCE = require.resolve("../host/presence.cjs");
const { hostAnswers, socketPath, userTempDir } = require(PRESENCE);

function writeInspectFuse(app, bit) {
  fs.mkdirSync(path.dirname(frameworkBinary(app)), { recursive: true });
  fs.writeFileSync(frameworkBinary(app), Buffer.concat([SENTINEL, Buffer.from([1, 4]), Buffer.from(`100${bit}`)]));
}

// A stand-in for T3 Code that LaunchServices can start: a clone of this Node binary that
// honours --inspect-brk and stays running, so nothing outside the temp dir is launched.
// It never checks in with LaunchServices, so it never leaves the "starting" state.
function fakeApp({ inspectFuse = "1" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-launcher-")));
  const app = path.join(root, "Fake T3.app");
  const macos = path.join(app, "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.t3ext.test.${crypto.randomUUID()}</string>
<key>CFBundleExecutable</key><string>fake</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
  );
  execFileSync("cp", ["-c", process.execPath, path.join(macos, "node")]);
  fs.writeFileSync(path.join(root, "app.js"), "setInterval(() => {}, 1000);\n");
  fs.writeFileSync(path.join(macos, "fake"), `#!/bin/sh\nexec "$(dirname "$0")/node" "$@" ${JSON.stringify(path.join(root, "app.js"))}\n`, { mode: 0o755 });
  writeInspectFuse(app, inspectFuse);
  fs.writeFileSync(
    path.join(root, "host.cjs"),
    `exports.start = () => { require(${JSON.stringify(PRESENCE)}).serve(); return { started: true, reloaded: 0 }; };\n`,
  );
  return { root, app, hostEntry: path.join(root, "host.cjs") };
}

// The fake host dies by SIGTERM, which skips its exit handler, so its socket file is removed here.
function cleanup(root, app) {
  return async () => {
    const pid = runningPid(app);
    if (pid) fs.rmSync(socketPath(pid), { force: true });
    assert.deepEqual(await killUnder(root), [], "no fake app process left behind");
    try {
      execFileSync(LSREGISTER, ["-u", app], { stdio: "ignore" });
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  };
}

const launch = (options) => run({ mode: "launch", ...options });

test("two concurrent launches start one instance; the second finds the host already loaded", async () => {
  const { root, app, hostEntry } = fakeApp();
  try {
    const results = await Promise.all([launch({ app, hostEntry, timeoutMs: 5000 }), launch({ app, hostEntry, timeoutMs: 5000 })]);
    const kinds = results.map((result) => result.kind).sort();
    assert.deepEqual(kinds, ["already-hosted", "started"], JSON.stringify(results));
    assert.equal(results[0].pid, results[1].pid, "both report the same running instance");
  } finally {
    await cleanup(root, app)();
  }
});

test("a launcher that died mid-launch does not block the next one", async () => {
  const { root, app } = fakeApp();
  try {
    const stuckHost = path.join(root, "stuck-host.cjs");
    fs.writeFileSync(stuckHost, "exports.start = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n");
    const script = `require(${JSON.stringify(require.resolve("../src/launcher.cjs"))}).run({ mode: "launch", app: ${JSON.stringify(app)}, hostEntry: ${JSON.stringify(stuckHost)}, timeoutMs: 5000 })`;
    const crashed = spawn(path.join(app, "Contents", "MacOS", "node"), ["-e", script], { stdio: "ignore" });
    await waitFor("the first launcher to start the app", () => runningPid(app), { timeoutMs: 10_000 });
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));

    const started = Date.now();
    const result = await launch({ app, timeoutMs: 2000 });
    assert.deepEqual([result.kind, result.reason], ["failed", "not-ready"], "the wedged instance is reported, not the lock");
    assert.match(result.message, /has not finished starting after 2000 ms/);
    assert.ok(Date.now() - started < 4000, `did not wait out the dead launcher's lock (6 s); took ${Date.now() - started} ms`);
  } finally {
    await cleanup(root, app)();
  }
});

test("attach on a stopped app does nothing; with --wait it waits, then still starts nothing", async () => {
  const { root, app, hostEntry } = fakeApp();
  try {
    assert.deepEqual(await run({ mode: "attach", app, hostEntry }), { kind: "not-running" });
    const started = Date.now();
    assert.deepEqual(await run({ mode: "attach", app, hostEntry, waitMs: 1500 }), { kind: "not-running" });
    assert.ok(Date.now() - started >= 1500, "waited for the app to start");
    assert.equal(runningPid(app), null, "attach never starts T3");
  } finally {
    await cleanup(root, app)();
  }
});

test("with the inspect fuse off, attach refuses before touching the app", async () => {
  const { root, app, hostEntry } = fakeApp({ inspectFuse: "0" });
  try {
    const result = await run({ mode: "attach", app, hostEntry });
    assert.deepEqual([result.kind, result.reason], ["failed", "fuse-off"]);
    assert.match(result.message, /EnableNodeCliInspectArguments Electron fuse off/);
    assert.equal(runningPid(app), null);
  } finally {
    await cleanup(root, app)();
  }
});

test("attach --wait reads the fuse after waiting, so a build that arrived meanwhile with it off is refused", async () => {
  const { root, app, hostEntry } = fakeApp();
  try {
    const pending = run({ mode: "attach", app, hostEntry, waitMs: 10_000, timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeInspectFuse(app, "0");
    execFileSync("open", ["-a", app]);
    const result = await pending;
    assert.deepEqual([result.kind, result.reason], ["failed", "fuse-off"], JSON.stringify(result));
    assert.equal(result.pid, runningPid(app), "refused the instance that started during the wait");
  } finally {
    await cleanup(root, app)();
  }
});

// The SIGUSR1 path, on a plain Node process standing in for a running T3. LaunchServices never
// sees it, so `find` reports it as a finished-launching instance of the fake app.
const SIGNAL_PORT = 9229;

function portIsFree() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(SIGNAL_PORT, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function runningT3(t) {
  const proc = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => proc.kill("SIGKILL"));
  await new Promise((resolve) => proc.stdout.once("data", resolve));
  return proc;
}

function host(root, body) {
  const file = path.join(root, `host-${crypto.randomUUID()}.cjs`);
  fs.writeFileSync(file, `const presence = require(${JSON.stringify(PRESENCE)});\n${body}\n`);
  return file;
}

const HOST = `exports.start = () => {
  if (globalThis.started) return { started: false, reloaded: 0 };
  globalThis.started = true;
  presence.serve();
  return { started: true, reloaded: 3 };
};`;

const signalTest = (name, fn) =>
  test(name, async (t) => {
    if (!(await portIsFree())) return t.skip("port 9229 is in use on this machine");
    const { root, app } = fakeApp();
    t.after(async () => {
      await cleanup(root, app)();
      await waitFor("port 9229 to be free", portIsFree, { timeoutMs: 10_000 });
    });
    await fn(t, { root, app });
  });

signalTest("attach loads the host into a running process over SIGUSR1, closes the inspector, and a second attach is a no-op", async (t, { root, app }) => {
  const proc = await runningT3(t);
  const find = () => ({ pid: proc.pid, ready: true });
  const hostEntry = host(root, HOST);
  t.after(() => fs.rmSync(socketPath(proc.pid), { force: true }));

  const first = await run({ mode: "attach", app, hostEntry, find });
  assert.deepEqual(first, { kind: "attached", pid: proc.pid, reloaded: 3 });
  assert.equal(await portIsFree(), true, "the inspector is closed again");
  assert.equal(await hostAnswers(proc.pid), true);
  assert.deepEqual(await run({ mode: "attach", app, hostEntry, find }), { kind: "already-hosted", pid: proc.pid });
});

signalTest("with port 9229 taken, attach names the holder, sends no signal, and leaves the process alone", async (t, { root, app }) => {
  const proc = await runningT3(t);
  const dummy = net.createServer();
  await new Promise((resolve) => dummy.listen(SIGNAL_PORT, "127.0.0.1", resolve));
  let result;
  try {
    result = await run({ mode: "attach", app, hostEntry: host(root, HOST), find: () => ({ pid: proc.pid, ready: true }) });
  } finally {
    await new Promise((resolve) => dummy.close(resolve));
  }
  assert.deepEqual([result.kind, result.reason], ["failed", "port-busy"]);
  assert.match(result.message, new RegExp(`in use by node \\(pid ${process.pid}\\)`));
  assert.equal(proc.exitCode, null, "still running");
  assert.equal(await hostAnswers(proc.pid), false);
});

signalTest("a process that quits between the check and the signal reads as stopped, not as a failure", async (t, { root, app }) => {
  const gone = await runningT3(t);
  await new Promise((resolve) => {
    gone.once("exit", resolve);
    gone.kill("SIGKILL");
  });
  let calls = 0;
  const find = () => (calls++ === 0 ? { pid: gone.pid, ready: true } : null);
  assert.deepEqual(await run({ mode: "attach", app, hostEntry: host(root, HOST), find }), { kind: "not-running" });
});

signalTest("a host that is already running but missed its presence check is reported as already loaded", async (t, { root, app }) => {
  const proc = await runningT3(t);
  const result = await run({ mode: "attach", app, hostEntry: host(root, "exports.start = () => ({ started: false, reloaded: 0 });"), find: () => ({ pid: proc.pid, ready: true }) });
  assert.deepEqual(result, { kind: "already-hosted", pid: proc.pid });
});

signalTest("a main thread that never answers times out, releases the lock, and still closes the inspector once it recovers", async (t, { root, app }) => {
  const proc = await runningT3(t);
  const find = () => ({ pid: proc.pid, ready: true });
  const stuck = host(root, "exports.start = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000); return { started: true, reloaded: 0 }; };");
  const started = Date.now();
  const result = await run({ mode: "attach", app, hostEntry: stuck, find, timeoutMs: 1500 });
  assert.deepEqual([result.kind, result.reason], ["failed", "inject-failed"], JSON.stringify(result));
  assert.match(result.message, /No answer to Runtime\.evaluate within 1500 ms/);
  assert.ok(Date.now() - started < 9000, `bounded by the timeout; took ${Date.now() - started} ms`);
  const notRunning = await run({ mode: "attach", app, hostEntry: stuck, find: () => null, timeoutMs: 1500 });
  assert.deepEqual(notRunning, { kind: "not-running" }, "the lock was released");
  await waitFor("the inspector to close after the main thread recovers", portIsFree, { timeoutMs: 10_000 });
  assert.equal(proc.exitCode, null, "still running");
});

signalTest("attach --wait keeps waiting through a quit and relaunch, and attaches to the second instance", async (t, { root, app }) => {
  const proc = await runningT3(t);
  t.after(() => fs.rmSync(socketPath(proc.pid), { force: true }));
  const begin = Date.now();
  const find = () => {
    const elapsed = Date.now() - begin;
    if (elapsed < 800) return { pid: 999_999, ready: false };
    if (elapsed < 1600) return null;
    return { pid: proc.pid, ready: true };
  };
  const result = await run({ mode: "attach", app, hostEntry: host(root, HOST), find, waitMs: 10_000 });
  assert.deepEqual(result, { kind: "attached", pid: proc.pid, reloaded: 3 });
});

signalTest("attach --wait retries while the bundle is being swapped", async (t, { root, app }) => {
  const proc = await runningT3(t);
  t.after(() => fs.rmSync(socketPath(proc.pid), { force: true }));
  const plist = path.join(app, "Contents", "Info.plist");
  fs.renameSync(plist, `${plist}.away`);
  setTimeout(() => fs.renameSync(`${plist}.away`, plist), 1500);
  const result = await run({ mode: "attach", app, hostEntry: host(root, HOST), find: () => ({ pid: proc.pid, ready: true }), waitMs: 10_000 });
  assert.deepEqual(result, { kind: "attached", pid: proc.pid, reloaded: 3 });
});

test("the lock is only ever removed by its owner or as a dead holder's", async (t) => {
  const { root, app } = fakeApp();
  t.after(cleanup(root, app));
  const release = await acquireLaunchLock(app, 1000);
  const lock = fs.readdirSync(userTempDir()).find((name) => /^t3ext-launch-[0-9a-f]+\.lock$/.test(name) && fs.readFileSync(path.join(userTempDir(), name), "utf8") === String(process.pid));
  const file = path.join(userTempDir(), lock);
  removeIfStillHeldBy(file, 999_999);
  assert.equal(fs.readFileSync(file, "utf8"), String(process.pid), "a cleaner that read an older, dead holder leaves a live lock in place");
  fs.writeFileSync(file, "1");
  release();
  assert.equal(fs.readFileSync(file, "utf8"), "1", "release leaves a lock it no longer owns");
  removeIfStillHeldBy(file, 1);
  assert.equal(fs.existsSync(file), false, "the matching holder's lock is removed");
});
