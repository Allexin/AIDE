import { contextBridge, ipcRenderer } from 'electron'

interface HistoryViewerAPI {
  getData: () => Promise<unknown>
  onNewEntries: (cb: (entries: unknown[]) => void) => () => void
}

const historyViewerApi: HistoryViewerAPI = {
  getData: () => ipcRenderer.invoke('history-viewer:get-data'),
  onNewEntries: (cb) => {
    const handler = (_: Electron.IpcRendererEvent, entries: unknown[]) => cb(entries)
    ipcRenderer.on('history-viewer:new-entries', handler)
    return () => ipcRenderer.off('history-viewer:new-entries', handler)
  }
}

contextBridge.exposeInMainWorld('historyViewerApi', historyViewerApi)
