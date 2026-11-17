// Finds the thread that launched each thread, for the renderer. T3 does not send it to the window:
// a thread made with t3_thread_launch or create_threads has no lineage, and the launching thread
// is only the `senderThreadId` of its first message. That message lives on the machine that runs
// the thread, which can be a linked environment, so this asks T3's own MCP server, which forwards
// to linked environments, with `t3_thread_read`.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOG = "[thread-tree]";
// How far up a chain of subagents to look for the thread that has a sidebar row.
const MAX_SUBAGENT_HOPS = 20;
const MAX_CALLS = 4;
const TITLE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const ISSUE = ["auth", "session", "issue", "--scope", "orchestration:read", "--subject", "mcp-client", "--ttl", "12h", "--label", "Thread Tree", "--json"];

function t3Home(env = process.env) {
  return env.T3CODE_HOME?.trim() || path.join(os.homedir(), ".t3");
}

// T3's `t3` command: `file` with the arguments `prefix()` returns first, as ~/.t3/bin/t3 runs T3's
// binary. A token is a bearer credential, so it stays in memory and out of every message.
function t3Cli(file, prefix = () => [], env = process.env) {
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile(file, [...prefix(), ...args], { env, timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout) =>
        error ? reject(new Error(`t3 ${args.slice(0, 3).join(" ")} failed (exit ${error.code ?? error.signal})`)) : resolve(stdout),
      );
    });
  return {
    async mint() {
      const stdout = await run(ISSUE);
      let issued = null;
      try {
        issued = JSON.parse(stdout.slice(stdout.indexOf("{")));
      } catch {}
      if (typeof issued?.token !== "string" || typeof issued.sessionId !== "string") throw new Error("t3 auth session issue printed no token");
      return { token: issued.token, sessionId: issued.sessionId };
    },
    revoke: (sessionId) => run(["auth", "session", "revoke", sessionId]),
  };
}

// The JSON-RPC reply in a response body, sent as JSON or as server-sent events.
function replyOf(text, contentType, id) {
  if (!text) return null;
  if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
  const messages = text
    .split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n"))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  return messages.find((message) => message.id === id) ?? messages.at(-1) ?? null;
}

// parents([{ environmentId, threadId }]) -> { parents: { [threadId]: parentThreadId | null },
// titles: { [parentThreadId]: title } }, for rows of one environment. A thread is left out of
// `parents` while it has no message yet, as right after a launch, or while T3 cannot be reached,
// so the renderer asks again later. A parent T3 no longer has gets no title.
function createParents({ home = t3Home(), mint, revoke, fetch = globalThis.fetch, log = console.error, now = Date.now }) {
  let credential = null;
  let minting = null;
  let origin = null;
  let session = null;
  let opening = null;
  let nextId = 1;
  let warned = false;
  const known = new Map();
  const titles = new Map();

  function ensureCredential() {
    if (credential) return Promise.resolve(credential);
    minting ??= mint()
      .then((issued) => (credential = issued))
      .finally(() => (minting = null));
    return minting;
  }

  // The server refused `stale`: a new token, and the old session revoked if it still exists.
  function renew(stale) {
    if (credential === stale) {
      credential = null;
      session = null;
      revoke(stale.sessionId).catch(() => {});
    }
    return ensureCredential();
  }

  async function send(token, body, sessionId) {
    origin ??= JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8")).origin;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    let response;
    try {
      response = await fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      origin = null;
      session = null;
      throw new Error(`could not reach T3's server: ${error.cause?.code ?? error.message}`);
    }
    const text = await response.text();
    return { status: response.status, sessionId: response.headers.get("mcp-session-id"), reply: response.ok ? replyOf(text, response.headers.get("content-type"), body.id) : null };
  }

  async function openSession(token) {
    const id = nextId++;
    const opened = await send(token, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "thread-tree", version: "1.0.0" } } });
    if (!opened.sessionId || opened.status >= 400) throw Object.assign(new Error(`T3's server did not open an MCP session (HTTP ${opened.status})`), { status: opened.status });
    await send(token, { jsonrpc: "2.0", method: "notifications/initialized" }, opened.sessionId);
    return (session = opened.sessionId);
  }

  async function request(body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await ensureCredential();
      let sessionId;
      try {
        sessionId = session ?? (await (opening ??= openSession(current.token).finally(() => (opening = null))));
      } catch (error) {
        if (error.status !== 401) throw error;
        await renew(current);
        continue;
      }
      const { status, reply } = await send(current.token, body, sessionId);
      if (status === 401) await renew(current);
      else if (status >= 400 && status < 500) {
        if (session === sessionId) session = null;
      } else if (status >= 400) throw new Error(`T3's server answered HTTP ${status}`);
      else return reply;
    }
    throw new Error("T3's server kept refusing Thread Tree's requests");
  }

  let calls = 0;
  const waiting = [];
  async function limited(fn) {
    if (calls < MAX_CALLS) calls++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else calls--;
    }
  }

  // { thread, items } for a thread, or null when T3 does not have it.
  function readThread(environmentId, threadId) {
    return limited(async () => {
      const id = nextId++;
      const reply = await request({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "t3_thread_read", arguments: { threadId, environmentId, afterPosition: -1, limit: 1, maxCharsPerItem: 1, runLimit: 1 } },
      });
      if (reply?.error) throw new Error(`t3_thread_read failed: ${reply.error.message ?? reply.error.code}`);
      const result = reply?.result;
      let value = result?.structuredContent ?? null;
      if (!value) {
        try {
          value = JSON.parse(result?.content?.[0]?.text);
        } catch {}
      }
      if (result?.isError) {
        if (value?.code === "thread_not_found") return null;
        throw new Error(`t3_thread_read failed: ${value?.code ?? "error"}`);
      }
      if (!value?.thread) throw new Error("t3_thread_read answered without a thread");
      return value;
    });
  }

  function rememberTitle(environmentId, threadId, read) {
    const title = typeof read?.thread?.title === "string" && read.thread.title ? read.thread.title : null;
    titles.set(`${environmentId}:${threadId}`, { title, at: now() });
    return title;
  }

  async function titleOf(environmentId, threadId) {
    const cached = titles.get(`${environmentId}:${threadId}`);
    if (cached && now() - cached.at < TITLE_TTL_MS) return cached.title;
    return rememberTitle(environmentId, threadId, await readThread(environmentId, threadId));
  }

  // A subagent has no sidebar row, so a launch from one belongs to its first ancestor that has.
  async function rowOwner(environmentId, sender) {
    let id = sender;
    let read = await readThread(environmentId, id);
    for (let i = 0; i < MAX_SUBAGENT_HOPS && read?.thread?.relationshipToParent === "subagent" && typeof read.thread.parentThreadId === "string"; i++) {
      id = read.thread.parentThreadId;
      read = await readThread(environmentId, id);
    }
    rememberTitle(environmentId, id, read);
    return id;
  }

  // The parent's id, null, or undefined while the thread has no message yet. A parent never
  // changes, so it is kept.
  async function parentOf(environmentId, threadId) {
    const key = `${environmentId}:${threadId}`;
    if (known.has(key)) return known.get(key);
    const read = await readThread(environmentId, threadId);
    let parent = null;
    if (read?.thread.creationSource === "mcp") {
      if (!Array.isArray(read.items) || read.items.length === 0) return undefined;
      const sender = read.items[0]?.senderThreadId;
      if (typeof sender === "string" && sender) parent = await rowOwner(environmentId, sender);
    }
    known.set(key, parent);
    return parent;
  }

  async function parents(rows) {
    const answer = { parents: {}, titles: {} };
    let failure = null;
    const valid = (Array.isArray(rows) ? rows : []).filter((row) => typeof row?.threadId === "string" && typeof row.environmentId === "string");
    await Promise.all(
      valid.map(async ({ environmentId, threadId }) => {
        try {
          const parent = await parentOf(environmentId, threadId);
          if (parent === undefined) return;
          answer.parents[threadId] = parent;
          const title = parent === null ? null : await titleOf(environmentId, parent);
          if (title) answer.titles[parent] = title;
        } catch (error) {
          failure ??= error;
        }
      }),
    );
    if (failure && !warned) log(LOG, "could not read threads from T3; they stay where T3 puts them until it answers:", failure.message);
    warned = failure !== null;
    return answer;
  }

  function close() {
    if (credential) revoke(credential.sessionId).catch(() => {});
    credential = null;
    session = null;
  }

  return { parents, close };
}

module.exports = ({ electron, handle }) => {
  const { app } = electron;
  const home = t3Home();
  const cli = t3Cli(process.execPath, () => [path.join(app.getAppPath(), "apps", "server", "dist", "bin.mjs")], { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3CODE_HOME: home });
  const tree = createParents({ home, mint: cli.mint, revoke: cli.revoke });
  app.on("will-quit", () => tree.close());
  handle(async (request, rows) => (request === "parents" ? tree.parents(rows) : null));
};
module.exports.createParents = createParents;
module.exports.t3Cli = t3Cli;
