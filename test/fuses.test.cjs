"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { readFuses, frameworkBinary, SENTINEL } = require("../src/fuses.cjs");

const SOURCE_APP = process.env.T3EXT_E2E_APP ?? "/Applications/T3 Code (Nightly).app";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-fuses-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function syntheticApp(t, parts) {
  const app = path.join(tempDir(t), "Synthetic.app");
  fs.mkdirSync(path.dirname(frameworkBinary(app)), { recursive: true });
  fs.writeFileSync(frameworkBinary(app), Buffer.concat(parts));
  return app;
}

const wire = (fuses) => Buffer.concat([SENTINEL, Buffer.from([1, fuses.length]), Buffer.from(fuses, "latin1")]);

test("reads the wire of the real app's Electron Framework (on an APFS clone)", { skip: !fs.existsSync(SOURCE_APP) && "no T3 Code installed" }, (t) => {
  const app = path.join(tempDir(t), path.basename(SOURCE_APP));
  execFileSync("cp", ["-c", "-R", SOURCE_APP, app]);
  const { version, wires, fuses } = readFuses(app);
  assert.equal(version, 1);
  assert.equal(wires, 1);
  assert.equal(fuses.EnableNodeCliInspectArguments, "on", "t3ext depends on this fuse");
  assert.equal(fuses.RunAsNode, "on", "the launcher runs on T3's binary with ELECTRON_RUN_AS_NODE");
  assert.ok(Object.values(fuses).every((value) => value === "on" || value === "off"), JSON.stringify(fuses));
});

test("finds a wire that straddles the 8 MiB read boundary and names each fuse", (t) => {
  const offset = (8 << 20) - 10;
  const app = syntheticApp(t, [Buffer.alloc(offset, 0x41), wire("100r1"), Buffer.alloc(1000, 0x42)]);
  assert.deepEqual(readFuses(app), {
    version: 1,
    wires: 1,
    fuses: {
      RunAsNode: "on",
      EnableCookieEncryption: "off",
      EnableNodeOptionsEnvironmentVariable: "off",
      EnableNodeCliInspectArguments: "removed",
      EnableEmbeddedAsarIntegrityValidation: "on",
    },
  });
});

test("a universal binary whose wires disagree reads 'mixed' for that fuse", (t) => {
  const app = syntheticApp(t, [Buffer.alloc(100), wire("1101"), Buffer.alloc(100), wire("1100")]);
  const { wires, fuses } = readFuses(app);
  assert.equal(wires, 2);
  assert.equal(fuses.RunAsNode, "on");
  assert.equal(fuses.EnableNodeCliInspectArguments, "mixed");
});

test("a binary without a fuse wire, or with an unknown wire version, is an error", (t) => {
  assert.throws(() => readFuses(syntheticApp(t, [Buffer.alloc(4096)])), /No Electron fuse wire/);
  const v2 = Buffer.concat([SENTINEL, Buffer.from([2, 1]), Buffer.from("1")]);
  assert.throws(() => readFuses(syntheticApp(t, [v2])), /Unknown fuse wire version 2/);
});
