"use strict";

// examples/thread-tree: main.js against a stand-in for T3's MCP server, and renderer.js in a bare
// V8 context with a small stand-in for the sidebar list and its fibers.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const DIR = path.join(__dirname, "..", "examples", "thread-tree");
const { createParents } = require(path.join(DIR, "main.js"));
const RENDERER = fs.readFileSync(path.join(DIR, "renderer.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- main.js ----------------------------------------------------------------------------------

// T3's MCP endpoint: bearer tokens, a session from `initialize`, and t3_thread_read over
// `threads` ({ "<environmentId>:<threadId>": { thread, items } }). Replies are JSON, or
// server-sent events with `sse`.
async function mcpServer(t, threads) {
  const server = {
    tokens: new Set(),
    sessions: new Set(),
    sse: false,
    initializes: 0,
    reads: [],
  };
  const http_ = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const auth = request.headers.authorization ?? "";
      if (!server.tokens.has(auth.replace(/^Bearer /, ""))) return response.writeHead(401).end();
      const message = JSON.parse(body);
      const reply = (result, headers = {}) => {
        const text = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (server.sse) response.writeHead(200, { "Content-Type": "text/event-stream", ...headers }).end(`event: message\ndata: ${text}\n\n`);
        else response.writeHead(200, { "Content-Type": "application/json", ...headers }).end(text);
      };
      if (message.method === "initialize") {
        server.initializes++;
        const id = `mcp-session-${server.initializes}`;
        server.sessions.add(id);
        return reply({ protocolVersion: "2025-06-18", capabilities: {} }, { "Mcp-Session-Id": id });
      }
      if (!server.sessions.has(request.headers["mcp-session-id"])) return response.writeHead(404).end();
      if (message.method === "notifications/initialized") return response.writeHead(202).end();
      const { threadId, environmentId } = message.params.arguments;
      server.reads.push(`${environmentId}:${threadId}`);
      const found = threads[`${environmentId}:${threadId}`];
      if (!found) return reply({ content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code: "thread_not_found", message: `Thread ${threadId} is no longer available.` }) }], isError: true });
      reply({ content: [{ type: "text", text: JSON.stringify(found) }], structuredContent: found, isError: false });
    });
  });
  await new Promise((resolve) => http_.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => http_.close(resolve)));
  server.origin = `http://127.0.0.1:${http_.address().port}`;
  return server;
}

// A T3 home whose server-runtime.json points at `origin`, and Thread Tree's main.js on it, with a
// `t3` that mints tokens the server accepts.
function mainFor(t, server, origin = server.origin) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-thread-tree-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "userdata"));
  fs.writeFileSync(path.join(home, "userdata", "server-runtime.json"), JSON.stringify({ origin }));
  const cli = { minted: [], revoked: [], logs: [] };
  const tree = createParents({
    home,
    mint: async () => {
      const issued = { token: `secret-token-${cli.minted.length + 1}`, sessionId: `auth-session-${cli.minted.length + 1}` };
      cli.minted.push(issued);
      server?.tokens.add(issued.token);
      return issued;
    },
    revoke: async (sessionId) => cli.revoked.push(sessionId),
    log: (...args) => cli.logs.push(args.map(String).join(" ")),
  });
  return { ...tree, cli };
}

const thread = (id, { source = "web", title = `Title of ${id}`, parent = null, relationship = null, sender, empty = false } = {}) => ({
  thread: { threadId: id, title, creationSource: source, parentThreadId: parent, relationshipToParent: relationship },
  items: empty ? [] : [{ position: 0, type: "user_message", ...(sender ? { senderThreadId: sender } : {}) }],
});

const THREADS = Object.fromEntries(
  [
    thread("lead"),
    thread("root"),
    thread("sub-1", { relationship: "subagent", parent: "root" }),
    thread("sub-2", { relationship: "subagent", parent: "sub-1" }),
    thread("launched", { source: "mcp", sender: "lead" }),
    thread("from-subagent", { source: "mcp", sender: "sub-2" }),
    thread("typed"),
    thread("just-launched", { source: "mcp", empty: true }),
    thread("no-sender", { source: "mcp" }),
    thread("orphan", { source: "mcp", sender: "deleted-lead" }),
  ].map((value) => [`linux:${value.thread.threadId}`, value]),
);

const rows = (...threadIds) => threadIds.map((threadId) => ({ environmentId: "linux", threadId }));

test("main.js: a launched thread's parent is the sender of its first message, or that sender's first ancestor with a row, with its title", async (t) => {
  const server = await mcpServer(t, THREADS);
  const main = mainFor(t, server);
  assert.deepEqual(await main.parents(rows("launched", "from-subagent", "typed", "just-launched", "no-sender", "unknown", "orphan")), {
    parents: { launched: "lead", "from-subagent": "root", typed: null, "no-sender": null, unknown: null, orphan: "deleted-lead" },
    titles: { lead: "Title of lead", root: "Title of root" },
  });
  assert.ok(server.reads.every((key) => key.startsWith("linux:")), "every read names the row's environment");
  assert.equal(server.initializes, 1, "one MCP session for all the reads");
  assert.deepEqual(main.cli.minted.length, 1, "one token for all the reads");

  server.reads.length = 0;
  assert.deepEqual(await main.parents(rows("launched", "typed")), { parents: { launched: "lead", typed: null }, titles: { lead: "Title of lead" } });
  assert.deepEqual(server.reads, [], "parents and fresh titles are kept");
});

test("main.js: server-sent replies, a session the server forgot, and a refused token, which is replaced and revoked", async (t) => {
  const server = await mcpServer(t, THREADS);
  server.sse = true;
  const main = mainFor(t, server);
  assert.deepEqual((await main.parents(rows("launched"))).parents, { launched: "lead" });

  server.sessions.clear();
  assert.deepEqual((await main.parents(rows("from-subagent"))).parents, { "from-subagent": "root" });
  assert.equal(server.initializes, 2, "a forgotten session is opened again");

  server.tokens.clear();
  assert.deepEqual((await main.parents(rows("no-sender"))).parents, { "no-sender": null });
  assert.deepEqual(main.cli.minted.map((issued) => issued.sessionId), ["auth-session-1", "auth-session-2"]);
  assert.deepEqual(main.cli.revoked, ["auth-session-1"], "the refused token's session is revoked");
  main.close();
  assert.deepEqual(main.cli.revoked, ["auth-session-1", "auth-session-2"], "closing revokes the token in use");
  assert.deepEqual(main.cli.logs, []);
});

test("main.js: with T3's server down it answers nothing, logs once, and never logs a token", async (t) => {
  const server = await mcpServer(t, THREADS);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const main = mainFor(t, server, `http://127.0.0.1:${port}`);
  assert.deepEqual(await main.parents(rows("launched", "typed")), { parents: {}, titles: {} });
  assert.deepEqual(await main.parents(rows("launched")), { parents: {}, titles: {} });
  assert.equal(main.cli.logs.length, 1);
  assert.match(main.cli.logs[0], /could not reach T3's server/);
  assert.ok(main.cli.minted.length > 0 && main.cli.logs.every((line) => !line.includes("secret-token")), "no token in the log");
});

// --- renderer.js ------------------------------------------------------------------------------

// Every change made to the fake page counts as a write.
const dom = { writes: 0 };

function writesAfter(change) {
  dom.writes = 0;
  change();
  return dom.writes;
}

class FakeElement {
  constructor(tag, attributes = {}) {
    this.nodeName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attributes));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = [];
    this.clicks = 0;
    this.text = "";
  }
  get children() {
    return this.childNodes;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent() {
    return this.text;
  }
  set textContent(value) {
    dom.writes++;
    this.text = String(value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name, value) {
    dom.writes++;
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    dom.writes++;
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  // Only "tag[attribute]" and "[attribute]".
  matches(selector) {
    const [, tag, attribute] = selector.match(/^(\w*)\[([\w-]+)\]$/);
    return (!tag || this.nodeName === tag.toUpperCase()) && this.hasAttribute(attribute);
  }
  *descendants() {
    for (const child of this.childNodes) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    return [...this.descendants()].filter((node) => node.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  insertBefore(node, before) {
    dom.writes++;
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    node.parentNode = this;
  }
  remove() {
    dom.writes++;
    this.parentNode?.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  click() {
    this.clicks++;
    for (const listener of this.listeners) listener({ type: "click" });
  }
}

// T3's sidebar list: `items` in T3's order, each a thread id, "-name" for a non-thread item, or
// "+name" for an element another extension put in the list, which React does not know about.
// `parents` maps a thread id to its parent's, null, or "absent" for "no answer yet", and `titles`
// is what main.js knows of parents' titles. `shells` are T3's latest thread updates, and `saved`
// is the extension's config as the host keeps it. Thread ids
// that start with "web" are typed by a person, the rest were launched. Every row's title is
// "Title of <id>".
function sidebar({ items, parents = {}, titles = {}, shells = {}, saved = null, invoke }) {
  const root = new FakeElement("div");
  const list = new FakeElement("ul");
  root.insertBefore(list, null);
  const elements = new Map();
  const known = [];
  for (const name of items) {
    const element = name[0] === "-" || name[0] === "+" ? new FakeElement("li") : new FakeElement("li", { "data-thread-item": `env-local:${name}` });
    element.insertBefore(new FakeElement("div", { "data-sidebar-row": name }), null);
    elements.set(name, element);
    list.insertBefore(element, null);
    if (name[0] !== "+") known.push(element);
  }
  // Each element under a component fiber, as SortableThreadRow renders the row's li, and the
  // first two under one more, as a fragment would.
  let fiberOfList;
  const setReactOrder = (order) => {
    const host = (element) => ({ type: "li", stateNode: element, child: { type: "div", stateNode: element.firstChild, child: null, sibling: null }, sibling: null });
    const components = order.map((element) => ({ type: function Row() {}, child: host(element), sibling: null }));
    components.forEach((fiber, index) => (fiber.sibling = components[index + 1] ?? null));
    const fragment = { type: Symbol.for("react.fragment"), child: components[0], sibling: components[2] ?? null };
    if (components[1]) components[1].sibling = null;
    fiberOfList = { type: "ul", stateNode: list, child: components.length > 1 ? fragment : components[0] };
  };
  setReactOrder(known);

  const rowOf = (node) => {
    const item = node.getAttribute?.("data-thread-item");
    if (!item) return null;
    const at = item.indexOf(":");
    return { element: node, environmentId: item.slice(0, at), threadId: item.slice(at + 1) };
  };
  const calls = [];
  const warnings = [];
  let observer = null;
  let threadListener = null;
  const config = { value: saved, listeners: [] };
  const ext = {
    config: {
      subscribe: (listener) => {
        config.listeners.push(listener);
        Promise.resolve().then(() => listener(config.value));
      },
      update: async (change) => {
        config.value = JSON.parse(JSON.stringify(change(config.value)));
        for (const listener of config.listeners) listener(config.value);
        return config.value;
      },
    },
    t3: {
      fiberOf: (node) => (node === list ? fiberOfList : null),
      rowOf,
      threadRows: (threadId) => root.querySelectorAll("[data-thread-item]").map(rowOf).filter((row) => row.threadId === threadId),
      rowData: (element) => {
        const threadId = rowOf(element).threadId;
        return { thread: { id: threadId, title: `Title of ${threadId}`, source: { creationSource: threadId.startsWith("web") ? "web" : "mcp" } } };
      },
      threads: { subscribe: (listener) => (threadListener = listener), get: (threadId) => shells[threadId] ?? null },
    },
    main: {
      invoke:
        invoke ??
        (async (request, rows) => {
          calls.push([request, Array.from(rows, (row) => row.threadId)]);
          const answer = { parents: {}, titles: {} };
          for (const { threadId } of rows) {
            if (parents[threadId] === "absent") continue;
            answer.parents[threadId] = parents[threadId] ?? null;
            if (titles[parents[threadId]]) answer.titles[parents[threadId]] = titles[parents[threadId]];
          }
          return answer;
        }),
    },
    ui: {
      el: (tag, props, ...children) => {
        const node = new FakeElement(tag);
        for (const [name, value] of Object.entries(props ?? {})) {
          if (name === "onClick") node.listeners.push(value);
          else node.attributes.set(name === "className" ? "class" : name, String(value));
        }
        for (const child of children) node.insertBefore(child, null);
        return node;
      },
      icon: () => new FakeElement("svg"),
    },
  };
  const location = { hash: "" };
  const context = vm.createContext({
    console: { warn: (...args) => warnings.push(args.join(" ")), error: (...args) => warnings.push(args.join(" ")) },
    setTimeout,
    clearTimeout,
    location,
    document: { documentElement: root, querySelectorAll: (selector) => root.querySelectorAll(selector) },
    MutationObserver: class {
      constructor(callback) {
        observer = callback;
      }
      observe() {}
    },
  });
  context.window = context;
  vm.runInContext(`((extensionId, ext) => {\n${RENDERER}\n})`, context)("thread-tree", ext);

  const copyOf = (threadId) => list.childNodes.find((element) => element.getAttribute("data-thread-tree-parent") === `env-local:${threadId}`);
  return {
    list,
    calls,
    warnings,
    parents,
    location,
    saved: () => config.value,
    element: (name) => elements.get(name),
    // What the list shows: each item, indented by its depth, and "^<id>" for a copy of a parent.
    shown: () =>
      list.childNodes.map((element) => {
        const copy = element.getAttribute("data-thread-tree-parent");
        if (copy) return `^${copy.slice(copy.indexOf(":") + 1)}`;
        const name = [...elements].find(([, candidate]) => candidate === element)[0];
        return "  ".repeat(Number(element.getAttribute("data-thread-tree-depth") ?? 0)) + name;
      }),
    // The copy's button, and the title it shows.
    copy: (threadId) => {
      const button = copyOf(threadId).firstChild;
      return { button, title: button.childNodes[1].textContent, label: button.getAttribute("aria-label") };
    },
    react: (order) => setReactOrder(order.map((name) => elements.get(name))),
    // React changed the list, as after a commit.
    commit: () => observer([{ target: list, addedNodes: [], removedNodes: [] }]),
    threadUpdated: (threadId) => threadListener({ kind: "updated", shell: { id: threadId }, live: true }),
  };
}

test("renderer: launched threads follow their parent in their run, and a parent in another run shows as a copy above them", async () => {
  const page = sidebar({
    items: ["-pinned", "+clone", "web-lead", "web-other", "child-1", "grandchild", "child-2", "-settled", "child-3", "web-last"],
    parents: { "child-1": "web-lead", grandchild: "child-1", "child-2": "web-lead", "child-3": "web-lead" },
  });
  await tick();
  assert.deepEqual(page.shown(), ["-pinned", "+clone", "web-lead", "  child-1", "    grandchild", "  child-2", "web-other", "-settled", "^web-lead", "  child-3", "web-last"]);
  const { title, label } = page.copy("web-lead");
  assert.deepEqual([title, label], ["Title of web-lead", "Open parent thread: Title of web-lead"]);
  assert.deepEqual(page.calls, [["parents", ["child-1", "grandchild", "child-2", "child-3"]]], "main is asked once, only about launched threads");
});

test("renderer: children of one parent outside their run gather under one copy, at the first child's place, with their own children below", async () => {
  const page = sidebar({
    items: ["-active", "c1", "web-x", "c2", "g2", "web-y", "-settled", "web-hub"],
    parents: { c1: "web-hub", c2: "web-hub", g2: "c2" },
  });
  await tick();
  assert.deepEqual(page.shown(), ["-active", "^web-hub", "  c1", "  c2", "    g2", "web-x", "web-y", "-settled", "web-hub"]);
});

test("renderer: a parent with no row takes its title from T3's updates, then main.js; with no title there is no copy", async () => {
  const page = sidebar({
    items: ["web-a", "from-shell", "from-main", "no-title"],
    parents: { "from-shell": "shown-earlier", "from-main": "never-shown", "no-title": "deleted" },
    titles: { "shown-earlier": "Older title", "never-shown": "From the database" },
    shells: { "shown-earlier": { id: "shown-earlier", title: "Renamed" } },
  });
  await tick();
  assert.deepEqual(page.shown(), ["web-a", "^shown-earlier", "  from-shell", "^never-shown", "  from-main", "no-title"]);
  assert.equal(page.copy("shown-earlier").title, "Renamed");
  assert.equal(page.copy("never-shown").title, "From the database");
});

test("renderer: a cycle and a missing parent are roots, a parent below its child moves the child, and depth stops at 4", async () => {
  const page = sidebar({
    items: ["a", "b", "orphan", "early", "late", "l0", "l1", "l2", "l3", "l4", "l5"],
    parents: { a: "b", b: "a", orphan: "gone", early: "late", l1: "l0", l2: "l1", l3: "l2", l4: "l3", l5: "l4" },
  });
  await tick();
  assert.deepEqual(page.shown(), ["a", "b", "orphan", "late", "  early", "l0", "  l1", "    l2", "      l3", "        l4", "        l5"]);
});

test("renderer: T3's reorders are followed from React, a copy goes away when its parent joins the run, and a second run writes nothing", async () => {
  const page = sidebar({ items: ["web-other", "child", "-settled", "web-lead"], parents: { child: "web-lead" } });
  await tick();
  assert.deepEqual(page.shown(), ["web-other", "^web-lead", "  child", "-settled", "web-lead"]);
  const copy = page.copy("web-lead").button;

  page.react(["web-lead", "web-other", "child", "-settled"]);
  page.commit();
  assert.deepEqual(page.shown(), ["web-lead", "  child", "web-other", "-settled"]);
  assert.equal(writesAfter(page.commit), 0);

  page.react(["web-other", "child", "-settled", "web-lead"]);
  page.commit();
  assert.deepEqual(page.shown(), ["web-other", "^web-lead", "  child", "-settled", "web-lead"]);
  assert.notEqual(page.copy("web-lead").button, copy, "a copy that went away is made again");
  assert.equal(writesAfter(page.commit), 0);
  assert.equal(page.calls.length, 1, "answers are kept for the page");
});

test("renderer: a copy stays the same element while it stays wanted, and its title is not written again", async () => {
  const page = sidebar({ items: ["web-x", "-settled", "child", "web-y"], parents: { child: "web-x" } });
  await tick();
  const button = page.copy("web-x").button;
  assert.equal(writesAfter(page.commit), 0, "a second run writes nothing");
  page.react(["web-x", "-settled", "web-y", "child"]);
  page.commit();
  assert.deepEqual(page.shown(), ["web-x", "-settled", "web-y", "^web-x", "  child"]);
  assert.equal(page.copy("web-x").button, button, "the same copy, moved");
});

test("renderer: clicking a copy opens the parent through its own row when it has one, and its route otherwise", async () => {
  const page = sidebar({
    items: ["web-lead", "-settled", "c1", "c2"],
    parents: { c1: "web-lead", c2: "mcp:hub" },
    titles: { "mcp:hub": "Hub" },
  });
  await tick();
  assert.deepEqual(page.shown(), ["web-lead", "-settled", "^web-lead", "  c1", "^mcp:hub", "  c2"]);
  page.copy("web-lead").button.click();
  assert.equal(page.element("web-lead").firstChild.clicks, 1, "T3's own row was clicked");
  assert.equal(page.location.hash, "");
  page.copy("mcp:hub").button.click();
  assert.equal(page.location.hash, "#/env-local/mcp%3Ahub");
});

test("renderer: saved answers show at once without asking main.js, and new answers are saved", async () => {
  const page = sidebar({
    items: ["web-lead", "web-other", "child", "child-2", "web-typed"],
    parents: { "child-2": "web-lead" },
    saved: { version: 1, parents: { "env-local:child": "env-local:web-lead", "env-local:elsewhere": null } },
  });
  await tick();
  assert.deepEqual(page.shown(), ["web-lead", "  child", "  child-2", "web-other", "web-typed"]);
  assert.deepEqual(page.calls, [["parents", ["child-2"]]], "only the thread with no saved answer is asked about");
  assert.deepEqual(page.saved(), {
    version: 1,
    parents: { "env-local:child": "env-local:web-lead", "env-local:elsewhere": null, "env-local:child-2": "env-local:web-lead" },
  });
});

test("renderer: a thread with no answer yet is asked about again when T3 updates it, not on every change", async () => {
  const page = sidebar({ items: ["web-lead", "web-other", "child"], parents: { child: "absent" } });
  await tick();
  assert.deepEqual(page.shown(), ["web-lead", "web-other", "child"]);
  page.commit();
  await tick();
  assert.equal(page.calls.length, 1, "a change to the list does not ask again");

  page.parents.child = "web-lead";
  page.threadUpdated("web-other");
  page.threadUpdated("child");
  page.threadUpdated("child");
  await sleep(600);
  assert.deepEqual(page.calls, [["parents", ["child"]], ["parents", ["child"]]], "two quick updates ask once");
  assert.deepEqual(page.shown(), ["web-lead", "  child", "web-other"]);
});

test("renderer: when main.js cannot answer, the list stays as T3 draws it, and it says so once", async () => {
  const page = sidebar({
    items: ["web-lead", "web-other", "child"],
    invoke: async () => {
      throw new Error("thread-tree has no main.js handler");
    },
  });
  await tick();
  page.commit();
  page.threadUpdated("child");
  await tick();
  assert.deepEqual(page.shown(), ["web-lead", "web-other", "child"]);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0], /^\[thread-tree\] could not ask main\.js/);
});
