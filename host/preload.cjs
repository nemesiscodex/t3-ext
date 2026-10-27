"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "t3code:") {
  contextBridge.exposeInMainWorld("t3ext", {
    list: () => ipcRenderer.invoke("t3ext:list"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("t3ext:setEnabled", id, enabled),
    remove: (id) => ipcRenderer.invoke("t3ext:remove", id),
    add: () => ipcRenderer.invoke("t3ext:add"),
    openFolder: (id) => ipcRenderer.invoke("t3ext:openFolder", id),
    getConfig: (id) => ipcRenderer.invoke("t3ext:getConfig", id),
    setConfig: (id, value) => ipcRenderer.invoke("t3ext:setConfig", id, value),
    // The IPC event object stays on this side of the bridge.
    onConfigChange: (listener) => {
      const forward = (_event, id, value) => listener(id, value);
      ipcRenderer.on("t3ext:config", forward);
      return () => ipcRenderer.removeListener("t3ext:config", forward);
    },
  });
}
