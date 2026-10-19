"use strict";

// How the launcher learns that a T3 process already runs the host, without opening its inspector.
// The host listens on a Unix socket named after its pid and answers every connection with its pid.
// Only a live process can accept a connection, so a socket file left by a dead host (whose pid a
// new T3 may since have reused) refuses the connection and reads as "no host".

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// The per-user temp dir from confstr, not $TMPDIR: launchd agents and LaunchServices apps can see
// different environments, and both sides must agree on the path.
let tempDir;
function userTempDir() {
  tempDir ??= execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  return tempDir;
}

function socketPath(pid, dir = userTempDir()) {
  return path.join(dir, `t3ext-host-${pid}.sock`);
}

function serve({ dir } = {}) {
  const file = socketPath(process.pid, dir);
  fs.rmSync(file, { force: true });
  const server = net.createServer((socket) => socket.end(`${JSON.stringify({ pid: process.pid })}\n`));
  server.on("error", (error) => console.error("[t3ext] host presence socket failed", error));
  server.listen(file);
  server.unref();
  process.once("exit", () => fs.rmSync(file, { force: true }));
  return server;
}

function hostAnswers(pid, { dir, timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath(pid, dir));
    let reply = "";
    const finish = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("data", (data) => (reply += data));
    socket.on("end", () => {
      try {
        finish(JSON.parse(reply).pid === pid);
      } catch {
        finish(false);
      }
    });
    socket.on("error", () => finish(false));
  });
}

module.exports = { serve, hostAnswers, socketPath, userTempDir };
