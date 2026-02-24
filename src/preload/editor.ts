import { contextBridge, ipcRenderer } from 'electron'

export interface EditorAPI {
  getProjectPath: () => Promise<string | null>
}

const editorApi: EditorAPI = {
  getProjectPath: () => ipcRenderer.invoke('editor:get-project-path')
}

contextBridge.exposeInMainWorld('editorApi', editorApi)
