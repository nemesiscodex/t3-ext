"use strict";

// Helpers for driving an isolated clone of the real app over CDP.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { Cdp, targets, waitFor } = require("../src/cdp.cjs");

function cloneApp(sourceApp, dir) {
  const clone = path.join(dir, path.basename(sourceApp));
  execFileSync("cp", ["-c", "-R", sourceApp, clone]);
  return clone;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Every process whose executable lives under `dir`: the clone, its helpers, its backend
// (which runs in its own process group), and the launcher running on the clone's binary.
function processesUnder(dir) {
  const root = fs.realpathSync(dir);
  return execFileSync("ps", ["-axww", "-o", "pid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter(Boolean)
    .filter(([, , comm]) => comm.replace(/^\/private/, "").startsWith(root.replace(/^\/private/, "")))
    .map(([, pid]) => Number(pid));
}

async function killUnder(dir) {
  const signal = (pids, sig) => pids.forEach((pid) => {
    try {
      process.kill(pid, sig);
    } catch {}
  });
  signal(processesUnder(dir), "SIGTERM");
  await waitFor("processes to exit", () => processesUnder(dir).length === 0, { timeoutMs: 8000 }).catch(() => {});
  signal(processesUnder(dir), "SIGKILL");
  return processesUnder(dir);
}

async function appPage(port, timeoutMs = 60_000) {
  const target = await waitFor(
    "a t3code:// page",
    async () => (await targets(port)).find((t) => t.type === "page" && t.url.startsWith("t3code://")),
    { timeoutMs },
  );
  return Cdp.connect(target.webSocketDebuggerUrl);
}

async function screenshot(page, file) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

module.exports = { cloneApp, freePort, processesUnder, killUnder, appPage, screenshot, targets, waitFor, Cdp };
