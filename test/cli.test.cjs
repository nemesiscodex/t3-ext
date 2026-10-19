"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const CLI = path.join(__dirname, "..", "bin", "t3ext.cjs");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

function fixtureApp() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-cli-")));
  const app = path.join(root, "Fixture's App.app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIconFile</key><string>icon.icns</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
  );
  fs.writeFileSync(path.join(app, "Contents", "Resources", "icon.icns"), "icns");
  return { root, app };
}

test("install-launcher --dry-run prints the bundle without writing it", () => {
  const { root, app } = fixtureApp();
  const result = run("install-launcher", "--dry-run", "--app", app, "--dest", root);
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(root, "T3 Code+.app");
  assert.match(result.stdout, new RegExp(`Would create ${bundle.replace(/[.+]/g, "\\$&")}`));
  assert.match(result.stdout, /copied from .*icon\.icns/);
  assert.match(result.stdout, /ELECTRON_RUN_AS_NODE=1 "\$EXE" "\$CLI" launch --app "\$APP"/);
  assert.equal(fs.existsSync(bundle), false, "dry run writes nothing");
});

test("install-launcher builds a valid ad-hoc signed app that quotes odd paths", () => {
  const { root, app } = fixtureApp();
  const result = run("install-launcher", "--app", app, "--dest", root);
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(root, "T3 Code+.app");
  execFileSync("codesign", ["--verify", "--strict", bundle]);
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Contents", "Info.plist")], { encoding: "utf8" }));
  assert.equal(info.CFBundleExecutable, "t3code-plus");
  assert.equal(info.CFBundleIconFile, "icon.icns");
  assert.equal(info.LSUIElement, true);
  const script = path.join(bundle, "Contents", "MacOS", "t3code-plus");
  assert.ok(fs.statSync(script).mode & 0o111, "launcher script is executable");
  execFileSync("sh", ["-n", script]);
  const resolved = execFileSync("sh", ["-c", `eval "$(sed -n '/^DEFAULT_APP=/,/^APP=/p' "$1")"; printf %s "$APP"`, "sh", script], { encoding: "utf8" });
  assert.equal(resolved, app, "baked app path survives shell quoting");
  assert.equal(fs.readFileSync(path.join(bundle, "Contents", "Resources", "icon.icns"), "utf8"), "icns", "icon copied from the app");
});

test("bad arguments exit 2 with usage; a missing app exits 1", () => {
  assert.equal(run("frobnicate").status, 2);
  assert.equal(run("launch", "--env", "NOEQUALS").status, 2);
  const missing = run("launch", "--app", "/nonexistent/X.app");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not an app bundle/);
});
