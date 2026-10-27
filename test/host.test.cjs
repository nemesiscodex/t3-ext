"use strict";

// host/index.cjs against a stand-in for Electron's main-process API, for both the early start
// (paused before T3's code, app not ready) and the late one (attach into a running T3).

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { hostAnswers } = require("../host/presence.cjs");

const HOST = require.resolve("../host/index.cjs");
const STARTED = Symbol.for("t3ext.host.started");

function fakeMenu(labels) {
  const roles = { Window: "windowMenu", Help: "help" };
  const items = labels.map((label) => ({ label, role: roles[label] }));
  return {
    items,
    getMenuItemById: (id) => items.find((item) => item.id === id) ?? null,
    insert: (index, item) => items.splice(index, 0, item),
    append: (item) => items.push(item),
  };
}

function fakeContents(url) {
  const contents = new EventEmitter();
  Object.assign(contents, {
    reloads: 0,
    injected: [],
    sent: [],
    getURL: () => url,
    isDestroyed: () => false,
    send: (...message) => contents.sent.push(message),
    reload: () => contents.reloads++,
    insertCSS: async (css) => contents.injected.push(["css", css]),
    executeJavaScript: async (code) => contents.injected.push(["js", code]),
  });
  return contents;
}

function fakeElectron({ ready, contents = [], menu = null }) {
  let markReady;
  const whenReady = new Promise((resolve) => (markReady = resolve));
  const app = new EventEmitter();
  let isReady = ready;
  Object.assign(app, { isReady: () => isReady, whenReady: () => whenReady });
  const state = { preloads: [], handlers: new Map(), menu, menuSets: 0 };
  const electron = {
    app,
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null },
    dialog: {},
    shell: {},
    ipcMain: {
      handle: (channel, fn) => {
        if (state.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        state.handlers.set(channel, fn);
      },
    },
    Menu: {
      getApplicationMenu: () => state.menu,
      setApplicationMenu: (value) => {
        state.menu = value;
        state.menuSets++;
      },
    },
    MenuItem: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    session: { defaultSession: { registerPreloadScript: (script) => state.preloads.push(script) } },
    webContents: { getAllWebContents: () => contents },
  };
  const becomeReady = () => {
    isReady = true;
    markReady();
    return whenReady.then(() => {});
  };
  return { electron, state, becomeReady };
}

// A fresh host module and start guard for each test, with `electron` resolving to the fake.
function loadHost(t, electron) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3ext-host-"));
  fs.mkdirSync(path.join(home, "extensions"));
  fs.symlinkSync(path.join(__dirname, "fixtures", "sample"), path.join(home, "extensions", "sample"));
  const previousHome = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = home;
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? electron : load.call(this, request, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}host${path.sep}`) && !key.endsWith("presence.cjs")) delete require.cache[key];
  delete globalThis[STARTED];
  const host = require(HOST);
  t.after(() => {
    Module._load = load;
    delete globalThis[STARTED];
    if (previousHome === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { host, home };
}

test("late start reloads only T3 windows, re-sets the menu with Extensions, and injects on dom-ready", async (t) => {
  const appWindows = [fakeContents("t3code://app/index.html"), fakeContents("t3code://app/settings")];
  const webPage = fakeContents("https://example.com/");
  const { electron, state } = fakeElectron({ ready: true, contents: [...appWindows, webPage], menu: fakeMenu(["T3 Code", "File", "Window", "Help"]) });
  const { host, home } = loadHost(t, electron);

  assert.deepEqual(host.start(), { started: true, reloaded: 2 });
  assert.deepEqual(appWindows.map((contents) => contents.reloads), [1, 1]);
  assert.equal(webPage.reloads, 0, "a web page in the preview browser is left alone");
  assert.deepEqual(state.preloads, [{ type: "frame", filePath: path.join(path.dirname(HOST), "preload.cjs") }]);
  assert.equal(state.menuSets, 1, "the current menu is set again");
  assert.deepEqual(state.menu.items.map((item) => item.label), ["T3 Code", "File", "Extensions", "Window", "Help"]);
  assert.equal(await hostAnswers(process.pid), true, "the presence socket answers");

  appWindows[0].emit("dom-ready");
  webPage.emit("dom-ready");
  await new Promise((resolve) => setImmediate(resolve));
  const injected = appWindows[0].injected.map(([kind, code]) => `${kind}:${code.includes("__t3extSample") || code.includes("--t3ext-sample")}`);
  assert.ok(injected.includes("css:true") && injected.includes("js:true"), JSON.stringify(injected));
  assert.deepEqual(webPage.injected, [], "nothing is injected into web pages");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "sample-main-ran.json"), "utf8")).pid, process.pid, "main.js ran");
});

test("each renderer.js runs with its own folder name as extensionId", async (t) => {
  const appWindow = fakeContents("t3code://app/index.html");
  const { electron } = fakeElectron({ ready: true, contents: [appWindow] });
  const { host } = loadHost(t, electron);
  host.start();
  appWindow.emit("dom-ready");
  await new Promise((resolve) => setImmediate(resolve));
  const [, code] = appWindow.injected.find(([kind, code]) => kind === "js" && code.includes("__t3extSample"));
  const window = {};
  vm.runInNewContext(code, { window, console, Date });
  assert.equal(window.__t3extSample.id, "sample");
});

test("setConfig stores the value and sends it to every T3 window, and nowhere else", async (t) => {
  const appWindows = [fakeContents("t3code://app/index.html"), fakeContents("t3code://app/settings")];
  const webPage = fakeContents("https://example.com/");
  const { electron, state } = fakeElectron({ ready: true, contents: [...appWindows, webPage] });
  const { host, home } = loadHost(t, electron);
  host.start();
  const fromApp = { senderFrame: { url: "t3code://app/index.html" }, sender: appWindows[0] };
  const setConfig = state.handlers.get("t3ext:setConfig");
  const getConfig = state.handlers.get("t3ext:getConfig");

  assert.equal(await getConfig(fromApp, "sample"), null);
  assert.deepEqual(await setConfig(fromApp, "sample", { on: true, skip: undefined }), { on: true });
  const message = ["t3ext:config", "sample", { on: true }];
  assert.deepEqual(appWindows.map((contents) => contents.sent), [[message], [message]], "the sender and the other T3 window");
  assert.deepEqual(webPage.sent, [], "a web page in the preview browser hears nothing");
  assert.deepEqual(await getConfig(fromApp, "sample"), { on: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "extensions.json"), "utf8")).config, { sample: { on: true } });

  assert.throws(() => setConfig({ senderFrame: { url: "https://example.com/" } }, "sample", 1), /only available to T3 Code windows/);
  assert.throws(() => setConfig(fromApp, "nope", 1), /No extension with id "nope"/);
  assert.equal(appWindows[0].sent.length, 1, "a refused call sends nothing");
});

test("a second start changes nothing: no reload, no second IPC handler, no second menu", (t) => {
  const appWindow = fakeContents("t3code://app/index.html");
  const { electron, state } = fakeElectron({ ready: true, contents: [appWindow], menu: fakeMenu(["File", "Window"]) });
  const { host } = loadHost(t, electron);
  host.start();
  assert.deepEqual(host.start(), { started: false, reloaded: 0 });
  assert.equal(appWindow.reloads, 1);
  assert.equal(state.menuSets, 1);
  assert.equal(state.menu.items.filter((item) => item.label === "Extensions").length, 1);
});

test("early start, before the app is ready, reloads nothing and registers the preload at ready", async (t) => {
  const { electron, state, becomeReady } = fakeElectron({ ready: false });
  const { host } = loadHost(t, electron);
  assert.deepEqual(host.start(), { started: true, reloaded: 0 });
  assert.deepEqual(state.preloads, [], "no session before ready");
  await becomeReady();
  assert.equal(state.preloads.length, 1);
  electron.Menu.setApplicationMenu(fakeMenu(["T3 Code", "Help"]));
  assert.deepEqual(state.menu.items.map((item) => item.label), ["T3 Code", "Extensions", "Help"], "T3's own menu gets Extensions when T3 sets it");
  const later = fakeContents("t3code://app/index.html");
  electron.app.emit("web-contents-created", {}, later);
  later.emit("dom-ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(later.injected.length > 0, "windows created later get the injected parts");
});
