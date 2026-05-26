import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('remoteConnectApi', {
  openSettings: () => ipcRenderer.send('remote:open-settings')
})
