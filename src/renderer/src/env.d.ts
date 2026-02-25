/// <reference types="vite/client" />

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
  changed: string[] // relative forward-slash paths of changed/untracked files
  deleted: string[] // relative forward-slash paths of deleted files
}

// A Claude Code session as stored on disk.
interface DiskSession {
  sessionId: string
  slug: string | null
  mtime: number // ms since epoch
}

// A terminal session tab (open in the editor).
interface SessionTabInfo {
  tabId: string
  sessionId: string | null // null until .jsonl appears (new sessions)
  slug: string // 'Claude Code' until slug is read from JSONL
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

interface EditorAPI {
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
