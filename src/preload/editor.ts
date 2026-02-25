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

export interface EditorConfig {
  maxFileSizeMb: number
  fontFamily: string
  fontSize: number
  minimap: boolean
  wordWrap: string
  lineNumbers: string
  tabSize: number
}

interface ToolbarButton {
  id: string
  icon: string
  tooltip: string
  command: string
  cwd?: string
  channels?: {
    stdout?: { name: string; attention?: boolean }
    stderr?: { name: string; attention?: boolean }
  }
}

interface ToolbarPresetGroup {
  type: string
  label: string
  buttons: ToolbarButton[]
}

interface ToolbarInfo {
  buttons: ToolbarButton[]
  projectType: string
  suggestedType: string | null
}

export interface EditorAPI {
  getProjectPath: () => Promise<string | null>
  getProjectSettings: () => Promise<ProjectSettings>
  getConfig: () => Promise<{
    editor: EditorConfig
    ui: { fileTreeWidthPx: number; logPanelExpandedHeightPx: number }
  }>

  // File tree
  readDir: (dirPath: string) => Promise<TreeNode[]>
  getGitStatus: () => Promise<GitStatusResult>
  onGitStatusUpdated: (cb: (status: GitStatusResult) => void) => () => void
  onFsChanged: (cb: (event: { path: string }) => void) => () => void

  // Editor file operations
  readFile: (filePath: string) => Promise<{ content: string; mtime: number; size: number }>
  writeFile: (filePath: string, content: string) => Promise<{ mtime: number }>
  gitShowHead: (relPath: string) => Promise<{ content: string } | { error: 'untracked' | 'other' }>

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

  // Toolbar
  getToolbarInfo: () => Promise<ToolbarInfo>
  getToolbarPresets: () => Promise<ToolbarPresetGroup[]>
  toolbarSaveButtons: (buttons: ToolbarButton[]) => Promise<ToolbarButton[]>
  toolbarSetProjectType: (type: string) => Promise<void>
  toolbarRunButton: (buttonId: string) => Promise<{ success: boolean; error?: string }>
  toolbarKillButton: (buttonId: string) => Promise<void>
  toolbarKillRestartButton: (buttonId: string) => Promise<void>
  onToolbarOutput: (
    cb: (payload: { channelName: string; line: string; attention: boolean }) => void
  ) => () => void
  onToolbarProcessStarted: (cb: (payload: { buttonId: string }) => void) => () => void
  onToolbarProcessExited: (
    cb: (payload: { buttonId: string; exitCode: number | null }) => void
  ) => () => void

  // Git commit
  gitGetCommitFiles: () => Promise<{
    available: boolean
    changed: string[]
    deleted: string[]
    untracked: string[]
    truncated: boolean
  }>
  gitRunCommit: (
    files: string[],
    message: string,
    stageAll?: boolean
  ) => Promise<{ success: boolean; error?: string }>
  onGitCommitOutput: (
    cb: (payload: { line: string; stream: 'stdout' | 'stderr' }) => void
  ) => () => void
}

const editorApi: EditorAPI = {
  getProjectPath: () => ipcRenderer.invoke('editor:get-project-path'),
  getProjectSettings: () => ipcRenderer.invoke('editor:get-project-settings'),
  getConfig: () => ipcRenderer.invoke('config:get'),

  readDir: (dirPath: string) => ipcRenderer.invoke('filetree:read-dir', dirPath),
  getGitStatus: () => ipcRenderer.invoke('filetree:git-status'),

  readFile: (filePath) => ipcRenderer.invoke('editor:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('editor:write-file', filePath, content),
  gitShowHead: (relPath) => ipcRenderer.invoke('editor:git-show-head', relPath),

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
  },

  // Toolbar
  getToolbarInfo: () => ipcRenderer.invoke('toolbar:get-info'),
  getToolbarPresets: () => ipcRenderer.invoke('toolbar:get-presets'),
  toolbarSaveButtons: (buttons) => ipcRenderer.invoke('toolbar:save-buttons', buttons),
  toolbarSetProjectType: (type) => ipcRenderer.invoke('toolbar:set-project-type', type),
  toolbarRunButton: (buttonId) => ipcRenderer.invoke('toolbar:run-button', buttonId),
  toolbarKillButton: (buttonId) => ipcRenderer.invoke('toolbar:kill-button', buttonId),
  toolbarKillRestartButton: (buttonId) =>
    ipcRenderer.invoke('toolbar:kill-restart-button', buttonId),

  onToolbarOutput: (cb) => {
    const handler = (
      _: unknown,
      payload: { channelName: string; line: string; attention: boolean }
    ): void => cb(payload)
    ipcRenderer.on('toolbar:output', handler)
    return () => ipcRenderer.removeListener('toolbar:output', handler)
  },

  onToolbarProcessStarted: (cb) => {
    const handler = (_: unknown, payload: { buttonId: string }): void => cb(payload)
    ipcRenderer.on('toolbar:process-started', handler)
    return () => ipcRenderer.removeListener('toolbar:process-started', handler)
  },

  onToolbarProcessExited: (cb) => {
    const handler = (
      _: unknown,
      payload: { buttonId: string; exitCode: number | null }
    ): void => cb(payload)
    ipcRenderer.on('toolbar:process-exited', handler)
    return () => ipcRenderer.removeListener('toolbar:process-exited', handler)
  },

  // Git commit
  gitGetCommitFiles: () => ipcRenderer.invoke('git:get-commit-files'),

  gitRunCommit: (files, message, stageAll) =>
    ipcRenderer.invoke('git:run-commit', { files, message, stageAll }),

  onGitCommitOutput: (cb) => {
    const handler = (
      _: unknown,
      payload: { line: string; stream: 'stdout' | 'stderr' }
    ): void => cb(payload)
    ipcRenderer.on('git:commit-output', handler)
    return () => ipcRenderer.removeListener('git:commit-output', handler)
  }
}

contextBridge.exposeInMainWorld('editorApi', editorApi)
