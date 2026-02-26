"use strict";
const electron = require("electron");
const editorApi = {
  notifyEditorFileChanged: (hasFile) => electron.ipcRenderer.send("menu:editor-file-changed", hasFile),
  onMenuEditCommand: (cb) => {
    const handler = (_, command) => cb(command);
    electron.ipcRenderer.on("menu:edit-command", handler);
    return () => electron.ipcRenderer.removeListener("menu:edit-command", handler);
  },
  getProjectPath: () => electron.ipcRenderer.invoke("editor:get-project-path"),
  getProjectSettings: () => electron.ipcRenderer.invoke("editor:get-project-settings"),
  getConfig: () => electron.ipcRenderer.invoke("config:get"),
  readDir: (dirPath) => electron.ipcRenderer.invoke("filetree:read-dir", dirPath),
  getGitStatus: () => electron.ipcRenderer.invoke("filetree:git-status"),
  readFile: (filePath) => electron.ipcRenderer.invoke("editor:read-file", filePath),
  writeFile: (filePath, content) => electron.ipcRenderer.invoke("editor:write-file", filePath, content),
  gitShowHead: (relPath) => electron.ipcRenderer.invoke("editor:git-show-head", relPath),
  onGitStatusUpdated: (cb) => {
    const handler = (_, status) => cb(status);
    electron.ipcRenderer.on("filetree:git-status-updated", handler);
    return () => electron.ipcRenderer.removeListener("filetree:git-status-updated", handler);
  },
  onFsChanged: (cb) => {
    const handler = (_, event) => cb(event);
    electron.ipcRenderer.on("filetree:fs-changed", handler);
    return () => electron.ipcRenderer.removeListener("filetree:fs-changed", handler);
  },
  // Terminal
  terminalCreateInitial: () => electron.ipcRenderer.invoke("terminal:create-initial"),
  terminalCreateNew: () => electron.ipcRenderer.invoke("terminal:create-new"),
  terminalResumeSession: (sessionId) => electron.ipcRenderer.invoke("terminal:resume-session", sessionId),
  terminalWrite: (tabId, data) => electron.ipcRenderer.send("terminal:write", tabId, data),
  terminalResize: (tabId, cols, rows) => electron.ipcRenderer.send("terminal:resize", tabId, cols, rows),
  terminalOpenSessionPicker: () => electron.ipcRenderer.send("terminal:open-session-picker"),
  onTerminalData: (cb) => {
    const handler = (_, payload) => cb(payload.tabId, payload.data);
    electron.ipcRenderer.on("terminal:data", handler);
    return () => electron.ipcRenderer.removeListener("terminal:data", handler);
  },
  onTerminalTabSlugUpdated: (cb) => {
    const handler = (_, payload) => cb(payload.tabId, payload.slug);
    electron.ipcRenderer.on("terminal:tab-slug-updated", handler);
    return () => electron.ipcRenderer.removeListener("terminal:tab-slug-updated", handler);
  },
  onTerminalTabSessionId: (cb) => {
    const handler = (_, payload) => cb(payload.tabId, payload.sessionId);
    electron.ipcRenderer.on("terminal:tab-session-id", handler);
    return () => electron.ipcRenderer.removeListener("terminal:tab-session-id", handler);
  },
  onTerminalTabExited: (cb) => {
    const handler = (_, payload) => cb(payload.tabId);
    electron.ipcRenderer.on("terminal:tab-exited", handler);
    return () => electron.ipcRenderer.removeListener("terminal:tab-exited", handler);
  },
  onTerminalSwitchTab: (cb) => {
    const handler = (_, payload) => cb(payload.tabId);
    electron.ipcRenderer.on("terminal:switch-tab", handler);
    return () => electron.ipcRenderer.removeListener("terminal:switch-tab", handler);
  },
  onTerminalNewTab: (cb) => {
    const handler = (_, tab) => cb(tab);
    electron.ipcRenderer.on("terminal:new-tab", handler);
    return () => electron.ipcRenderer.removeListener("terminal:new-tab", handler);
  },
  // Toolbar
  getToolbarInfo: () => electron.ipcRenderer.invoke("toolbar:get-info"),
  getToolbarPresets: () => electron.ipcRenderer.invoke("toolbar:get-presets"),
  toolbarSaveButtons: (buttons) => electron.ipcRenderer.invoke("toolbar:save-buttons", buttons),
  toolbarSetProjectType: (type) => electron.ipcRenderer.invoke("toolbar:set-project-type", type),
  toolbarRunButton: (buttonId) => electron.ipcRenderer.invoke("toolbar:run-button", buttonId),
  toolbarKillButton: (buttonId) => electron.ipcRenderer.invoke("toolbar:kill-button", buttonId),
  toolbarKillRestartButton: (buttonId) => electron.ipcRenderer.invoke("toolbar:kill-restart-button", buttonId),
  onToolbarOutput: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on("toolbar:output", handler);
    return () => electron.ipcRenderer.removeListener("toolbar:output", handler);
  },
  onToolbarProcessStarted: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on("toolbar:process-started", handler);
    return () => electron.ipcRenderer.removeListener("toolbar:process-started", handler);
  },
  onToolbarProcessExited: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on("toolbar:process-exited", handler);
    return () => electron.ipcRenderer.removeListener("toolbar:process-exited", handler);
  },
  // Shell / FS operations
  shellShowItemInFolder: (filePath) => electron.ipcRenderer.invoke("shell:show-item-in-folder", filePath),
  fsDeleteFile: (filePath) => electron.ipcRenderer.invoke("fs:delete-file", filePath),
  fsTrashFile: (filePath) => electron.ipcRenderer.invoke("fs:trash-file", filePath),
  fsRenameFile: (oldPath, newPath) => electron.ipcRenderer.invoke("fs:rename-file", oldPath, newPath),
  fsCopyFile: (src, dest) => electron.ipcRenderer.invoke("fs:copy-file", src, dest),
  // Git commit
  gitGetCommitFiles: () => electron.ipcRenderer.invoke("git:get-commit-files"),
  gitRunCommit: (files, message, stageAll) => electron.ipcRenderer.invoke("git:run-commit", { files, message, stageAll }),
  onGitCommitOutput: (cb) => {
    const handler = (_, payload) => cb(payload);
    electron.ipcRenderer.on("git:commit-output", handler);
    return () => electron.ipcRenderer.removeListener("git:commit-output", handler);
  }
};
electron.contextBridge.exposeInMainWorld("editorApi", editorApi);
