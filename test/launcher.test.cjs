"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { launch, runningPid } = require("../src/launcher.cjs");
const { killUnder, waitFor } = require("./harness.cjs");

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// A stand-in for T3 Code that LaunchServices can start: a clone of this Node binary that
// honours --inspect-brk and stays running, so nothing outside the temp dir is launched.
function fakeApp() {
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
  fs.writeFileSync(path.join(root, "host.cjs"), "exports.start = () => {};\n");
  return { root, app, hostEntry: path.join(root, "host.cjs") };
}

function cleanup(root, app) {
  return async () => {
    assert.deepEqual(await killUnder(root), [], "no fake app process left behind");
    execFileSync(LSREGISTER, ["-u", app]);
    fs.rmSync(root, { recursive: true, force: true });
  };
}

test("two concurrent launches start one instance; the second activates it", async () => {
  const { root, app, hostEntry } = fakeApp();
  try {
    const results = await Promise.all([launch({ app, hostEntry, timeoutMs: 5000 }), launch({ app, hostEntry, timeoutMs: 5000 })]);
    const kinds = results.map((result) => result.kind).sort();
    assert.deepEqual(kinds, ["activated", "injected"], JSON.stringify(results));
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
    const script = `require(${JSON.stringify(require.resolve("../src/launcher.cjs"))}).launch({ app: ${JSON.stringify(app)}, hostEntry: ${JSON.stringify(stuckHost)}, timeoutMs: 5000 })`;
    const crashed = spawn(path.join(app, "Contents", "MacOS", "node"), ["-e", script], { stdio: "ignore" });
    await waitFor("the first launcher to start the app", () => runningPid(app), { timeoutMs: 10_000 });
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));

    const started = Date.now();
    const result = await launch({ app, timeoutMs: 2000 });
    assert.equal(result.kind, "activated", JSON.stringify(result));
    assert.ok(Date.now() - started < 2000, "did not wait out the dead launcher's lock");
  } finally {
    await cleanup(root, app)();
  }
});
