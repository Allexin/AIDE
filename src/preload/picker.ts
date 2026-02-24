import { contextBridge, ipcRenderer } from 'electron'

export interface PickerAPI {
  selectFolder: () => Promise<string | null>
  openProject: (path: string) => Promise<{ success: true } | { success: false; error: string }>
}

const pickerApi: PickerAPI = {
  selectFolder: () => ipcRenderer.invoke('pick:select-folder'),
  openProject: (path: string) => ipcRenderer.invoke('project:open', path)
}

contextBridge.exposeInMainWorld('pickerApi', pickerApi)
