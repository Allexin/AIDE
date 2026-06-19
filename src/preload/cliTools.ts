import { clipboard, contextBridge, ipcRenderer } from 'electron'

export interface CliToolEntry {
  id: string
  name: string
  installUrl: string | null
  activated: boolean
}

interface CliToolsAPI {
  getAll: () => Promise<CliToolEntry[]>
  activate: (toolId: string) => Promise<{ ok: boolean; error?: string }>
  deactivate: (toolId: string) => Promise<void>
  copyToolId: (toolId: string) => void
  close: () => void
}

const cliToolsApi: CliToolsAPI = {
  getAll: () => ipcRenderer.invoke('cli-tools:get-all'),
  activate: (toolId: string) => ipcRenderer.invoke('cli-tools:activate', toolId),
  deactivate: (toolId: string) => ipcRenderer.invoke('cli-tools:deactivate', toolId),
  copyToolId: (toolId: string) => clipboard.writeText(toolId),
  close: () => ipcRenderer.send('cli-tools:closed')
}

contextBridge.exposeInMainWorld('cliToolsApi', cliToolsApi)
