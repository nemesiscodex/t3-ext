"use strict";

// asar layout: UInt32LE 4 | UInt32LE headerPickleSize | headerPickle | file data.
// headerPickle = UInt32LE payloadSize | Int32LE jsonLength | json | pad to 4.
// File offsets in the header are relative to the start of the data section.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BLOCK_SIZE = 4 * 1024 * 1024;

function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error(`${archivePath}: too short to be an asar archive`);
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerPickleSize > size - 8 || jsonLength > headerPickleSize - 8) {
      throw new Error(`${archivePath}: not an asar archive (bad header sizes)`);
    }
    const json = Buffer.alloc(jsonLength);
    fs.readSync(fd, json, 0, jsonLength, 16);
    return { header: JSON.parse(json.toString("utf8")), dataOffset: 8 + headerPickleSize, archiveSize: size };
  } finally {
    fs.closeSync(fd);
  }
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const payloadSize = Math.ceil((4 + json.length) / 4) * 4;
  const out = Buffer.alloc(8 + 4 + payloadSize);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(4 + payloadSize, 4);
  out.writeUInt32LE(payloadSize, 8);
  out.writeInt32LE(json.length, 12);
  json.copy(out, 16);
  return out;
}

function integrity(data) {
  const blocks = [];
  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    blocks.push(sha256(data.subarray(offset, offset + BLOCK_SIZE)));
  }
  if (data.length === 0) blocks.push(sha256(data));
  return { algorithm: "SHA256", hash: sha256(data), blockSize: BLOCK_SIZE, blocks };
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function findEntry(header, relPath) {
  let node = header;
  for (const part of relPath.split("/")) {
    node = node.files && Object.hasOwn(node.files, part) ? node.files[part] : undefined;
    if (!node) return undefined;
  }
  return node;
}

function setEntry(header, relPath, entry) {
  const parts = relPath.split("/");
  let dir = header;
  for (const part of parts.slice(0, -1)) {
    dir.files[part] ??= { files: {} };
    dir = dir.files[part];
  }
  dir.files[parts.at(-1)] = entry;
}

function readFile(archivePath, relPath, parsed = readHeader(archivePath)) {
  const entry = findEntry(parsed.header, relPath);
  if (!entry || entry.files || entry.link) return undefined;
  if (entry.unpacked) return fs.readFileSync(path.join(`${archivePath}.unpacked`, relPath));
  const data = Buffer.alloc(entry.size);
  const fd = fs.openSync(archivePath, "r");
  try {
    fs.readSync(fd, data, 0, entry.size, parsed.dataOffset + Number(entry.offset));
  } finally {
    fs.closeSync(fd);
  }
  return data;
}

// Writes `src` plus the given files to `dest`. Existing data bytes are copied unchanged;
// new contents go after them, and a path that already exists is repointed to its new bytes.
function writeWithFiles(src, dest, files) {
  const { header, dataOffset, archiveSize } = readHeader(src);
  let nextOffset = archiveSize - dataOffset;
  const appended = [];
  for (const [relPath, data] of files) {
    setEntry(header, relPath, { size: data.length, offset: String(nextOffset), integrity: integrity(data) });
    appended.push(data);
    nextOffset += data.length;
  }

  const tmp = `${dest}.t3ext-tmp`;
  const out = fs.openSync(tmp, "w");
  try {
    fs.writeSync(out, encodeHeader(header));
    copyRange(src, out, dataOffset, archiveSize);
    for (const data of appended) fs.writeSync(out, data);
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
  fs.renameSync(tmp, dest);
}

function copyRange(src, outFd, start, end) {
  const fd = fs.openSync(src, "r");
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  try {
    for (let pos = start; pos < end; ) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
      if (n === 0) throw new Error(`${src}: unexpected end of file`);
      fs.writeSync(outFd, chunk, 0, n);
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Builds a fresh archive from a map of relPath -> Buffer. Used by tests to make fixtures.
function create(dest, files) {
  const header = { files: {} };
  let offset = 0;
  for (const [relPath, data] of files) {
    setEntry(header, relPath, { size: data.length, offset: String(offset), integrity: integrity(data) });
    offset += data.length;
  }
  fs.writeFileSync(dest, Buffer.concat([encodeHeader(header), ...files.values()]));
}

function listFiles(header, prefix = "") {
  const out = [];
  for (const [name, entry] of Object.entries(header.files ?? {})) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.files) out.push(...listFiles(entry, relPath));
    else if (!entry.link) out.push(relPath);
  }
  return out;
}

module.exports = { readHeader, readFile, findEntry, writeWithFiles, create, listFiles };
