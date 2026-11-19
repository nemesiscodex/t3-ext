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
function loadPage({ stored = {}, query = () => null, queryAll = () => [], invoke, Element = class {} } = {}) {
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
    ...(invoke ? { invoke } : {}),
  };
  class WebSocket {
    readyState = 1;
    sent = [];
    listeners = {};
    send(payload) {
      this.sent.push(payload);
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    close() {
      this.readyState = 3;
      for (const listener of this.listeners.close ?? []) listener();
    }
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
  const timers = [];
  const setTimeout = (fn) => timers.push(fn);
  const context = vm.createContext({ console, t3ext, WebSocket, MessageEvent, setTimeout, addEventListener() {}, Event: class {}, Element, location: { hash: "" }, document: { querySelector: query, querySelectorAll: queryAll } });
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
    timers,
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

test("main: invoke goes to the host with the extension's own id, and fails clearly on an older host", async () => {
  const { extOf } = loadPage({ invoke: async (id, ...args) => ({ id, args }) });
  assert.deepEqual(await extOf("a").main.invoke(1, "two"), { id: "a", args: [1, "two"] });
  const old = loadPage();
  await assert.rejects(old.extOf("a").main.invoke(), /no ext\.main\.invoke\. Restart T3 Code through T3 Code\+/);
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

// T3's atom registry: `values` maps each atom to its value, and set() changes one and tells its
// subscribers, as the registry does after a change.
function atomRegistry(values) {
  const listeners = new Map();
  return {
    getNodes: () => new Map([...values.keys()].map((atom) => [atom, { atom }])),
    get: (atom) => values.get(atom),
    subscribe(atom, listener) {
      listeners.set(atom, [...(listeners.get(atom) ?? []), listener]);
      return () => listeners.set(atom, listeners.get(atom).filter((other) => other !== listener));
    },
    set(atom, value) {
      values.set(atom, value);
      for (const listener of listeners.get(atom) ?? []) listener(value);
    },
  };
}

const atom = (label) => ({ label: [label, "    at stack"] });
const presentation = (label, phase) => ({ entry: { target: { label } }, connection: { phase, error: null }, serverConfig: null });

test("t3: environments are read from T3's atom registry, found through the app's first element, with T3's reading of disconnected", () => {
  const presentations = atom("environment-presentations");
  const registry = atomRegistry(
    new Map([
      [atom("environment-presentation:local"), presentation("Local", "connected")],
      [
        presentations,
        new Map([
          ["local", presentation("Local", "connected")],
          ["starting", presentation("Starting", "connecting")],
          ["retrying", presentation("Retrying", "reconnecting")],
          ["off", presentation("Off", "offline")],
          ["idle", presentation("Idle", "available")],
          ["failed", presentation("Failed", "error")],
          ["old", presentation("Old", "unsupported")],
          ["future", presentation("Future", "some-new-phase")],
          ["bare", {}],
        ]),
      ],
    ]),
  );
  const app = fakeNode([{ className: "app" }, { value: { get() {} } }, { value: registry, children: {} }, {}]);
  const { extOf } = loadPage({ query: (selector) => (selector === "#root > *" ? app : null) });
  assert.deepEqual(JSON.parse(JSON.stringify(extOf("a").t3.environments.get())), [
    { environmentId: "local", label: "Local", phase: "connected", disconnected: false },
    { environmentId: "starting", label: "Starting", phase: "connecting", disconnected: false },
    { environmentId: "retrying", label: "Retrying", phase: "reconnecting", disconnected: true },
    { environmentId: "off", label: "Off", phase: "offline", disconnected: true },
    { environmentId: "idle", label: "Idle", phase: "available", disconnected: true },
    { environmentId: "failed", label: "Failed", phase: "error", disconnected: true },
    { environmentId: "old", label: "Old", phase: "unsupported", disconnected: true },
    { environmentId: "future", label: "Future", phase: "some-new-phase", disconnected: false },
    { environmentId: "bare", label: null, phase: null, disconnected: false },
  ]);

  assert.equal(loadPage().extOf("a").t3.environments.get(), null, "before React renders the app");
  const renamed = atomRegistry(new Map([[atom("environment-presentations-v2"), new Map()]]));
  const renamedApp = fakeNode([{}, { value: renamed }]);
  assert.equal(loadPage({ query: () => renamedApp }).extOf("a").t3.environments.get(), null, "an atom T3 renamed reads as not found");
});

test("t3: environment listeners hear the first find, then each change, an environment added later included", async () => {
  const presentations = atom("environment-presentations");
  const registry = atomRegistry(new Map([[presentations, new Map([["local", presentation("Local", "connected")]])]]));
  let app = null;
  const { extOf, timers } = loadPage({ query: () => app });
  const environments = extOf("a").t3.environments;
  let heard = 0;
  environments.subscribe(() => heard++);
  extOf("b").t3.environments.subscribe(() => {
    throw new Error("a broken listener");
  });
  assert.equal(environments.get(), null);

  app = fakeNode([{}, { value: registry }]);
  timers.shift()();
  await tick();
  assert.equal(heard, 1, "heard once T3's environments are found");

  registry.set(presentations, new Map([["local", presentation("Local", "connected")], ["linux", presentation("Linux box", "reconnecting")]]));
  assert.equal(heard, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(environments.get().map((environment) => [environment.environmentId, environment.disconnected]))),
    [["local", false], ["linux", true]],
  );
  assert.equal(timers.length, 0, "no more looking once found");
});

test("t3: rowOf reads the row's key and the shelf it sits in", () => {
  class Element {
    constructor(attributes, row) {
      this.attributes = attributes;
      this.row = row;
    }
    closest() {
      return this;
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    querySelector() {
      return this.row;
    }
  }
  const { extOf } = loadPage({ Element });
  const { rowOf } = extOf("a").t3;
  const row = (parent) => new Element({ "data-thread-item": "env-1:mcp:abc" }, parent === undefined ? null : new Element({ "data-sidebar-parent": parent }));
  assert.deepEqual({ ...rowOf(row("shelf:snoozed")), element: null }, { element: null, environmentId: "env-1", threadId: "mcp:abc", shelf: "snoozed" });
  assert.equal(rowOf(row("shelf:settled")).shelf, "settled");
  assert.equal(rowOf(row("project-folder:k1")).shelf, null, "a project folder is not a shelf");
  assert.equal(rowOf(row(null)).shelf, null);
  assert.equal(rowOf(row()).shelf, null, "a row T3 drew without a navigation row");
  assert.equal(rowOf({}), null);
});

test("request: finds the environment's socket among T3's RPC sockets, and settles with the server's reply", async () => {
  const { context, extOf } = loadPage();
  const request = extOf("a").t3.request;
  const [local, remote, other] = [new context.WebSocket(), new context.WebSocket(), new context.WebSocket()];
  const reply = (socket, message) => new context.MessageEvent(JSON.stringify(message), socket).data;
  const lastRequest = (socket) => JSON.parse(socket.sent.at(-1));

  const saved = request("env-remote", "server.getSettings");
  await tick();
  other.send("binary-ish stream frame");
  local.send(JSON.stringify({ _tag: "Ping" }));
  remote.send(JSON.stringify([{ _tag: "Request", id: "7", tag: "subscribeServerConfig", payload: {}, headers: [] }]));
  await tick();

  assert.equal(other.sent.length, 1, "a socket that never sent an RPC message is not asked");
  for (const [socket, environmentId] of [[local, "env-local"], [remote, "env-remote"]]) {
    const asked = lastRequest(socket);
    assert.equal(asked.tag, "server.getConfig");
    assert.ok(BigInt(asked.id) >= 2n ** 62n, "ids stay clear of T3's own counter");
    // The server splits a large frame into parts; all but the last start with a record separator.
    const frame = JSON.stringify({ _tag: "Exit", requestId: asked.id, exit: { _tag: "Success", value: { environment: { environmentId }, big: "x".repeat(40) } } });
    new context.MessageEvent("\u001e" + frame.slice(0, 30), socket).data;
    new context.MessageEvent("\u001e" + frame.slice(30, 60), socket).data;
    new context.MessageEvent(frame.slice(60), socket).data;
  }
  await tick();

  const asked = lastRequest(remote);
  assert.deepEqual([asked._tag, asked.tag, asked.payload, asked.headers], ["Request", "server.getSettings", {}, []]);
  assert.equal(lastRequest(local).tag, "server.getConfig", "only the matching environment's socket gets the request");
  reply(remote, { _tag: "Exit", requestId: "7", exit: { _tag: "Success", value: "T3's own reply" } });
  reply(remote, [{ _tag: "Exit", requestId: asked.id, exit: { _tag: "Success", value: { defaultThreadEnvMode: null } } }]);
  assert.equal(JSON.stringify(await saved), JSON.stringify({ defaultThreadEnvMode: null }));

  const refused = request("env-local", "server.updateSettings", { patch: {} });
  await tick();
  const update = lastRequest(local);
  assert.equal(update.tag, "server.updateSettings", "a known socket is not asked for its environment again");
  reply(local, { _tag: "Exit", requestId: update.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError", message: "lacks settings:write" } }] } });
  await assert.rejects(refused, /server\.updateSettings: lacks settings:write/);
});

test("request: rejects when no socket answers for the environment", async () => {
  const { context, extOf, timers } = loadPage();
  const realNow = Date.now;
  let now = realNow();
  context.Date = { now: () => now };
  const missing = extOf("a").t3.request("env-gone", "server.getSettings");
  await tick();
  now += 20_000;
  timers.splice(0).forEach((fn) => fn());
  await assert.rejects(missing, /no open connection to environment env-gone/);
});

// One socket of environment "env-a" that has answered its probe.
async function connectedSocket() {
  const loaded = loadPage();
  const { context, extOf } = loaded;
  const request = extOf("a").t3.request;
  const socket = new context.WebSocket();
  const reply = (message) => new context.MessageEvent(JSON.stringify(message), socket).data;
  const last = () => JSON.parse(socket.sent.at(-1));
  const first = request("env-a", "server.getSettings");
  await tick();
  socket.send(JSON.stringify({ _tag: "Ping" }));
  await tick();
  reply({ _tag: "Exit", requestId: last().id, exit: { _tag: "Success", value: { environment: { environmentId: "env-a" } } } });
  await tick();
  reply({ _tag: "Exit", requestId: last().id, exit: { _tag: "Success", value: {} } });
  await first;
  return { ...loaded, request, socket, reply, last };
}

test("request: a tag the server does not know fails at once, and is never sent to that environment again", async () => {
  const { request, socket, reply, last } = await connectedSocket();
  const mine = request("env-a", "server.renamedLater");
  const other = request("env-a", "server.getSettings");
  await tick();
  const sentBefore = socket.sent.length;
  reply({ _tag: "Defect", defect: "Unknown request tag: server.renamedLater" });
  await assert.rejects(mine, (error) => error.unknownTag === true && /server\.renamedLater/.test(error.message));
  reply({ _tag: "Exit", requestId: last().id, exit: { _tag: "Success", value: "still answered" } });
  assert.equal(await other, "still answered", "a Defect for another tag leaves this request open");
  await assert.rejects(request("env-a", "server.renamedLater"), (error) => error.unknownTag === true);
  assert.equal(socket.sent.length, sentBefore, "the unknown tag is not sent again");

  // T3's own server fails just that request instead.
  const removed = request("env-a", "server.removedLater");
  await tick();
  reply({ _tag: "Exit", requestId: last().id, exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "Unknown request tag: server.removedLater" }] } });
  await assert.rejects(removed, (error) => error.unknownTag === true);
  await assert.rejects(request("env-a", "server.removedLater"), (error) => error.unknownTag === true);
  assert.equal(JSON.parse(socket.sent.at(-1)).tag, "server.removedLater", "and it is not sent a second time");
  assert.equal(socket.sent.filter((frame) => frame.includes("server.removedLater")).length, 1);
});

test("request: subscriptions are refused, a closed socket fails its requests, and a timeout interrupts the request", async () => {
  const { request, socket, timers, last } = await connectedSocket();
  await assert.rejects(request("env-a", "subscribeServerConfig"), /not subscriptions/);
  await assert.rejects(request("env-a", "orchestration.subscribeShell"), /not subscriptions/);

  const slow = request("env-a", "server.updateSettings", { patch: {} });
  await tick();
  const id = last().id;
  timers.splice(0).forEach((fn) => fn());
  await assert.rejects(slow, /no reply after 15 s/);
  assert.deepEqual(JSON.parse(JSON.stringify(last())), { _tag: "Interrupt", requestId: id, interruptors: [] });

  const cut = request("env-a", "server.getSettings");
  await tick();
  socket.close();
  await assert.rejects(cut, /the connection closed/);
});

