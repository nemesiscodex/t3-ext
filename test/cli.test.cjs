"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const asar = require("../src/asar.cjs");

const CLI = path.join(__dirname, "..", "bin", "t3ext.cjs");

function fixtureApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-cli-"));
  const app = path.join(root, "Fixture App.app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  asar.create(path.join(app, "Contents", "Resources", "app.asar"), new Map([["package.json", Buffer.from('{"main":"main.js"}')], ["main.js", Buffer.from("")]]));
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>',
  );
  return app;
}

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("patch, patch again, status, unpatch report each state", () => {
  const app = fixtureApp();
  assert.match(run("patch", "--app", app).stdout, /^Patched\./);
  assert.match(run("patch", "--app", app).stdout, /^Already patched/);
  const status = run("status", "--app", app).stdout;
  assert.match(status, /version +9\.9\.9/);
  assert.match(status, /patched +yes/);
  assert.match(status, /shim +current/);
  assert.match(status, /backup +present \(unpatched\)/);
  assert.match(run("unpatch", "--app", app).stdout, /^Restored the original app\.asar/);
  assert.match(run("status", "--app", app).stdout, /patched +no/);
});

test("install-agent --dry-run prints a valid plist that repatches on Info.plist changes", () => {
  const app = fixtureApp();
  const result = run("install-agent", "--dry-run", "--app", app);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], { input: result.stdout, encoding: "utf8" }));
  assert.equal(json.Label, "dev.t3ext.repatch");
  assert.deepEqual(json.ProgramArguments, [process.execPath, CLI, "patch", "--app", app]);
  assert.ok(path.isAbsolute(json.ProgramArguments[0]) && path.isAbsolute(json.ProgramArguments[1]), "absolute node and CLI paths");
  assert.deepEqual(json.WatchPaths, [path.join(app, "Contents", "Info.plist")]);
  assert.equal(json.RunAtLoad, true);
  assert.equal(json.StandardOutPath, path.join(os.homedir(), "Library", "Logs", "t3ext.log"));
  assert.equal(json.StandardErrorPath, json.StandardOutPath);
});

test("bad arguments exit 2 with usage; a missing app exits 1", () => {
  assert.equal(run("frobnicate").status, 2);
  const missing = run("status", "--app", "/nonexistent/X.app");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /has no Contents\/Resources\/app\.asar/);
});
