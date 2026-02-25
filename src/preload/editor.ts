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
  }
}

contextBridge.exposeInMainWorld('editorApi', editorApi)
