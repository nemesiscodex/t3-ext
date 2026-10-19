"use strict";

const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { createRegistry } = require("./registry.cjs");

const { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, session, shell } = electron;
const APP_SCHEME = "t3code:";
const MANAGER_ID = "builtin:extension-manager";
const MENU_ID = "t3ext-menu";

function isAppUrl(url) {
  return typeof url === "string" && url.startsWith(`${APP_SCHEME}//`);
}

function start() {
  const registry = createRegistry({ builtinDir: path.join(__dirname, "builtin") });

  registerIpc(registry);
  wrapApplicationMenu(registry);
  app.on("web-contents-created", (_event, contents) => {
    contents.on("dom-ready", () => {
      if (isAppUrl(contents.getURL())) injectRenderers(registry, contents);
    });
  });
  app.whenReady().then(() => registerPreload(session.defaultSession));
  loadMains(registry);
}

function registerPreload(ses) {
  const filePath = path.join(__dirname, "preload.cjs");
  if (typeof ses.registerPreloadScript === "function") ses.registerPreloadScript({ type: "frame", filePath });
  else ses.setPreloads([...ses.getPreloads(), filePath]);
}

function loadMains(registry) {
  for (const extension of registry.list()) {
    if (!extension.enabled || !extension.parts.main || !extension.manifest) continue;
    const report = (error) => {
      console.error(`[t3ext] ${extension.id}/main.js failed`, error);
      registry.recordError(extension.id, "main.js", error?.stack ?? error);
    };
    try {
      const exported = require(path.join(extension.dir, "main.js"));
      const activate = typeof exported === "function" ? exported : exported?.default;
      if (typeof activate === "function") {
        Promise.resolve(activate({ id: extension.id, dir: extension.dir, electron })).catch(report);
      }
    } catch (error) {
      report(error);
    }
  }
}

const PAGE_PARTS = [
  { part: "style", file: "style.css", inject: (contents, _id, css) => contents.insertCSS(css) },
  {
    part: "renderer",
    file: "renderer.js",
    inject: (contents, id, code) =>
      contents.executeJavaScript(
        `(() => { try {\n${code}\n} catch (error) { console.error("[t3ext]", ${JSON.stringify(id)}, error); } })();\n//# sourceURL=t3ext/${id.replace(":", "/")}/renderer.js`,
      ),
  },
];

// Each part of each extension fails on its own; the rest still load.
function injectRenderers(registry, contents) {
  for (const extension of registry.list()) {
    if (!extension.enabled || !extension.manifest) continue;
    for (const { part, file, inject } of PAGE_PARTS) {
      if (!extension.parts[part]) continue;
      const report = (error) => {
        console.error(`[t3ext] ${extension.id}/${file} failed`, error);
        registry.recordError(extension.id, file, error?.message ?? error);
      };
      try {
        inject(contents, extension.id, fs.readFileSync(path.join(extension.dir, file), "utf8")).then(
          () => registry.recordError(extension.id, file, null),
          report,
        );
      } catch (error) {
        report(error);
      }
    }
  }
}

function registerIpc(registry) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isAppUrl(event.senderFrame?.url)) throw new Error(`${channel} is only available to T3 Code windows`);
      return fn(event, ...args);
    });
  };

  handle("t3ext:list", () => registry.list());
  handle("t3ext:setEnabled", (_event, id, enabled) => registry.setEnabled(String(id), Boolean(enabled)));
  handle("t3ext:remove", async (_event, id) => {
    const extension = registry.get(String(id));
    if (extension.builtin) throw new Error(`${extension.id} is built in and cannot be removed. Disable it instead.`);
    await shell.trashItem(extension.dir);
    registry.forget(extension.id);
    return registry.list();
  });
  handle("t3ext:add", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: "Add Extension",
      buttonLabel: "Add Extension",
      message: "Choose an extension folder (it must contain manifest.json)",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return registry.add(result.filePaths[0]);
  });
  handle("t3ext:openFolder", async (_event, id) => {
    const dir = id == null ? registry.extensionsDir : registry.get(String(id)).dir;
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });
}

function wrapApplicationMenu(registry) {
  const setApplicationMenu = Menu.setApplicationMenu.bind(Menu);
  Menu.setApplicationMenu = (menu) => {
    if (menu && !menu.getMenuItemById(MENU_ID)) {
      const index = menu.items.findIndex((item) => ["windowmenu", "help"].includes(String(item.role).toLowerCase()));
      const item = new MenuItem(extensionsMenu(registry));
      if (index === -1) menu.append(item);
      else menu.insert(index, item);
    }
    return setApplicationMenu(menu);
  };
}

function appContents(window) {
  const candidates = [window, BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()];
  return candidates.find((candidate) => candidate && !candidate.isDestroyed() && isAppUrl(candidate.webContents.getURL()))?.webContents;
}

function extensionsMenu(registry) {
  return {
    id: MENU_ID,
    label: "Extensions",
    submenu: [
      {
        label: "Manage Extensions…",
        click: async (_item, window) => {
          const contents = appContents(window);
          if (!contents) return;
          const manager = registry.list().find((extension) => extension.id === MANAGER_ID);
          if (manager && !manager.enabled) {
            const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(contents), {
              type: "question",
              message: "The extension manager is disabled",
              detail: "Enable it and reload the window?",
              buttons: ["Enable and Reload", "Cancel"],
              defaultId: 0,
              cancelId: 1,
            });
            if (response !== 0) return;
            registry.setEnabled(MANAGER_ID, true);
            contents.once("dom-ready", () => setTimeout(() => openManager(contents), 0));
            contents.reload();
            return;
          }
          openManager(contents);
        },
      },
      {
        label: "Open Extensions Folder",
        click: () => {
          fs.mkdirSync(registry.extensionsDir, { recursive: true });
          shell.openPath(registry.extensionsDir);
        },
      },
      { type: "separator" },
      {
        label: "Reload Window",
        click: (_item, window) => appContents(window)?.reload(),
      },
    ],
  };
}

function openManager(contents) {
  contents.executeJavaScript('window.dispatchEvent(new CustomEvent("t3ext:manage"))').catch(() => {});
}

module.exports = { start };
