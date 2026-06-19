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
  fileTreeWidth: number
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

// A CLI session as stored on disk.
interface DiskSession {
  sessionId: string
  summary: string // session summary (type:"summary" JSONL entry), or empty
  title: string   // last user message, or empty
  mtime: number   // ms since epoch
}

// A terminal session tab (open in the editor).
interface SessionTabInfo {
  tabId: string
  sessionId: string | null // null until .jsonl appears (new sessions)
  title?: string // saved title for restore; renderer uses as initial slug
  toolId: string
  toolName: string
}

interface InitialTabsResult {
  tabs: SessionTabInfo[]
  activeSessionId: string | null
}

interface SmartCompactCandidate {
  id: string
  reason: string
  selected: boolean
  messages: Array<{ role: string; preview: string }>
}

interface SmartCompactTarget {
  tabId: string
  sessionId: string
  toolId: string
  toolName: string
  title: string
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
  flash?: boolean
}

interface ToolbarButton {
  id: string
  icon: string
  tooltip: string
  command: string
  cwd?: string
  autoClear?: boolean
  sound?: boolean
  channels?: {
    stdout?: ToolbarChannel
    stderr?: ToolbarChannel
  }
}

interface ToolbarSplitter {
  type: 'splitter'
}

type ToolbarItem = ToolbarButton | ToolbarSplitter

interface ToolbarPresetGroup {
  type: string
  label: string
  buttons: ToolbarButton[]
}

interface ToolbarInfo {
  buttons: ToolbarItem[]
  projectType: string
  suggestedType: string | null
}

interface EditorAPI {
  // Menu
  notifyEditorFileChanged: (hasFile: boolean) => void
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
  searchFiles: (query: string) => Promise<{ ready: boolean; files: TreeNode[] }>
  getGitStatus: () => Promise<GitStatusResult>
  onFileIndexUpdated: (cb: () => void) => () => void
  onGitStatusUpdated: (cb: (status: GitStatusResult) => void) => () => void
  onFsChanged: (cb: (event: { path: string }) => void) => () => void

  // Editor file operations
  readFile: (filePath: string) => { content: string; mtime: number; size: number; isBinary?: boolean } | { error: string }
  writeFile: (filePath: string, content: string) => { mtime: number } | { error: string }
  gitShowHead: (relPath: string) => Promise<{ content: string } | { error: 'untracked' | 'other' }>

  // Terminal
  terminalCreateInitial: () => Promise<InitialTabsResult | null>
  saveOpenSessions: (projectPath: string, tabs: Array<{ sessionId: string; title: string }>, activeSessionId: string | null) => void
  terminalCreateNew: (toolId?: string) => Promise<SessionTabInfo | null>
  terminalResumeSession: (sessionId: string, toolId?: string) => Promise<SessionTabInfo | null>
  terminalWrite: (tabId: string, data: string) => void
  terminalResize: (tabId: string, cols: number, rows: number) => void
  terminalCloseTab: (tabId: string) => void
  terminalOpenSessionPicker: () => void
  terminalOpenHistory: (sessionId: string, toolId: string, sessionTitle: string) => void
  smartCompactSupported: (toolId: string) => Promise<boolean>
  smartCompactAnalyze: (tabId: string, task: string) => Promise<{
    ok: boolean
    error?: string
    target?: SmartCompactTarget
    analysisId?: string
    candidates?: SmartCompactCandidate[]
    stdout?: string
    stderr?: string
  }>
  smartCompactApply: (
    target: SmartCompactTarget,
    analysisId: string,
    candidateIds: string[],
    force: boolean
  ) => Promise<
    | { status: 'applied'; removed: number; warning?: string }
    | { status: 'conflict'; message: string }
  >
  smartCompactResume: (target: SmartCompactTarget, analysisId?: string) => Promise<void>
  onSmartCompactOutput: (
    cb: (tabId: string, stream: 'stdout' | 'stderr', chunk: string) => void
  ) => () => void
  onTerminalData: (cb: (tabId: string, data: string) => void) => () => void
  onTerminalTabTitle: (cb: (tabId: string, title: string) => void) => () => void
  onTerminalTabSessionId: (cb: (tabId: string, sessionId: string) => void) => () => void
  onTerminalTabExited: (cb: (tabId: string) => void) => () => void
  onTerminalTabReady: (cb: (tabId: string) => void) => () => void
  onTerminalDeadSession: (cb: (tabId: string, sessionId: string | null) => void) => () => void
  onTerminalSwitchTab: (cb: (tabId: string) => void) => () => void
  onTerminalNewTab: (cb: (tab: SessionTabInfo) => void) => () => void
  onTerminalTabClosed: (cb: (tabId: string) => void) => () => void
  onTerminalResetTabs: (cb: (tabs: SessionTabInfo[]) => void) => () => void
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
  getActivatedTools: () => Promise<string[]>
  getDefaultToolId: () => Promise<string | null>
  setDefaultToolId: (toolId: string) => Promise<void>

  // Accounts
  getAccountCurrentInfo: (toolId: string) => Promise<{ label: string; saved: boolean } | null>
  getUsageInfo: (toolId: string) => Promise<{ summary: string; tooltip: string; level: 'normal' | 'warn' | 'critical'; fetchedAt: number; hasLimit?: boolean } | null>
  getContextInsertText: (toolId: string, relPath: string) => Promise<string | null>
  onCliLog: (cb: (channel: string, message: string) => void) => () => void
  onAccountsChanged: (cb: () => void) => () => void

  // PTY: create session with prompt
  terminalCreateWithPrompt: (toolId: string, prompt: string) => Promise<SessionTabInfo | null>

  // Drag & drop file path resolution (webUtils.getPathForFile, Electron 32+)
  getPathForFile: (file: File) => string

  // Shell / FS operations
  shellShowItemInFolder: (filePath: string) => Promise<void>
  shellOpenPath: (filePath: string) => Promise<void>
  fsDeleteFile: (filePath: string) => Promise<void>
  fsTrashFile: (filePath: string) => Promise<void>
  fsRenameFile: (oldPath: string, newPath: string) => Promise<void>
  fsCopyFile: (src: string, dest: string) => Promise<void>
  fsCreateFile: (filePath: string) => Promise<void>

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
  gitRunCommit: (files: string[], message: string, stageAll?: boolean) => Promise<{ success: boolean; error?: string }>
  onGitCommitOutput: (
    cb: (payload: { line: string; stream: 'stdout' | 'stderr' }) => void
  ) => () => void

  // Updater
  updaterGetStatus: () => Promise<UpdateStatus>
  updaterSkipVersion: (version: string) => Promise<void>
  updaterDismissNotification: () => Promise<void>
  updaterOpenReleases: () => void
  onUpdaterStatusChanged: (cb: (status: UpdateStatus) => void) => () => void

  // Remote access
  onRemoteTabLockChanged: (cb: (tabId: string, locked: boolean) => void) => () => void
  remoteTakeBack: (tabId: string) => void
}

interface ReleaseInfo {
  version: string
  notes: string
}

interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  newReleases: ReleaseInfo[]
  hasUpdate: boolean
  shouldNotify: boolean
  lastCheckedAt: number | null
}

interface PreviewMessage {
  role: 'user' | 'assistant'
  text: string
}

interface PickerSession {
  sessionId: string
  summary: string
  firstMessage: string
  title: string
  mtime: number
  toolId: string
}

interface HistoryBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | Array<{ type: string; text?: string }>
}

interface HistoryEntry {
  role: 'user' | 'assistant'
  blocks: HistoryBlock[]
}

interface HistoryViewerData {
  title: string
  toolName: string
  entries: HistoryEntry[]
}

interface HistoryViewerAPI {
  getData: () => Promise<HistoryViewerData>
  onNewEntries: (cb: (entries: HistoryEntry[]) => void) => () => void
}

interface SessionPickerAPI {
  getSessions: (offset?: number, limit?: number) => Promise<{ sessions: PickerSession[]; openTabs: SessionTabInfo[]; total: number }>
  getPreview: (sessionId: string, toolId: string) => Promise<PreviewMessage[]>
  switchTab: (tabId: string) => void
  resumeSession: (sessionId: string, toolId: string) => Promise<void>
  newSession: (toolId?: string) => Promise<void>
  getActivatedTools: () => Promise<string[]>
  getCliTools: () => Promise<{ id: string; name: string }[]>
  getDefaultToolId: () => Promise<string | null>
  setDefaultToolId: (toolId: string) => Promise<void>
  openHistory: (sessionId: string, toolId: string, sessionTitle: string) => void
}

interface AccountSwitchConflict {
  savedName: string
  savedIdentifier: string
  currentIdentifier: string
}

interface CliAccountInfo {
  id: string
  name: string
  identifier: string // human-readable login identifier (e.g. email)
  savedAt: string
}

interface AccountManagerAPI {
  getTools: () => Promise<{ id: string; name: string }[]>
  isLoggedIn: (toolId: string) => Promise<boolean>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  listAccounts: (toolId: string) => Promise<CliAccountInfo[]>
  saveCurrent: (toolId: string, name: string) => Promise<CliAccountInfo | null>
  deleteAccount: (toolId: string, accountId: string) => Promise<void>
  updateAccount: (toolId: string, accountId: string) => Promise<CliAccountInfo | null>
  loadAccount: (toolId: string, accountId: string, autoSaveMode?: 'check' | 'force' | 'skip') => Promise<true | false | { conflict: AccountSwitchConflict }>
}

interface RemoteCustomButton {
  label: string
  send: string
}

interface RemoteButtonRow {
  buttons: RemoteCustomButton[]
}

interface RemoteConfig {
  enabled: boolean
  remoteHost: string
  buttonSize: 'small' | 'medium' | 'large'
  buttonRows: RemoteButtonRow[]
}

interface RemoteConnectAPI {
  openSettings: () => void
}

interface SettingsAPI {
  getReasoningConfig: () => Promise<{ showPanel: boolean }>
  saveReasoningConfig: (config: { showPanel: boolean }) => Promise<void>
  getToolSettings: () => Promise<Array<{ toolId: string; name: string; fields: SettingsField[]; values: Record<string, unknown> }>>
  updateToolSettings: (toolId: string, values: Record<string, unknown>) => Promise<void>
  getAccountTools: () => Promise<Array<{ id: string; name: string; hasAccount: boolean }>>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  resizeWindow: (height: number) => void
  getUpdatesConfig: () => Promise<{ notifyFrequency: 'never' | 'daily' | 'weekly' | 'monthly' }>
  saveUpdatesConfig: (config: { notifyFrequency: 'never' | 'daily' | 'weekly' | 'monthly' }) => Promise<void>
  getRemoteConfig: () => Promise<RemoteConfig>
  saveRemoteConfig: (config: RemoteConfig) => Promise<void>
  getActivatedTools: () => Promise<{ id: string; name: string }[]>
  askAiAboutRemote: (toolId: string) => Promise<void>
}

interface SettingsField {
  key: string
  label: string
  description?: string
  type: 'string' | 'boolean' | 'number' | 'password' | 'select'
  options?: Array<{ value: string; label: string }>
  default?: unknown
  visibleWhen?: { key: string; value: unknown }
}

interface CliToolEntry {
  id: string
  name: string
  installUrl: string | null
  activated: boolean
}

interface CliToolsAPI {
  getAll: () => Promise<CliToolEntry[]>
  activate: (toolId: string) => Promise<{ ok: boolean; error?: string }>
  deactivate: (toolId: string) => Promise<void>
  copyToolId: (toolId: string) => void
  close: () => void
}

declare interface Window {
  pickerApi: PickerAPI
  editorApi: EditorAPI
  sessionPickerApi: SessionPickerAPI
  accountManagerApi: AccountManagerAPI
  settingsApi: SettingsAPI
  cliToolsApi: CliToolsAPI
  historyViewerApi: HistoryViewerAPI
  remoteConnectApi?: RemoteConnectAPI
}
