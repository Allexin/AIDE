/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface RecentProject {
  path: string
  lastOpened: string // ISO 8601
}

interface PickerAPI {
  selectFolder: () => Promise<string | null>
  openProject: (path: string) => Promise<{ success: true } | { success: false; error: string }>
  getState: () => Promise<{ recentProjects: RecentProject[] }>
  validatePath: (path: string) => Promise<boolean>
  removeRecentProject: (path: string) => Promise<void>
}

interface ProjectSettings {
  activePanelRatio: number
  collapsedWidthPx: number
}

// A node in the file tree — file or directory.
interface TreeNode {
  name: string
  path: string // absolute OS path (backslashes on Windows)
  relativePath: string // relative from project root, forward slashes (matches git output)
  type: 'file' | 'directory'
}

// Result of running git status --porcelain.
interface GitStatusResult {
  available: boolean
  changed: string[]   // relative forward-slash paths of tracked changed files
  deleted: string[]   // relative forward-slash paths of deleted files
  untracked: string[] // relative forward-slash paths of untracked files (??)
  branch: string | null // current branch name; null if git unavailable
}

// A Claude Code session as stored on disk.
interface DiskSession {
  sessionId: string
  title: string // from .aide/Titles/{id}.txt, defaults to 'Claude Code'
  mtime: number // ms since epoch
}

// A terminal session tab (open in the editor).
interface SessionTabInfo {
  tabId: string
  sessionId: string | null // null until .jsonl appears (new sessions)
}

interface EditorConfig {
  maxFileSizeMb: number
  fontFamily: string
  fontSize: number
  minimap: boolean
  wordWrap: string
  lineNumbers: string
  tabSize: number
}

interface ToolbarChannel {
  name: string
  attention?: boolean
}

interface ToolbarButton {
  id: string
  icon: string
  tooltip: string
  command: string
  cwd?: string
  channels?: {
    stdout?: ToolbarChannel
    stderr?: ToolbarChannel
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

interface EditorAPI {
  // Menu
  notifyEditorFileChanged: (hasFile: boolean) => void
  onMenuEditCommand: (cb: (command: string) => void) => () => void

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
  readFile: (filePath: string) => { content: string; mtime: number; size: number } | { error: string }
  writeFile: (filePath: string, content: string) => { mtime: number } | { error: string }
  gitShowHead: (relPath: string) => Promise<{ content: string } | { error: 'untracked' | 'other' }>

  // Terminal
  terminalCreateInitial: () => Promise<SessionTabInfo | null>
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
  onToolbarConfigUpdated: (cb: (buttons: ToolbarButton[]) => void) => () => void

  // CLI tools
  getCliTools: () => Promise<{ id: string; name: string }[]>

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

  // Git commit
  gitGetCommitFiles: () => Promise<{
    available: boolean
    changed: string[]
    deleted: string[]
    untracked: string[]
    truncated: boolean
  }>
  gitRunCommit: (files: string[], message: string, stageAll?: boolean) => Promise<{ success: boolean; error?: string }>
  onGitCommitOutput: (
    cb: (payload: { line: string; stream: 'stdout' | 'stderr' }) => void
  ) => () => void
}

interface SessionPickerAPI {
  getSessions: () => Promise<{ diskSessions: DiskSession[]; openTabs: SessionTabInfo[] }>
  switchTab: (tabId: string) => void
  resumeSession: (sessionId: string) => Promise<void>
  newSession: () => Promise<void>
}

declare interface Window {
  pickerApi: PickerAPI
  editorApi: EditorAPI
  sessionPickerApi: SessionPickerAPI
}
