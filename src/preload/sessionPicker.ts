import { contextBridge, ipcRenderer } from 'electron'

interface DiskSession {
  sessionId: string
  summary: string
  title: string
  mtime: number
}

interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  slug: string
}

interface PreviewMessage {
  role: 'user' | 'assistant'
  text: string
}

interface SessionPickerAPI {
  getSessions: () => Promise<{ diskSessions: DiskSession[]; openTabs: SessionTabInfo[] }>
  getPreview: (sessionId: string) => Promise<PreviewMessage[]>
  switchTab: (tabId: string) => void
  resumeSession: (sessionId: string) => Promise<void>
  newSession: () => Promise<void>
}

const sessionPickerApi: SessionPickerAPI = {
  getSessions: () => ipcRenderer.invoke('session-picker:get-sessions'),
  getPreview: (sessionId: string) => ipcRenderer.invoke('session-picker:get-preview', sessionId),
  switchTab: (tabId: string) => ipcRenderer.send('session-picker:switch-tab', tabId),
  resumeSession: (sessionId: string) => ipcRenderer.invoke('session-picker:resume-session', sessionId),
  newSession: () => ipcRenderer.invoke('session-picker:new-session')
}

contextBridge.exposeInMainWorld('sessionPickerApi', sessionPickerApi)
