"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { hostAnswers, socketPath } = require("../host/presence.cjs");

const PRESENCE = require.resolve("../host/presence.cjs");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-presence-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for T3: a process that runs the host's presence server, or (bare) nothing at all.
async function child(t, dir, { host }) {
  const code = host
    ? `require(${JSON.stringify(PRESENCE)}).serve({ dir: ${JSON.stringify(dir)} });`
    : "";
  const quitOnStdinEnd = `process.stdin.on("end", () => process.exit(0)).resume(); console.log("ready");`;
  const proc = spawn(process.execPath, ["-e", code + quitOnStdinEnd], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => proc.kill("SIGKILL"));
  await new Promise((resolve) => proc.stdout.once("data", resolve));
  return proc;
}

const killed = (proc, signal) => new Promise((resolve) => {
  proc.once("exit", resolve);
  proc.kill(signal);
});

test("a live host answers for its own pid only", async (t) => {
  const dir = tempDir(t);
  const host = await child(t, dir, { host: true });
  assert.equal(await hostAnswers(host.pid, { dir }), true);
  const bare = await child(t, dir, { host: false });
  assert.equal(await hostAnswers(bare.pid, { dir }), false, "a process without the host has no socket");
});

test("a host that crashed leaves a socket file that reads as no host", async (t) => {
  const dir = tempDir(t);
  const host = await child(t, dir, { host: true });
  await killed(host, "SIGKILL");
  assert.equal(fs.existsSync(socketPath(host.pid, dir)), true, "SIGKILL skips the exit cleanup");
  assert.equal(await hostAnswers(host.pid, { dir }), false);
});

test("pid reuse: a new process with a dead host's pid is not taken for a host", async (t) => {
  const dir = tempDir(t);
  const dead = await child(t, dir, { host: true });
  await killed(dead, "SIGKILL");
  const reused = await child(t, dir, { host: false });
  fs.renameSync(socketPath(dead.pid, dir), socketPath(reused.pid, dir));
  assert.equal(await hostAnswers(reused.pid, { dir }), false, "the stale socket refuses connections");
});

test("a listener that answers with another pid is not taken for the host", async (t) => {
  const dir = tempDir(t);
  const bare = await child(t, dir, { host: false });
  const impostor = net.createServer((socket) => socket.end(`${JSON.stringify({ pid: bare.pid + 1 })}\n`));
  await new Promise((resolve) => impostor.listen(socketPath(bare.pid, dir), resolve));
  t.after(() => impostor.close());
  assert.equal(await hostAnswers(bare.pid, { dir }), false);
});

test("a host that quits normally removes its socket file", async (t) => {
  const dir = tempDir(t);
  const host = await child(t, dir, { host: true });
  const exited = new Promise((resolve) => host.once("exit", resolve));
  host.stdin.end();
  await exited;
  assert.equal(fs.existsSync(socketPath(host.pid, dir)), false);
});
