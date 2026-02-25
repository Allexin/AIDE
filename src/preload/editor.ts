import { contextBridge, ipcRenderer } from 'electron'

export interface ProjectSettings {
  activePanelRatio: number
  collapsedWidthPx: number
}

// Matches TreeNode in env.d.ts
interface TreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
}

// Matches GitStatusResult in env.d.ts
interface GitStatusResult {
  available: boolean
  changed: string[]
  deleted: string[]
}

interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  slug: string
}

export interface EditorAPI {
  getProjectPath: () => Promise<string | null>
  getProjectSettings: () => Promise<ProjectSettings>
  getConfig: () => Promise<{
    ui: { fileTreeWidthPx: number; logPanelExpandedHeightPx: number }
  }>

  // File tree
  readDir: (dirPath: string) => Promise<TreeNode[]>
  getGitStatus: () => Promise<GitStatusResult>
  onGitStatusUpdated: (cb: (status: GitStatusResult) => void) => () => void
  onFsChanged: (cb: (event: { path: string }) => void) => () => void

  // Terminal
  terminalCreateInitial: () => Promise<SessionTabInfo | null>
  terminalCreateNew: () => Promise<SessionTabInfo | null>
  terminalResumeSession: (sessionId: string) => Promise<SessionTabInfo | null>
  terminalWrite: (tabId: string, data: string) => void
  terminalResize: (tabId: string, cols: number, rows: number) => void
  terminalOpenSessionPicker: () => void
  onTerminalData: (cb: (tabId: string, data: string) => void) => () => void
  onTerminalTabSlugUpdated: (cb: (tabId: string, slug: string) => void) => () => void
  onTerminalTabSessionId: (cb: (tabId: string, sessionId: string) => void) => () => void
  onTerminalTabExited: (cb: (tabId: string) => void) => () => void
  onTerminalSwitchTab: (cb: (tabId: string) => void) => () => void
  onTerminalNewTab: (cb: (tab: SessionTabInfo) => void) => () => void
}

const editorApi: EditorAPI = {
  getProjectPath: () => ipcRenderer.invoke('editor:get-project-path'),
  getProjectSettings: () => ipcRenderer.invoke('editor:get-project-settings'),
  getConfig: () => ipcRenderer.invoke('config:get'),

  readDir: (dirPath: string) => ipcRenderer.invoke('filetree:read-dir', dirPath),
  getGitStatus: () => ipcRenderer.invoke('filetree:git-status'),

  onGitStatusUpdated: (cb: (status: GitStatusResult) => void) => {
    const handler = (_: unknown, status: GitStatusResult): void => cb(status)
    ipcRenderer.on('filetree:git-status-updated', handler)
    return () => ipcRenderer.removeListener('filetree:git-status-updated', handler)
  },

  onFsChanged: (cb: (event: { path: string }) => void) => {
    const handler = (_: unknown, event: { path: string }): void => cb(event)
    ipcRenderer.on('filetree:fs-changed', handler)
    return () => ipcRenderer.removeListener('filetree:fs-changed', handler)
  },

  // Terminal
  terminalCreateInitial: () => ipcRenderer.invoke('terminal:create-initial'),
  terminalCreateNew: () => ipcRenderer.invoke('terminal:create-new'),
  terminalResumeSession: (sessionId) => ipcRenderer.invoke('terminal:resume-session', sessionId),
  terminalWrite: (tabId, data) => ipcRenderer.send('terminal:write', tabId, data),
  terminalResize: (tabId, cols, rows) => ipcRenderer.send('terminal:resize', tabId, cols, rows),
  terminalOpenSessionPicker: () => ipcRenderer.send('terminal:open-session-picker'),

  onTerminalData: (cb: (tabId: string, data: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string; data: string }): void =>
      cb(payload.tabId, payload.data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  onTerminalTabSlugUpdated: (cb: (tabId: string, slug: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string; slug: string }): void =>
      cb(payload.tabId, payload.slug)
    ipcRenderer.on('terminal:tab-slug-updated', handler)
    return () => ipcRenderer.removeListener('terminal:tab-slug-updated', handler)
  },

  onTerminalTabSessionId: (cb: (tabId: string, sessionId: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string; sessionId: string }): void =>
      cb(payload.tabId, payload.sessionId)
    ipcRenderer.on('terminal:tab-session-id', handler)
    return () => ipcRenderer.removeListener('terminal:tab-session-id', handler)
  },

  onTerminalTabExited: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string }): void => cb(payload.tabId)
    ipcRenderer.on('terminal:tab-exited', handler)
    return () => ipcRenderer.removeListener('terminal:tab-exited', handler)
  },

  onTerminalSwitchTab: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string }): void => cb(payload.tabId)
    ipcRenderer.on('terminal:switch-tab', handler)
    return () => ipcRenderer.removeListener('terminal:switch-tab', handler)
  },

  onTerminalNewTab: (cb: (tab: SessionTabInfo) => void) => {
    const handler = (_: unknown, tab: SessionTabInfo): void => cb(tab)
    ipcRenderer.on('terminal:new-tab', handler)
    return () => ipcRenderer.removeListener('terminal:new-tab', handler)
  }
}

contextBridge.exposeInMainWorld('editorApi', editorApi)
