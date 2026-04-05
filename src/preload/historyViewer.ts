import { contextBridge, ipcRenderer } from 'electron'

interface HistoryViewerAPI {
  getData: () => Promise<unknown>
}

const historyViewerApi: HistoryViewerAPI = {
  getData: () => ipcRenderer.invoke('history-viewer:get-data')
}

contextBridge.exposeInMainWorld('historyViewerApi', historyViewerApi)
