import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface ProjectSettings {
  activePanelRatio: number
  collapsedWidthPx: number
  fileTreeWidth: number
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
  title?: string
}

interface InitialTabsResult {
  tabs: SessionTabInfo[]
  activeSessionId: string | null
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

interface ToolbarSplitter {
  type: 'splitter'
}

type ToolbarItem = ToolbarButton | ToolbarSplitter

interface ToolbarInfo {
  buttons: ToolbarItem[]
  projectType: string
  suggestedType: string | null
}

export interface EditorAPI {
  // Menu: notify main when a file is opened/closed (enables/disables Edit menu)
  notifyEditorFileChanged: (hasFile: boolean) => void
  // Menu: listen for edit commands triggered from the native menu
  onMenuEditCommand: (cb: (command: string) => void) => () => void

  getProjectPath: () => Promise<string | null>
  getProjectSettings: () => Promise<ProjectSettings>
  saveFileTreeWidth: (width: number) => Promise<void>
  saveLogPanelHeight: (height: number) => Promise<void>
  getReasoningConfig: () => Promise<{ showPanel: boolean }>
  getConfig: () => Promise<{
    editor: EditorConfig
    ui: { fileTreeWidthPx: number; logPanelExpandedHeightPx: number }
    toolbar: { sounds: { complete: Array<{ freq: number; dur: number; delay: number }>; error: Array<{ freq: number; dur: number; delay: number }>; completeAndWait: Array<{ freq: number; dur: number; delay: number }> } }
  }>

  // File tree
  readDir: (dirPath: string) => Promise<TreeNode[]>
  getGitStatus: () => Promise<GitStatusResult>
  onGitStatusUpdated: (cb: (status: GitStatusResult) => void) => () => void
  onFsChanged: (cb: (event: { path: string }) => void) => () => void

  // Editor file operations (sync)
  readFile: (filePath: string) => { content: string; mtime: number; size: number } | { error: string }
  writeFile: (filePath: string, content: string) => { mtime: number } | { error: string }
  gitShowHead: (relPath: string) => Promise<{ content: string } | { error: 'untracked' | 'other' }>

  // Terminal
  terminalCreateInitial: () => Promise<InitialTabsResult | null>
  saveOpenSessions: (projectPath: string, tabs: Array<{ sessionId: string; title: string }>, activeSessionId: string | null) => void
  terminalCreateNew: () => Promise<SessionTabInfo | null>
  terminalResumeSession: (sessionId: string) => Promise<SessionTabInfo | null>
  terminalWrite: (tabId: string, data: string) => void
  terminalResize: (tabId: string, cols: number, rows: number) => void
  terminalCloseTab: (tabId: string) => void
  terminalOpenSessionPicker: () => void
  onTerminalData: (cb: (tabId: string, data: string) => void) => () => void
  onTerminalTabTitle: (cb: (tabId: string, title: string) => void) => () => void
  onTerminalTabSessionId: (cb: (tabId: string, sessionId: string) => void) => () => void
  onTerminalTabExited: (cb: (tabId: string) => void) => () => void
  onTerminalTabReady: (cb: (tabId: string) => void) => () => void
  onTerminalDeadSession: (cb: (tabId: string, sessionId: string | null) => void) => () => void
  onTerminalSwitchTab: (cb: (tabId: string) => void) => () => void
  onTerminalNewTab: (cb: (tab: SessionTabInfo) => void) => () => void
  onTerminalTabClosed: (cb: (tabId: string) => void) => () => void
  onTerminalResetTabs: (cb: (tabs: { tabId: string; sessionId: string | null }[]) => void) => () => void
  onTerminalTabEvent: (cb: (tabId: string, event: string) => void) => () => void

  // Toolbar
  getToolbarInfo: () => Promise<ToolbarInfo>
  getToolbarPresets: () => Promise<ToolbarPresetGroup[]>
  toolbarSaveButtons: (buttons: ToolbarItem[]) => Promise<ToolbarItem[]>
  toolbarSetProjectType: (type: string) => Promise<void>
  toolbarRunButton: (buttonId: string) => Promise<{ success: boolean; error?: string }>
  toolbarKillButton: (buttonId: string) => Promise<void>
  toolbarKillRestartButton: (buttonId: string) => Promise<void>
  onToolbarOutput: (
    cb: (payload: { channelName: string; line: string; attention: boolean; flash: boolean }) => void
  ) => () => void
  onToolbarProcessStarted: (cb: (payload: { buttonId: string; clearChannels?: string[] }) => void) => () => void
  onToolbarProcessExited: (
    cb: (payload: { buttonId: string; exitCode: number | null }) => void
  ) => () => void
  onToolbarConfigUpdated: (cb: (buttons: ToolbarItem[]) => void) => () => void

  // CLI tools
  getCliTools: () => Promise<{ id: string; name: string }[]>

  // Accounts
  getAccountCurrentInfo: (toolId: string) => Promise<{ label: string; saved: boolean } | null>
  getUsageInfo: (toolId: string) => Promise<{ summary: string; tooltip: string; level: 'normal' | 'warn' | 'critical'; fetchedAt: number } | null>
  onCliLog: (cb: (channel: string, message: string) => void) => () => void
  onAccountsChanged: (cb: () => void) => () => void

  // PTY: create session with prompt
  terminalCreateWithPrompt: (toolId: string, prompt: string) => Promise<SessionTabInfo | null>

  // Drag & drop file path resolution (webUtils.getPathForFile, Electron 32+)
  getPathForFile: (file: File) => string

  // Shell / FS operations
  shellShowItemInFolder: (filePath: string) => Promise<void>
  fsDeleteFile: (filePath: string) => Promise<void>
  fsTrashFile: (filePath: string) => Promise<void>
  fsRenameFile: (oldPath: string, newPath: string) => Promise<void>
  fsCopyFile: (src: string, dest: string) => Promise<void>

  // Thinking panel
  thinkingGetBlock: (tabId: string, index: number | 'last') => Promise<{ thinking: string; index: number; total: number } | null>
  onThinkingUpdate: (cb: (tabId: string, total: number) => void) => () => void
  setPtyRawLog: (enabled: boolean) => Promise<void>

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
  notifyEditorFileChanged: (hasFile) => ipcRenderer.send('menu:editor-file-changed', hasFile),

  onMenuEditCommand: (cb: (command: string) => void) => {
    const handler = (_: unknown, command: string): void => cb(command)
    ipcRenderer.on('menu:edit-command', handler)
    return () => ipcRenderer.removeListener('menu:edit-command', handler)
  },

  getProjectPath: () => ipcRenderer.invoke('editor:get-project-path'),
  getProjectSettings: () => ipcRenderer.invoke('editor:get-project-settings'),
  saveFileTreeWidth: (width: number) => ipcRenderer.invoke('editor:save-file-tree-width', width),
  saveLogPanelHeight: (height: number) => ipcRenderer.invoke('editor:save-log-panel-height', height),
  getReasoningConfig: () => ipcRenderer.invoke('settings:get-reasoning'),
  getConfig: () => ipcRenderer.invoke('config:get'),

  readDir: (dirPath: string) => ipcRenderer.invoke('filetree:read-dir', dirPath),
  getGitStatus: () => ipcRenderer.invoke('filetree:git-status'),

  readFile: (filePath) => ipcRenderer.sendSync('editor:read-file-sync', filePath),
  writeFile: (filePath, content) => ipcRenderer.sendSync('editor:write-file-sync', filePath, content),
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
  saveOpenSessions: (projectPath: string, tabs: Array<{ sessionId: string; title: string }>, activeSessionId: string | null) =>
    ipcRenderer.send('state:save-open-sessions', { projectPath, tabs, activeSessionId }),
  terminalCreateNew: () => ipcRenderer.invoke('terminal:create-new'),
  terminalResumeSession: (sessionId) => ipcRenderer.invoke('terminal:resume-session', sessionId),
  terminalWrite: (tabId, data) => ipcRenderer.send('terminal:write', tabId, data),
  terminalResize: (tabId, cols, rows) => ipcRenderer.send('terminal:resize', tabId, cols, rows),
  terminalCloseTab: (tabId) => ipcRenderer.send('terminal:close-tab', tabId),
  terminalOpenSessionPicker: () => ipcRenderer.send('terminal:open-session-picker'),

  onTerminalData: (cb: (tabId: string, data: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string; data: string }): void =>
      cb(payload.tabId, payload.data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  onTerminalTabTitle: (cb: (tabId: string, title: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string; title: string }): void =>
      cb(payload.tabId, payload.title)
    ipcRenderer.on('terminal:tab-title', handler)
    return () => ipcRenderer.removeListener('terminal:tab-title', handler)
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

  onTerminalTabReady: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string }): void => cb(payload.tabId)
    ipcRenderer.on('terminal:tab-ready', handler)
    return () => ipcRenderer.removeListener('terminal:tab-ready', handler)
  },

  onTerminalDeadSession: (cb: (tabId: string, sessionId: string | null) => void) => {
    const handler = (_: unknown, payload: { tabId: string; sessionId: string | null }): void =>
      cb(payload.tabId, payload.sessionId)
    ipcRenderer.on('terminal:dead-session', handler)
    return () => ipcRenderer.removeListener('terminal:dead-session', handler)
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

  onTerminalTabClosed: (cb: (tabId: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string }): void => cb(payload.tabId)
    ipcRenderer.on('terminal:tab-closed', handler)
    return () => ipcRenderer.removeListener('terminal:tab-closed', handler)
  },

  onTerminalResetTabs: (cb: (tabs: { tabId: string; sessionId: string | null }[]) => void) => {
    const handler = (_: unknown, tabs: { tabId: string; sessionId: string | null }[]): void =>
      cb(tabs)
    ipcRenderer.on('terminal:reset-tabs', handler)
    return () => ipcRenderer.removeListener('terminal:reset-tabs', handler)
  },

  onTerminalTabEvent: (cb: (tabId: string, event: string) => void) => {
    const handler = (_: unknown, payload: { tabId: string; event: string }): void =>
      cb(payload.tabId, payload.event)
    ipcRenderer.on('terminal:tab-event', handler)
    return () => ipcRenderer.removeListener('terminal:tab-event', handler)
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
      payload: { channelName: string; line: string; attention: boolean; flash: boolean }
    ): void => cb(payload)
    ipcRenderer.on('toolbar:output', handler)
    return () => ipcRenderer.removeListener('toolbar:output', handler)
  },

  onToolbarProcessStarted: (cb) => {
    const handler = (_: unknown, payload: { buttonId: string; clearChannels?: string[] }): void => cb(payload)
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

  onToolbarConfigUpdated: (cb) => {
    const handler = (_: unknown, buttons: ToolbarButton[]): void => cb(buttons)
    ipcRenderer.on('toolbar:config-updated', handler)
    return () => ipcRenderer.removeListener('toolbar:config-updated', handler)
  },

  // CLI tools
  getCliTools: () => ipcRenderer.invoke('cli-tools:list'),

  // Accounts
  getAccountCurrentInfo: (toolId: string) =>
    ipcRenderer.invoke('accounts:get-current-info', toolId) as Promise<{ label: string; saved: boolean } | null>,
  getUsageInfo: (toolId: string) =>
    ipcRenderer.invoke('usage:get-info', toolId) as Promise<{ summary: string; tooltip: string; level: 'normal' | 'warn' | 'critical'; fetchedAt: number } | null>,
  onCliLog: (cb: (channel: string, message: string) => void): (() => void) => {
    const handler = (_e: unknown, data: { channel: string; message: string }): void =>
      cb(data.channel, data.message)
    ipcRenderer.on('cli:log', handler)
    return () => ipcRenderer.removeListener('cli:log', handler)
  },
  onAccountsChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('accounts:changed', handler)
    return () => ipcRenderer.removeListener('accounts:changed', handler)
  },

  // PTY: create session with prompt
  terminalCreateWithPrompt: (toolId, prompt) =>
    ipcRenderer.invoke('terminal:create-with-prompt', toolId, prompt),

  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Shell / FS operations
  shellShowItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item-in-folder', filePath),
  fsDeleteFile: (filePath) => ipcRenderer.invoke('fs:delete-file', filePath),
  fsTrashFile: (filePath) => ipcRenderer.invoke('fs:trash-file', filePath),
  fsRenameFile: (oldPath, newPath) => ipcRenderer.invoke('fs:rename-file', oldPath, newPath),
  fsCopyFile: (src, dest) => ipcRenderer.invoke('fs:copy-file', src, dest),

  // Thinking panel
  thinkingGetBlock: (tabId, index) => ipcRenderer.invoke('thinking:get-block', { tabId, index }),
  onThinkingUpdate: (cb) => {
    const handler = (_: unknown, payload: { tabId: string; total: number }): void =>
      cb(payload.tabId, payload.total)
    ipcRenderer.on('thinking:update', handler)
    return () => ipcRenderer.removeListener('thinking:update', handler)
  },
  setPtyRawLog: (enabled) => ipcRenderer.invoke('pty:set-raw-log', enabled),

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
