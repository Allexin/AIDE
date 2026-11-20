import { contextBridge, ipcRenderer } from 'electron'
import type { ViewerLivePayload, ViewerReplyTab, ViewerSendResult, ViewerShowPayload } from '../shared/viewer/types'

/** Bridge of the file viewer window (docs/file-viewer-spec.md). */
interface FileViewerAPI {
  getState: () => Promise<ViewerShowPayload | null>
  onShow: (cb: (payload: ViewerShowPayload) => void) => () => void
  onLive: (cb: (payload: ViewerLivePayload) => void) => () => void
  onReply: (cb: (reply: ViewerReplyTab) => void) => () => void
  send: (text: string) => Promise<ViewerSendResult>
  setPending: (count: number) => void
  openInEditor: (relPath: string) => void
  saveMarksImage: (dataUrl: string) => Promise<string | null>
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const fileViewerApi: FileViewerAPI = {
  getState: () => ipcRenderer.invoke('viewer:get-state'),
  onShow: (cb) => listen('viewer:show', cb),
  onLive: (cb) => listen('viewer:live', cb),
  onReply: (cb) => listen('viewer:reply', cb),
  send: (text) => ipcRenderer.invoke('viewer:send', text),
  setPending: (count) => ipcRenderer.send('viewer:pending', count),
  openInEditor: (relPath) => ipcRenderer.send('viewer:open-in-editor', relPath),
  saveMarksImage: (dataUrl) => ipcRenderer.invoke('viewer:save-marks-image', dataUrl)
}

contextBridge.exposeInMainWorld('fileViewerApi', fileViewerApi)
