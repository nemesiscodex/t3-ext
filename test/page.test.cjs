"use strict";

// host/page.js in a bare V8 context: an in-memory window.t3ext in place of the preload, plain
// objects in place of React's fibers, and stand-ins for T3's WebSocket messages.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const PAGE = fs.readFileSync(path.join(__dirname, "..", "host", "page.js"), "utf8");
const KEY = Symbol.for("t3ext.page");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// One page. `stored` is the host's config file; setConfig broadcasts to every listener, as the
// host does to every window.
function loadPage({ stored = {}, query = () => null, queryAll = () => [] } = {}) {
  const listeners = new Set();
  const calls = [];
  const t3ext = {
    getConfig: async (id) => stored[id] ?? null,
    setConfig: async (id, value) => {
      calls.push([id, value]);
      await tick();
      stored[id] = JSON.parse(JSON.stringify(value));
      for (const listener of listeners) listener(id, stored[id]);
      return stored[id];
    },
    onConfigChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  class WebSocket {
    send() {}
  }
  class MessageEvent {
    constructor(text, target) {
      this.raw = text;
      this.target = target;
    }
    get data() {
      return this.raw;
    }
  }
  const context = vm.createContext({ console, t3ext, WebSocket, MessageEvent, addEventListener() {}, Event: class {}, Element: class {}, location: { hash: "" }, document: { querySelector: query, querySelectorAll: queryAll } });
  context.window = context;
  vm.runInContext(PAGE, context);
  const page = context[KEY];
  const extOf = (id) => {
    let ext;
    page.run(id, (_id, given) => (ext = given));
    return ext;
  };
  const socket = new WebSocket();
  return {
    page,
    context,
    extOf,
    calls,
    broadcast: (id, value) => listeners.forEach((listener) => listener(id, value)),
    send: (message) => socket.send(JSON.stringify(message)),
    receive: (message) => new MessageEvent(JSON.stringify(message), socket).data,
  };
}

test("each extension runs once, gets its id, and a throw comes back as the error", () => {
  const { page } = loadPage();
  const seen = [];
  assert.equal(page.run("a", (id, ext) => seen.push([id, typeof ext.config.update])), null);
  assert.equal(page.run("a", () => seen.push("again")), null);
  assert.deepEqual(seen, [["a", "function"]]);
  assert.equal(page.ran("a"), true);
  assert.equal(page.run("b", () => missingName), "missingName is not defined");
});

test("config: an extension hears only its own changes, each value once, its own write included", async () => {
  const { extOf, broadcast } = loadPage({ stored: { a: { n: 1 } } });
  const a = extOf("a");
  const heard = [];
  a.config.subscribe((value) => heard.push(value));
  await tick();
  assert.deepEqual(heard, [{ n: 1 }], "the saved value once loaded");
  assert.deepEqual(await a.config.update((value) => ({ n: value.n + 1 })), { n: 2 });
  broadcast("b", { n: 99 });
  broadcast("a", { n: 2 });
  assert.deepEqual(heard, [{ n: 1 }, { n: 2 }], "the write's echo and another extension's change are not heard");
  broadcast("a", { n: 5 });
  assert.deepEqual(heard.at(-1), { n: 5 }, "another window's write is heard");
  assert.deepEqual(await a.config.get(), { n: 5 });
});

test("config: quick writes run in order, each on the value the previous one saved", async () => {
  const { extOf, calls } = loadPage();
  const a = extOf("a");
  const add = (item) => a.config.update((value) => [...(value ?? []), item]);
  const results = await Promise.all([add("x"), add("y"), add("z")]);
  assert.deepEqual(calls.map(([, value]) => value), [["x"], ["x", "y"], ["x", "y", "z"]]);
  assert.deepEqual(results.at(-1), ["x", "y", "z"]);
});

test("settings: panels reach the manager, and open() works only once a manager serves", () => {
  const { page, extOf } = loadPage();
  const a = extOf("a");
  const manager = extOf("builtin:extension-manager");
  assert.equal(a.manager, undefined, "only the manager gets ext.manager");
  const render = () => {};
  a.settings.register(render);
  assert.equal(manager.manager.panelOf("a"), render);
  assert.equal(a.settings.canOpen(), false);
  assert.equal(a.settings.open(), false);
  const opened = [];
  manager.manager.serve((id) => opened.push(id ?? "list"));
  assert.equal(a.settings.canOpen(), true);
  assert.equal(a.settings.open(), true);
  page.openManager();
  assert.deepEqual(opened, ["a", "list"], "an extension opens its own panel; the host's menu opens the list");
});

test("threads: pushes, replays after a reconnect, commands, removals and snapshots", () => {
  const { extOf, send, receive } = loadPage();
  const events = [];
  const threads = extOf("a").t3.threads;
  threads.subscribe((event) => events.push(event.kind === "updated" ? `${event.shell.id}:${event.live}` : event.kind === "command" ? event.command.type : event.kind));
  extOf("b").t3.threads.subscribe(() => {
    throw new Error("a broken listener");
  });

  receive({ _tag: "Chunk", requestId: 1, values: [{ kind: "thread.updated", thread: { id: "t1", status: "running" } }] });
  send({ tag: "orchestration.subscribeShell", id: 2 });
  receive({ _tag: "Chunk", requestId: 2, values: [{ kind: "thread.updated", thread: { id: "t2" } }, { kind: "synchronized" }, { kind: "thread.updated", thread: { id: "t3" } }] });
  send({ tag: "orchestration.dispatchCommand", payload: { type: "thread.settle", threadId: "t1" } });
  receive({ _tag: "Chunk", requestId: 1, values: [{ kind: "thread.removed", threadId: "t2" }, { kind: "snapshot", snapshot: { threads: [{ id: "t4" }] } }] });

  assert.deepEqual(events, ["t1:true", "t2:false", "t3:true", "thread.settle", "removed", "snapshot"]);
  assert.equal(threads.get("t1").status, "running");
  assert.equal(threads.get("t2"), null);
  assert.equal(threads.get("t4").id, "t4", "a snapshot fills in threads no push has mentioned");
});

test("threads: status follows T3's sidebar, and a subagent's question shows on its parent's row", () => {
  const { extOf, receive } = loadPage();
  const threads = extOf("a").t3.threads;
  threads.subscribe(() => {});
  const run = { latestRunId: "r", activeProviderThreadId: "p" };
  const parent = { id: "p", ...run, status: "running" };
  const child = { id: "c", ...run, status: "running", lineage: { relationshipToParent: "subagent", parentThreadId: "p" }, pendingRuntimeRequest: { kind: "approval" } };
  receive({ values: [{ kind: "thread.updated", thread: parent }, { kind: "thread.updated", thread: child }] });

  assert.equal(threads.status(parent), "working");
  assert.equal(threads.owner(child), "p");
  assert.equal(threads.rowStatus("p"), "needs-you");
  assert.equal(threads.rowStatus("unknown"), null);
  assert.equal(threads.status({ ...parent, pendingRuntimeRequest: { kind: "auth_refresh" } }), "working", "an auth refresh waits on nobody");
  assert.equal(threads.status({ ...parent, pendingRuntimeRequest: { kind: "user_input", blocking: false } }), "working", "a question the run works past");
  assert.equal(threads.status({ ...parent, pendingRuntimeRequest: { kind: "user_input" } }), "needs-you");
  assert.equal(threads.status({ ...parent, status: "completed" }), "ready");
});

// A DOM node whose fiber chain is `props` from the node up; `memo` sits on the last fiber.
function fakeNode(propsChain, memo) {
  const fibers = propsChain.map((memoizedProps) => ({ memoizedProps }));
  fibers.forEach((fiber, i) => (fiber.return = fibers[i + 1] ?? null));
  fibers.at(-1).stateNode = { current: fibers.at(-1) };
  if (memo) fibers.at(-1).updateQueue = { memoCache: { data: [[memo]] } };
  return { __reactFiber$abc: fibers[0] };
}

test("t3: the project catalog is read from the filter button's fibers, and members are normalized", () => {
  const catalog = {
    projectScopeItems: [],
    projectGroups: [
      {
        projectKey: "k1",
        displayName: "One",
        environmentId: "e",
        workspaceRoot: "/one",
        faviconPath: "",
        memberProjectRefs: [{ environmentId: "e", projectId: "p1" }],
        memberProjects: [{ title: "one", workspaceRoot: "/one", repositoryIdentity: { canonicalKey: "github.com/a/one", displayName: "a/one" } }],
      },
    ],
  };
  const button = fakeNode([{}, {}], catalog);
  const { extOf } = loadPage({ query: (selector) => (selector.includes("Filter threads by project") ? button : null) });
  assert.deepEqual(JSON.parse(JSON.stringify(extOf("a").t3.projects())), [
    { key: "k1", name: "One", icon: null, environmentId: "e", workspaceRoot: "/one", faviconPath: null, refs: ["e:p1"], members: [{ title: "one", workspaceRoot: "/one", repository: { key: "github.com/a/one", name: "a/one" } }] },
  ]);
  assert.equal(loadPage().extOf("a").t3.projects(), null, "no filter button, no catalog");
  const renamed = { ...catalog, projectGroups: [{ ...catalog.projectGroups[0], memberProjectRefs: undefined, memberRefs: [] }] };
  const renamedButton = fakeNode([{}], renamed);
  assert.equal(loadPage({ query: () => renamedButton }).extOf("a").t3.projects(), null, "a field T3 renamed reads as no catalog, not as no projects");
});

test("t3: rowData reads thread, project and wake time from the row's fibers, and leaves out what is missing", () => {
  const thread = { id: "t", title: "Title" };
  const { extOf } = loadPage();
  const { rowData } = extOf("a").t3;
  const row = fakeNode([{ className: "li" }, { thread, project: { title: "p", workspaceRoot: "/p" } }, { thread, wokeAt: "2026-01-01" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(rowData(row))), { thread, project: { title: "p", workspaceRoot: "/p", repository: null }, wokeAt: "2026-01-01" });
  const renamed = rowData(fakeNode([{ thread }]));
  assert.equal("project" in renamed || "wokeAt" in renamed, false);
  assert.equal(rowData(fakeNode([{ item: thread }])), null);
});

test("t3: openThread reads the thread from T3's hash route", () => {
  const { extOf, context } = loadPage();
  const { openThread } = extOf("a").t3;
  context.location.hash = "#/env-1/mcp%3Aabc";
  assert.deepEqual({ ...openThread() }, { environmentId: "env-1", threadId: "mcp:abc" });
  context.location.hash = "#/settings";
  assert.equal(openThread(), null);
});
