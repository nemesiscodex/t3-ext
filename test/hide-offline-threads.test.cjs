"use strict";

// examples/hide-offline-threads: renderer.js in a bare V8 context, with a stand-in for the
// sidebar's rows and for ext.t3.environments.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const RENDERER = fs.readFileSync(path.join(__dirname, "..", "examples", "hide-offline-threads", "renderer.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeElement {
  constructor(tag, attributes = {}) {
    this.nodeName = tag.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attributes));
    this.children = [];
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  // Only "tag[attribute]".
  matches(selector) {
    const [, tag, attribute] = selector.match(/^(\w*)\[([\w-]+)\]$/);
    return (!tag || this.nodeName === tag.toUpperCase()) && this.hasAttribute(attribute);
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

// The sidebar's rows, each "<environmentId>:<threadId>" with the shelf it sits in, or none.
// `environments` maps an environment id to its phase; the ones not "connected" are disconnected.
function sidebar({ rows, environments, hash = "" }) {
  const list = new FakeElement("ul");
  const elements = new Map();
  for (const [key, shelf] of Object.entries(rows)) {
    const element = new FakeElement("li", { "data-thread-item": key });
    element.children.push(new FakeElement("div", { "data-sidebar-row": key, ...(shelf ? { "data-sidebar-parent": `shelf:${shelf}` } : {}) }));
    list.children.push(element);
    elements.set(key, element);
  }
  const root = new FakeElement("html");
  root.children.push(list);

  const state = { environments };
  const listeners = [];
  const warnings = [];
  const windowListeners = {};
  let observer = null;
  const rowOf = (element) => {
    const item = element.getAttribute("data-thread-item");
    const parent = element.children[0].getAttribute("data-sidebar-parent") ?? "";
    return { element, environmentId: item.slice(0, item.indexOf(":")), threadId: item.slice(item.indexOf(":") + 1), shelf: parent.startsWith("shelf:") ? parent.slice(6) : null };
  };
  const location = { hash };
  const ext = {
    t3: {
      threadRows: () => root.querySelectorAll("[data-thread-item]").map(rowOf),
      openThread: () => {
        const match = location.hash.match(/^#\/([^/]+)\/([^/]+)/);
        return match ? { environmentId: match[1], threadId: match[2] } : null;
      },
      environments: {
        get: () => state.environments && Object.entries(state.environments).map(([environmentId, phase]) => ({ environmentId, label: environmentId, phase, disconnected: phase !== "connected" })),
        subscribe: (listener) => listeners.push(listener),
      },
    },
  };
  const context = vm.createContext({
    console: { warn: (...args) => warnings.push(args.join(" ")), error: (...args) => warnings.push(args.join(" ")) },
    location,
    document: { documentElement: root, querySelectorAll: (selector) => root.querySelectorAll(selector) },
    addEventListener: (type, listener) => (windowListeners[type] = listener),
    MutationObserver: class {
      constructor(callback) {
        observer = callback;
      }
      observe() {}
    },
  });
  context.window = context;
  vm.runInContext(`((extensionId, ext) => {\n${RENDERER}\n})`, context)("hide-offline-threads", ext);

  return {
    warnings,
    window: context,
    element: (key) => elements.get(key),
    hidden: () => [...elements].filter(([, element]) => element.hasAttribute("hidden")).map(([key]) => key),
    environmentsChange: async (next) => {
      state.environments = next;
      listeners.forEach((listener) => listener());
      await tick();
    },
    shelfChange: async (key, shelf) => {
      const row = elements.get(key).children[0];
      row.setAttribute("data-sidebar-parent", `shelf:${shelf}`);
      observer([{ type: "attributes", target: row, addedNodes: [] }]);
      await tick();
    },
    navigate: async (next) => {
      location.hash = next;
      windowListeners.hashchange();
      await tick();
    },
  };
}

const ROWS = { "linux:inbox": null, "linux:working": "working", "linux:snoozed": "snoozed", "linux:settled": "settled", "linux:open": null, "local:inbox": null, "unknown:inbox": null };

test("an inbox row of a disconnected environment is hidden; its snoozed, settled and open rows, and other environments' rows, are not", async () => {
  const page = sidebar({ rows: ROWS, environments: { linux: "offline", local: "connected" }, hash: "#/linux/open" });
  await tick();
  assert.deepEqual(page.hidden(), ["linux:inbox", "linux:working"]);
  assert.deepEqual([...page.window.t3HideOfflineThreads.disconnected], ["linux"]);
  assert.deepEqual([...page.window.t3HideOfflineThreads.hidden], ["linux:inbox", "linux:working"]);
});

test("rows show again when their environment connects, and hide when it drops", async () => {
  const page = sidebar({ rows: ROWS, environments: { linux: "reconnecting", local: "connected" } });
  await tick();
  assert.deepEqual(page.hidden(), ["linux:inbox", "linux:working", "linux:open"]);
  await page.environmentsChange({ linux: "connected", local: "connected" });
  assert.deepEqual(page.hidden(), []);
  await page.environmentsChange({ linux: "connected", local: "error" });
  assert.deepEqual(page.hidden(), ["local:inbox"]);
});

test("a row follows its shelf and the open thread", async () => {
  const page = sidebar({ rows: ROWS, environments: { linux: "offline" }, hash: "#/linux/open" });
  await tick();
  await page.shelfChange("linux:inbox", "snoozed");
  assert.deepEqual(page.hidden(), ["linux:working"]);
  await page.navigate("#/linux/working");
  assert.deepEqual(page.hidden(), ["linux:open"]);
});

test("a row T3 hid stays hidden when its environment connects", async () => {
  const page = sidebar({ rows: ROWS, environments: { linux: "offline" } });
  page.element("linux:snoozed").setAttribute("hidden", "");
  page.element("linux:inbox").setAttribute("hidden", "");
  await tick();
  await page.environmentsChange({ linux: "connected" });
  assert.deepEqual(page.hidden(), ["linux:inbox", "linux:snoozed"]);
});

test("when T3's environments cannot be read, every row shows, and it says so once", async () => {
  const page = sidebar({ rows: ROWS, environments: { linux: "offline" } });
  await tick();
  await page.environmentsChange(null);
  await page.environmentsChange(null);
  assert.deepEqual(page.hidden(), []);
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0], /^\[hide-offline-threads\] could not read T3's linked environments/);
});
