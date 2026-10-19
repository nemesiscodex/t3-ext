"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("./asar.cjs");

const SHIM_DIR = path.join(__dirname, "..", "shim");
const SHIM_PREFIX = "t3ext";
const PATCH_INFO = `${SHIM_PREFIX}/patch.json`;

function paths(appPath) {
  const resources = path.join(appPath, "Contents", "Resources");
  return {
    asar: path.join(resources, "app.asar"),
    backup: path.join(resources, "app.asar.t3ext-backup"),
    infoPlist: path.join(appPath, "Contents", "Info.plist"),
  };
}

function shimFiles(dir = SHIM_DIR) {
  const files = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else files.set(child, fs.readFileSync(path.join(dir, child)));
    }
  };
  walk("");
  return files;
}

function shimHash(files) {
  const hash = crypto.createHash("sha256");
  for (const [rel, data] of files) hash.update(`${rel}\0${data.length}\0`).update(data);
  return hash.digest("hex");
}

// { kind: "missing" } | { kind: "unpatched" } | { kind: "patched", hash, originalMain }
function archiveState(archivePath) {
  if (!fs.existsSync(archivePath)) return { kind: "missing" };
  const parsed = asar.readHeader(archivePath);
  const info = asar.readFile(archivePath, PATCH_INFO, parsed);
  if (!info) return { kind: "unpatched" };
  const { hash, originalMain } = JSON.parse(info.toString("utf8"));
  return { kind: "patched", hash, originalMain };
}

function inspect(appPath, shimDir) {
  const p = paths(appPath);
  if (!fs.existsSync(p.asar)) throw new Error(`${appPath} has no Contents/Resources/app.asar. Is it an Electron app?`);
  return { paths: p, archive: archiveState(p.asar), backup: archiveState(p.backup), shimHash: shimHash(shimFiles(shimDir)) };
}

function writePatched(src, dest, shim) {
  const packageJson = JSON.parse(asar.readFile(src, "package.json").toString("utf8"));
  const originalMain = packageJson.main;
  const files = new Map();
  for (const [rel, data] of shim) files.set(`${SHIM_PREFIX}/${rel}`, data);
  files.set(PATCH_INFO, Buffer.from(`${JSON.stringify({ hash: shimHash(shim), originalMain }, null, 2)}\n`));
  files.set("package.json", Buffer.from(`${JSON.stringify({ ...packageJson, main: `${SHIM_PREFIX}/boot.cjs`, t3extOriginalMain: originalMain }, null, 2)}\n`));
  asar.writeWithFiles(src, dest, files);
}

function copyAtomic(src, dest) {
  const tmp = `${dest}.t3ext-tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

function patch(appPath, { shimDir } = {}) {
  return withPermissionHint(() => {
    const state = inspect(appPath, shimDir);
    const { asar: archive, backup } = state.paths;
    const shim = shimFiles(shimDir);
    switch (state.archive.kind) {
      case "unpatched":
        copyAtomic(archive, backup);
        writePatched(archive, archive, shim);
        return { action: "patched", hash: state.shimHash };
      case "patched":
        if (state.archive.hash === state.shimHash) return { action: "already-patched", hash: state.shimHash };
        if (state.backup.kind !== "unpatched") {
          throw new Error(`app.asar is patched with an older shim, and ${backup} is ${state.backup.kind}. Reinstall the app to get a clean app.asar, then patch again.`);
        }
        writePatched(backup, archive, shim);
        return { action: "repatched", hash: state.shimHash };
    }
  });
}

function unpatch(appPath) {
  return withPermissionHint(() => {
    const state = inspect(appPath);
    if (state.archive.kind === "unpatched") return { action: "not-patched" };
    if (state.backup.kind !== "unpatched") {
      throw new Error(`Cannot unpatch: ${state.paths.backup} is ${state.backup.kind}. Reinstall the app to restore it.`);
    }
    fs.renameSync(state.paths.backup, state.paths.asar);
    return { action: "unpatched" };
  });
}

function withPermissionHint(fn) {
  try {
    return fn();
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      error.message +=
        "\nmacOS blocked the write into the app bundle. Grant your terminal (or the node binary running this) " +
        '"App Management" in System Settings > Privacy & Security, then run the command again.';
    }
    throw error;
  }
}

module.exports = { patch, unpatch, inspect, paths, shimFiles, shimHash, SHIM_DIR };
