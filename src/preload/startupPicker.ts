import { contextBridge, ipcRenderer } from 'electron'

interface StartupPickerAPI {
  getData: () => Promise<unknown>
  getHistory: (sessionKey: string) => Promise<unknown>
  confirm: (selectedKeys: string[], newToolId: string) => Promise<void>
}

const startupPickerApi: StartupPickerAPI = {
  getData: () => ipcRenderer.invoke('startup-picker:get-data'),
  getHistory: (sessionKey) => ipcRenderer.invoke('startup-picker:get-history', sessionKey),
  confirm: (selectedKeys, newToolId) => ipcRenderer.invoke('startup-picker:confirm', selectedKeys, newToolId)
}

contextBridge.exposeInMainWorld('startupPickerApi', startupPickerApi)
