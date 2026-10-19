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

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-registry-"));
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

test("lists the builtin manager first, then user extensions; skips dotfiles and plain files", () => {
  const { registry } = setup();
  const list = registry.list();
  assert.deepEqual(list.map((e) => e.id), ["builtin:extension-manager", "alpha", "broken", "linked"]);
  assert.equal(list[0].builtin, true);
  assert.deepEqual(list[1].manifest, { name: "Alpha", version: "1.0.0", description: "first" });
  assert.deepEqual(list[1].parts, { main: false, renderer: true, style: true });
  assert.equal(list[3].parts.main, true, "symlinked folder is scanned through the link");
  assert.equal(list.every((e) => e.enabled), true, "everything is enabled without a state file");
});

test("an invalid manifest is listed with an error and no manifest", () => {
  const { registry } = setup();
  const broken = registry.get("broken");
  assert.equal(broken.manifest, null);
  assert.match(broken.error, /not valid JSON/);
});

test("setEnabled persists to extensions.json", () => {
  const { registry, home } = setup();
  registry.setEnabled("alpha", false);
  registry.setEnabled("builtin:extension-manager", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))), { disabled: ["alpha", "builtin:extension-manager"] });
  assert.equal(createRegistry({ home, builtinDir: BUILTIN_DIR }).get("alpha").enabled, false, "state read back by a new registry");
  registry.setEnabled("alpha", true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))).disabled, ["builtin:extension-manager"]);
  assert.throws(() => registry.setEnabled("nope", false), /No extension with id "nope"/);
});

test("add copies a valid folder and refuses duplicates and non-extensions", () => {
  const { registry, root, extensions } = setup();
  writeExtension(path.join(root, "incoming", "beta"), { "manifest.json": JSON.stringify({ name: "Beta" }), "style.css": "a{}" });
  const added = registry.add(path.join(root, "incoming", "beta"));
  assert.equal(added.id, "beta");
  assert.equal(fs.readFileSync(path.join(extensions, "beta", "style.css"), "utf8"), "a{}");
  assert.equal(fs.lstatSync(path.join(extensions, "beta")).isSymbolicLink(), false, "copied, not linked");
  assert.throws(() => registry.add(path.join(root, "incoming", "beta")), /already exists/);
  fs.mkdirSync(path.join(root, "incoming", "empty"));
  assert.throws(() => registry.add(path.join(root, "incoming", "empty")), /manifest.json is missing/);
});

test("forget clears disabled state and runtime errors", () => {
  const { registry, home } = setup();
  registry.setEnabled("alpha", false);
  registry.recordError("alpha", "main.js: boom");
  assert.equal(registry.get("alpha").error, "main.js: boom");
  registry.forget("alpha");
  assert.equal(registry.get("alpha").error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"))).disabled, []);
});

test("a part counts only when it is a regular file, following symlinks; anything else is an error", () => {
  const { registry, root, extensions } = setup();
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
