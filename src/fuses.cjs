"use strict";

// Reads Electron's fuse wire from the app's Electron Framework binary. Layout (fuse version 1):
// the sentinel, one version byte, one length byte, then one byte per fuse:
// "0" off, "1" on, "r" removed. Same format @electron/fuses reads and writes.

const fs = require("node:fs");
const path = require("node:path");

const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
];
const STATES = { 0x30: "off", 0x31: "on", 0x72: "removed" };

function frameworkBinary(app) {
  return path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
}

function parseWire(bytes) {
  const [version, length] = bytes;
  if (version !== 1) throw new Error(`Unknown fuse wire version ${version}`);
  if (bytes.length < 2 + length) throw new Error("Truncated fuse wire");
  const fuses = {};
  bytes.subarray(2, 2 + length).forEach((byte, index) => {
    fuses[FUSE_NAMES[index] ?? `Fuse${index}`] = STATES[byte] ?? `unknown (0x${byte.toString(16)})`;
  });
  return { version, fuses };
}

// Offsets of every sentinel in the file, read in chunks that overlap by one sentinel length.
function sentinelOffsets(fd) {
  const offsets = [];
  const chunk = Buffer.alloc(8 << 20);
  for (let position = 0; ; position += chunk.length - SENTINEL.length) {
    const read = fs.readSync(fd, chunk, 0, chunk.length, position);
    const view = chunk.subarray(0, read);
    for (let at = view.indexOf(SENTINEL); at !== -1; at = view.indexOf(SENTINEL, at + 1)) {
      if (!offsets.includes(position + at)) offsets.push(position + at);
    }
    if (read < chunk.length) return offsets;
  }
}

// A universal binary carries one wire per architecture; a fuse whose wires disagree reads "mixed".
function combine(wires, file) {
  if (wires.length === 0) throw new Error(`No Electron fuse wire in ${file}`);
  const fuses = {};
  for (const name of Object.keys(wires[0].fuses)) {
    const values = new Set(wires.map((wire) => wire.fuses[name]));
    fuses[name] = values.size === 1 ? [...values][0] : "mixed";
  }
  return { version: wires[0].version, wires: wires.length, fuses };
}

function readFuses(app) {
  const file = frameworkBinary(app);
  const fd = fs.openSync(file, "r");
  try {
    const wires = sentinelOffsets(fd).map((at) => {
      const bytes = Buffer.alloc(2 + 255);
      const read = fs.readSync(fd, bytes, 0, bytes.length, at + SENTINEL.length);
      return parseWire(bytes.subarray(0, read));
    });
    return combine(wires, file);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readFuses, frameworkBinary, SENTINEL, FUSE_NAMES };
