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

interface EditorAPI {
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
}

declare interface Window {
  pickerApi: PickerAPI
  editorApi: EditorAPI
}
