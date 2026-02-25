"use strict";
const electron = require("electron");
const pickerApi = {
  selectFolder: () => electron.ipcRenderer.invoke("pick:select-folder"),
  openProject: (path) => electron.ipcRenderer.invoke("project:open", path),
  getState: () => electron.ipcRenderer.invoke("state:get"),
  validatePath: (path) => electron.ipcRenderer.invoke("path:validate", path),
  removeRecentProject: (path) => electron.ipcRenderer.invoke("state:remove-recent", path)
};
electron.contextBridge.exposeInMainWorld("pickerApi", pickerApi);
