"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { SENTINEL, frameworkBinary } = require("../src/fuses.cjs");
const { run, runningPid } = require("../src/launcher.cjs");
const { killUnder, waitFor } = require("./harness.cjs");

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const PRESENCE = require.resolve("../host/presence.cjs");
const { socketPath } = require(PRESENCE);

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
