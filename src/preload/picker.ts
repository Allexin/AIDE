import { contextBridge, ipcRenderer } from 'electron'

export interface RecentProject {
  path: string
  lastOpened: string // ISO 8601
}

export interface PickerAPI {
  selectFolder: () => Promise<string | null>
  openProject: (path: string) => Promise<{ success: true } | { success: false; error: string }>
  getState: () => Promise<{ recentProjects: RecentProject[] }>
  validatePath: (path: string) => Promise<boolean>
  removeRecentProject: (path: string) => Promise<void>
}

const pickerApi: PickerAPI = {
  selectFolder: () => ipcRenderer.invoke('pick:select-folder'),
  openProject: (path: string) => ipcRenderer.invoke('project:open', path),
  getState: () => ipcRenderer.invoke('state:get'),
  validatePath: (path: string) => ipcRenderer.invoke('path:validate', path),
  removeRecentProject: (path: string) => ipcRenderer.invoke('state:remove-recent', path)
}

contextBridge.exposeInMainWorld('pickerApi', pickerApi)
