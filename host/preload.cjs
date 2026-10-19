"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "t3code:") {
  contextBridge.exposeInMainWorld("t3ext", {
    list: () => ipcRenderer.invoke("t3ext:list"),
    setEnabled: (id, enabled) => ipcRenderer.invoke("t3ext:setEnabled", id, enabled),
    remove: (id) => ipcRenderer.invoke("t3ext:remove", id),
    add: () => ipcRenderer.invoke("t3ext:add"),
    openFolder: (id) => ipcRenderer.invoke("t3ext:openFolder", id),
  });
}
