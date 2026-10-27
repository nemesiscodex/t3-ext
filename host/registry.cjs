"use strict";

// Owns the extension list, the enabled/disabled state and each extension's config. Pure Node; no Electron.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BUILTIN_PREFIX = "builtin:";
const PARTS = { main: "main.js", renderer: "renderer.js", style: "style.css" };

function t3Home(env = process.env) {
  return env.T3CODE_HOME?.trim() || path.join(os.homedir(), ".t3");
}

function parseManifest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { manifest: null, error: `manifest.json is not valid JSON: ${error.message}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { manifest: null, error: "manifest.json must be a JSON object" };
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    return { manifest: null, error: 'manifest.json needs a non-empty "name" string' };
  }
  for (const key of ["version", "description"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return { manifest: null, error: `manifest.json "${key}" must be a string` };
    }
  }
  const manifest = { name: value.name };
  if (value.version !== undefined) manifest.version = value.version;
  if (value.description !== undefined) manifest.description = value.description;
  return { manifest, error: null };
}

function readManifest(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  } catch (error) {
    return { manifest: null, error: error.code === "ENOENT" ? "manifest.json is missing" : error.message };
  }
  return parseManifest(raw);
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function parseState(raw) {
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch {}
  const disabled = Array.isArray(value?.disabled) ? value.disabled.filter((id) => typeof id === "string") : [];
  return { disabled: [...new Set(disabled)], config: isPlainObject(value?.config) ? value.config : {} };
}

function createRegistry({ home = t3Home(), builtinDir }) {
  const extensionsDir = path.join(home, "extensions");
  const stateFile = path.join(home, "extensions.json");
  const runtimeErrors = new Map();

  function readState() {
    let raw = "";
    try {
      raw = fs.readFileSync(stateFile, "utf8");
    } catch {}
    return parseState(raw);
  }

  function writeState(state) {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, stateFile);
  }

  function describe(id, dir, builtin, disabled) {
    const { manifest, error } = readManifest(dir);
    const errors = [error];
    const parts = {};
    for (const [part, name] of Object.entries(PARTS)) {
      const file = path.join(dir, name);
      parts[part] = isFile(file);
      if (!parts[part] && (fs.existsSync(file) || isSymlink(file))) errors.push(`${name} is not a file`);
    }
    errors.push(...(runtimeErrors.get(id)?.values() ?? []));
    return {
      id,
      dir,
      builtin,
      manifest,
      enabled: !disabled.includes(id),
      parts,
      error: errors.filter(Boolean).join("\n") || null,
    };
  }

  function userIds() {
    let entries;
    try {
      entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(extensionsDir, entry.name))))
      .map((entry) => entry.name)
      .sort();
  }

  function list() {
    const { disabled } = readState();
    const builtins = builtinDir ? listDirs(builtinDir) : [];
    return [
      ...builtins.map((name) => describe(BUILTIN_PREFIX + name, path.join(builtinDir, name), true, disabled)),
      ...userIds().map((id) => describe(id, path.join(extensionsDir, id), false, disabled)),
    ];
  }

  function get(id) {
    const extension = list().find((candidate) => candidate.id === id);
    if (!extension) throw new Error(`No extension with id "${id}"`);
    return extension;
  }

  function setEnabled(id, enabled) {
    get(id);
    const state = readState();
    const disabled = state.disabled.filter((other) => other !== id);
    if (!enabled) disabled.push(id);
    writeState({ ...state, disabled });
    return get(id);
  }

  function getConfig(id) {
    return readState().config[id] ?? null;
  }

  // Stores what JSON keeps of `value`, so every window reads back the same thing. null removes it.
  function setConfig(id, value) {
    get(id);
    const json = JSON.stringify(value);
    const stored = json === undefined ? null : JSON.parse(json);
    const state = readState();
    const config = { ...state.config };
    if (stored === null) delete config[id];
    else config[id] = stored;
    writeState({ ...state, config });
    return stored;
  }

  // The caller removes the folder (Electron moves it to the Trash); this drops its state.
  function forget(id) {
    runtimeErrors.delete(id);
    const state = readState();
    if (!state.disabled.includes(id) && !Object.hasOwn(state.config, id)) return;
    const { [id]: _forgotten, ...config } = state.config;
    writeState({ disabled: state.disabled.filter((other) => other !== id), config });
  }

  function add(sourceDir) {
    const { error } = readManifest(sourceDir);
    if (error) throw new Error(`${sourceDir} is not an extension: ${error}`);
    const id = path.basename(path.resolve(sourceDir));
    if (id.startsWith(".")) throw new Error(`Extension folder names cannot start with "." (${id})`);
    const dest = path.join(extensionsDir, id);
    if (fs.existsSync(dest) || isSymlink(dest)) throw new Error(`An extension named "${id}" already exists`);
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.cpSync(sourceDir, dest, { recursive: true });
    return get(id);
  }

  // One error per file, so a part that later loads cleanly clears only its own error.
  function recordError(id, file, error) {
    const errors = runtimeErrors.get(id) ?? new Map();
    if (error) errors.set(file, `${file}: ${error}`);
    else errors.delete(file);
    runtimeErrors.set(id, errors);
  }

  return { extensionsDir, stateFile, list, get, setEnabled, getConfig, setConfig, forget, add, recordError };
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

module.exports = { createRegistry, parseManifest, t3Home, PARTS };
