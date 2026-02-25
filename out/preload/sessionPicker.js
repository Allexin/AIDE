"use strict";
const electron = require("electron");
const sessionPickerApi = {
  getSessions: () => electron.ipcRenderer.invoke("session-picker:get-sessions"),
  switchTab: (tabId) => electron.ipcRenderer.send("session-picker:switch-tab", tabId),
  resumeSession: (sessionId) => electron.ipcRenderer.invoke("session-picker:resume-session", sessionId),
  newSession: () => electron.ipcRenderer.invoke("session-picker:new-session")
};
electron.contextBridge.exposeInMainWorld("sessionPickerApi", sessionPickerApi);
