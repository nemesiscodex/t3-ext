"use strict";

// Launches a patched clone of the real app in isolation and drives it over CDP.

const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "t3ext.cjs");

function cloneApp(sourceApp, dir) {
  const clone = path.join(dir, path.basename(sourceApp));
  execFileSync("cp", ["-c", "-R", sourceApp, clone]);
  return clone;
}

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(what, fn, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

// Agents running inside T3 inherit ELECTRON_RUN_AS_NODE=1 and T3 variables; the clone must not.
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("ELECTRON_") && !key.startsWith("T3CODE_") && key !== "__CFBundleIdentifier"),
  );
}

// HOME isolates userData (T3 derives it from os.homedir(), not app.getPath("appData")),
// which also gives the clone its own single-instance lock.
async function launch({ app, home, fakeHome, logFile }) {
  const [rendererPort, mainPort] = [await freePort(), await freePort()];
  const executable = path.join(app, "Contents", "MacOS", path.basename(app, ".app"));
  const log = fs.openSync(logFile, "a");
  const child = spawn(executable, [`--remote-debugging-port=${rendererPort}`, `--inspect=127.0.0.1:${mainPort}`, "--use-mock-keychain"], {
    env: { ...cleanEnv(), HOME: fakeHome, T3CODE_HOME: home, T3CODE_DISABLE_AUTO_UPDATE: "1" },
    detached: true,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  return { child, rendererPort, mainPort };
}

// Kills the process group we started (the app plus the helpers and backend it spawned).
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const timedOut = await Promise.race([exited.then(() => false), new Promise((r) => setTimeout(() => r(true), 8000))]);
  if (timedOut) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await exited;
  }
}

class Cdp {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Cannot connect to ${wsUrl}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      } else for (const listener of this.listeners) listener(data);
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression, extra = {}) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...extra });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  }

  close() {
    this.ws.close();
  }
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function appPage(port) {
  const target = await waitFor("a t3code:// page target", async () => (await targets(port)).find((t) => t.type === "page" && t.url.startsWith("t3code://")));
  return Cdp.connect(target.webSocketDebuggerUrl);
}

async function mainProcess(port) {
  const target = await waitFor("the main-process inspector", async () => (await targets(port))[0]);
  return Cdp.connect(target.webSocketDebuggerUrl);
}

module.exports = { cloneApp, cli, launch, stop, waitFor, appPage, mainProcess };
