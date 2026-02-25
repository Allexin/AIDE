import { contextBridge, ipcRenderer } from 'electron'

export interface ProjectSettings {
  activePanelRatio: number
  collapsedWidthPx: number
}

export interface EditorAPI {
  getProjectPath: () => Promise<string | null>
  getProjectSettings: () => Promise<ProjectSettings>
  getConfig: () => Promise<{
    ui: { fileTreeWidthPx: number; logPanelExpandedHeightPx: number }
  }>
}

const editorApi: EditorAPI = {
  getProjectPath: () => ipcRenderer.invoke('editor:get-project-path'),
  getProjectSettings: () => ipcRenderer.invoke('editor:get-project-settings'),
  getConfig: () => ipcRenderer.invoke('config:get')
}

contextBridge.exposeInMainWorld('editorApi', editorApi)
