"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const asar = require("../src/asar.cjs");
const patcher = require("../src/patcher.cjs");

const ORIGINAL_FILES = new Map([
  ["package.json", Buffer.from(JSON.stringify({ name: "fixture", main: "apps/desktop/boot.cjs" }))],
  ["apps/desktop/boot.cjs", Buffer.from('require("./main.cjs");\n')],
  ["apps/desktop/main.cjs", crypto.randomBytes(300_000)],
  ["empty.txt", Buffer.alloc(0)],
]);

function fixtureApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-test-"));
  const app = path.join(root, "Fixture.app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  const archive = path.join(app, "Contents", "Resources", "app.asar");
  asar.create(archive, ORIGINAL_FILES);
  const shimDir = path.join(root, "shim");
  fs.cpSync(patcher.SHIM_DIR, shimDir, { recursive: true });
  return { app, archive, shimDir, backup: `${archive}.t3ext-backup`, original: fs.readFileSync(archive) };
}

const fileHash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function assertOriginalEntriesIntact(archive) {
  for (const [rel, data] of ORIGINAL_FILES) {
    if (rel === "package.json") continue;
    assert.deepEqual(asar.readFile(archive, rel), data, `${rel} bytes unchanged after patch`);
  }
}

function assertShimMatches(archive, shimDir) {
  for (const [rel, data] of patcher.shimFiles(shimDir)) {
    assert.deepEqual(asar.readFile(archive, `t3ext/${rel}`), data, `t3ext/${rel} matches shim/${rel}`);
  }
}

test("patch adds the shim, swaps main, and keeps every original file", () => {
  const f = fixtureApp();
  assert.equal(patcher.patch(f.app, { shimDir: f.shimDir }).action, "patched");

  assertOriginalEntriesIntact(f.archive);
  assertShimMatches(f.archive, f.shimDir);
  const pkg = JSON.parse(asar.readFile(f.archive, "package.json"));
  assert.equal(pkg.main, "t3ext/boot.cjs", "package.json main points at the shim");
  assert.equal(pkg.t3extOriginalMain, "apps/desktop/boot.cjs", "original main recorded");
  assert.equal(pkg.name, "fixture", "other package.json fields kept");
  assert.equal(JSON.parse(asar.readFile(f.archive, "t3ext/patch.json")).originalMain, "apps/desktop/boot.cjs");
  assert.deepEqual(fs.readFileSync(f.backup), f.original, "backup is byte-identical to the original");

  const { header, dataOffset } = asar.readHeader(f.archive);
  const originalDataLength = f.original.length - asar.readHeader(f.backup).dataOffset;
  assert.deepEqual(
    fs.readFileSync(f.archive).subarray(dataOffset, dataOffset + originalDataLength),
    f.original.subarray(asar.readHeader(f.backup).dataOffset),
    "original data section copied verbatim",
  );
  assert.ok(asar.findEntry(header, "t3ext/boot.cjs").integrity.hash, "new entries carry integrity");
});

test("patching twice is a no-op", () => {
  const f = fixtureApp();
  patcher.patch(f.app, { shimDir: f.shimDir });
  const before = fileHash(f.archive);
  assert.equal(patcher.patch(f.app, { shimDir: f.shimDir }).action, "already-patched");
  assert.equal(fileHash(f.archive), before, "archive unchanged by second patch");
});

test("a changed shim is rebuilt from the backup, not stacked on the old patch", () => {
  const f = fixtureApp();
  patcher.patch(f.app, { shimDir: f.shimDir });
  fs.appendFileSync(path.join(f.shimDir, "host.cjs"), "\n// changed\n");

  assert.equal(patcher.patch(f.app, { shimDir: f.shimDir }).action, "repatched");
  assertOriginalEntriesIntact(f.archive);
  assertShimMatches(f.archive, f.shimDir);

  const fresh = fixtureApp();
  fs.cpSync(f.shimDir, fresh.shimDir, { recursive: true });
  patcher.patch(fresh.app, { shimDir: fresh.shimDir });
  assert.equal(fs.statSync(f.archive).size, fs.statSync(fresh.archive).size, "repatched archive is the same size as a fresh patch");
});

test("unpatch restores the original bytes", () => {
  const f = fixtureApp();
  patcher.patch(f.app, { shimDir: f.shimDir });
  assert.equal(patcher.unpatch(f.app).action, "unpatched");
  assert.deepEqual(fs.readFileSync(f.archive), f.original, "app.asar byte-identical to the original");
  assert.equal(fs.existsSync(f.backup), false, "backup consumed");
  assert.equal(patcher.unpatch(f.app).action, "not-patched", "second unpatch is a no-op");
});

test("an outdated patch without a clean backup fails with a clear message", () => {
  const f = fixtureApp();
  patcher.patch(f.app, { shimDir: f.shimDir });
  fs.rmSync(f.backup);
  fs.appendFileSync(path.join(f.shimDir, "host.cjs"), "\n// changed\n");
  assert.throws(() => patcher.patch(f.app, { shimDir: f.shimDir }), /app\.asar\.t3ext-backup is missing/);
  assert.throws(() => patcher.unpatch(f.app), /Cannot unpatch: .*missing/);
});

test("a write denied by macOS explains App Management", () => {
  const f = fixtureApp();
  const resources = path.dirname(f.archive);
  fs.chmodSync(resources, 0o555);
  try {
    assert.throws(() => patcher.patch(f.app, { shimDir: f.shimDir }), /App Management/);
  } finally {
    fs.chmodSync(resources, 0o755);
  }
});
