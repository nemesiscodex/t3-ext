"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createRegistry } = require("../host/registry.cjs");

const BUILTIN_DIR = path.join(__dirname, "..", "host", "builtin");

function writeExtension(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const extensions = path.join(home, "extensions");
  writeExtension(path.join(extensions, "alpha"), {
    "manifest.json": JSON.stringify({ name: "Alpha", version: "1.0.0", description: "first" }),
    "renderer.js": "",
    "style.css": "",
  });
  writeExtension(path.join(extensions, "broken"), { "manifest.json": "{ not json" });
  writeExtension(path.join(root, "src", "linked"), { "manifest.json": JSON.stringify({ name: "Linked" }), "main.js": "" });
  fs.symlinkSync(path.join(root, "src", "linked"), path.join(extensions, "linked"));
  fs.mkdirSync(path.join(extensions, ".hidden"));
  fs.writeFileSync(path.join(extensions, "notes.txt"), "");
  return { root, home, extensions, registry: createRegistry({ home, builtinDir: BUILTIN_DIR }) };
}

test("lists the builtin manager first, then user extensions; skips dotfiles and plain files", (t) => {
  const { registry } = setup(t);
  const list = registry.list();
  assert.deepEqual(list.map((e) => e.id), ["builtin:extension-manager", "alpha", "broken", "linked"]);
  assert.equal(list[0].builtin, true);
  assert.deepEqual(list[1].manifest, { name: "Alpha", version: "1.0.0", description: "first" });
  assert.deepEqual(list[1].parts, { main: false, renderer: true, style: true });
  assert.equal(list[3].parts.main, true, "symlinked folder is scanned through the link");
  assert.equal(list.every((e) => e.enabled), true, "everything is enabled without a state file");
});

test("an invalid manifest is listed with an error and no manifest", (t) => {
  const { registry } = setup(t);
  const broken = registry.get("broken");
  assert.equal(broken.manifest, null);
  assert.match(broken.error, /not valid JSON/);
});

test("setEnabled persists to extensions.json", (t) => {
  const { registry, home } = setup(t);
  registry.setEnabled("alpha", false);
  registry.setEnabled("builtin:extension-manager", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))), { disabled: ["alpha", "builtin:extension-manager"], config: {} });
  assert.equal(createRegistry({ home, builtinDir: BUILTIN_DIR }).get("alpha").enabled, false, "state read back by a new registry");
  registry.setEnabled("alpha", true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))).disabled, ["builtin:extension-manager"]);
  assert.throws(() => registry.setEnabled("nope", false), /No extension with id "nope"/);
});

test("add copies a valid folder and refuses duplicates and non-extensions", (t) => {
  const { registry, root, extensions } = setup(t);
  writeExtension(path.join(root, "incoming", "beta"), { "manifest.json": JSON.stringify({ name: "Beta" }), "style.css": "a{}" });
  const added = registry.add(path.join(root, "incoming", "beta"));
  assert.equal(added.id, "beta");
  assert.equal(fs.readFileSync(path.join(extensions, "beta", "style.css"), "utf8"), "a{}");
  assert.equal(fs.lstatSync(path.join(extensions, "beta")).isSymbolicLink(), false, "copied, not linked");
  assert.throws(() => registry.add(path.join(root, "incoming", "beta")), /already exists/);
  fs.mkdirSync(path.join(root, "incoming", "empty"));
  assert.throws(() => registry.add(path.join(root, "incoming", "empty")), /manifest.json is missing/);
});

test("runtime errors are kept per file, and a cleared file drops only its own error", (t) => {
  const { registry } = setup(t);
  registry.recordError("alpha", "main.js", "boom");
  registry.recordError("alpha", "renderer.js", "EACCES");
  assert.equal(registry.get("alpha").error, "main.js: boom\nrenderer.js: EACCES");
  registry.recordError("alpha", "renderer.js", null);
  assert.equal(registry.get("alpha").error, "main.js: boom");
});

test("forget clears disabled state and runtime errors", (t) => {
  const { registry, home } = setup(t);
  registry.setEnabled("alpha", false);
  registry.recordError("alpha", "main.js", "boom");
  assert.equal(registry.get("alpha").error, "main.js: boom");
  registry.forget("alpha");
  assert.equal(registry.get("alpha").error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))).disabled, []);
});

test("config persists per extension as JSON, and setEnabled keeps it", (t) => {
  const { registry, home } = setup(t);
  const stateFile = path.join(home, "extensions.json");
  assert.equal(registry.getConfig("alpha"), null, "nothing stored yet");
  const value = { profiles: [{ id: "a", at: new Date(0) }], skip: undefined, fn() {} };
  assert.deepEqual(registry.setConfig("alpha", value), { profiles: [{ id: "a", at: "1970-01-01T00:00:00.000Z" }] }, "returns the JSON round trip");
  registry.setConfig("linked", 3);
  registry.setEnabled("alpha", false);
  const reread = createRegistry({ home, builtinDir: BUILTIN_DIR });
  assert.deepEqual(reread.getConfig("alpha"), { profiles: [{ id: "a", at: "1970-01-01T00:00:00.000Z" }] }, "survives setEnabled and a new registry");
  assert.equal(reread.getConfig("linked"), 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).disabled, ["alpha"]);
  assert.equal(registry.setConfig("linked", null), null);
  assert.equal(registry.setConfig("alpha", undefined), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).config, {}, "null and undefined delete the entry");
  assert.throws(() => registry.setConfig("nope", {}), /No extension with id "nope"/);
  assert.equal(registry.getConfig("nope"), null);
});

test("forget drops the extension's config and leaves the others", (t) => {
  const { registry, home } = setup(t);
  registry.setConfig("alpha", { a: 1 });
  registry.setConfig("linked", { b: 2 });
  registry.forget("alpha");
  assert.equal(registry.getConfig("alpha"), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))).config, { linked: { b: 2 } });
});

test("a state file that is not JSON, or has a config that is not an object, reads as no config", (t) => {
  const { registry, home } = setup(t);
  const stateFile = path.join(home, "extensions.json");
  for (const raw of ["{ not json", '{"disabled":["alpha"],"config":[1,2]}', '{"config":"x"}', '{"config":null}', "null", "[]"]) {
    fs.writeFileSync(stateFile, raw);
    assert.equal(registry.getConfig("alpha"), null, raw);
    registry.setConfig("linked", { ok: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).config, { linked: { ok: true } }, raw);
  }
});

test("a part counts only when it is a regular file, following symlinks; anything else is an error", (t) => {
  const { registry, root, extensions } = setup(t);
  const dir = path.join(extensions, "odd");
  writeExtension(dir, { "manifest.json": JSON.stringify({ name: "Odd" }) });
  fs.mkdirSync(path.join(dir, "renderer.js"));
  writeExtension(path.join(root, "shared"), { "style.css": "a{}" });
  fs.symlinkSync(path.join(root, "shared", "style.css"), path.join(dir, "style.css"));
  fs.symlinkSync(path.join(root, "nowhere.js"), path.join(dir, "main.js"));
  const odd = registry.get("odd");
  assert.deepEqual(odd.parts, { main: false, renderer: false, style: true });
  assert.equal(odd.error, "main.js is not a file\nrenderer.js is not a file");
  assert.equal(registry.get("alpha").error, null, "regular files report no error");
});
