import { contextBridge, ipcRenderer } from 'electron'

interface PickerSession {
  sessionId: string
  summary: string
  title: string
  mtime: number
  toolId: string
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
  getSessions: () => Promise<{ sessions: PickerSession[]; openTabs: SessionTabInfo[] }>
  getPreview: (sessionId: string, toolId: string) => Promise<PreviewMessage[]>
  switchTab: (tabId: string) => void
  resumeSession: (sessionId: string, toolId: string) => Promise<void>
  newSession: (toolId?: string) => Promise<void>
  getActivatedTools: () => Promise<string[]>
  getCliTools: () => Promise<{ id: string; name: string }[]>
  getDefaultToolId: () => Promise<string | null>
  setDefaultToolId: (toolId: string) => Promise<void>
}

const sessionPickerApi: SessionPickerAPI = {
  getSessions: () => ipcRenderer.invoke('session-picker:get-sessions'),
  getPreview: (sessionId: string, toolId: string) => ipcRenderer.invoke('session-picker:get-preview', sessionId, toolId),
  switchTab: (tabId: string) => ipcRenderer.send('session-picker:switch-tab', tabId),
  resumeSession: (sessionId: string, toolId: string) => ipcRenderer.invoke('session-picker:resume-session', sessionId, toolId),
  newSession: (toolId?: string) => ipcRenderer.invoke('session-picker:new-session', toolId),
  getActivatedTools: () => ipcRenderer.invoke('cli-tools:get-activated'),
  getCliTools: () => ipcRenderer.invoke('cli-tools:list'),
  getDefaultToolId: () => ipcRenderer.invoke('project-settings:get-default-tool'),
  setDefaultToolId: (toolId: string) => ipcRenderer.invoke('project-settings:set-default-tool', toolId)
}

contextBridge.exposeInMainWorld('sessionPickerApi', sessionPickerApi)
