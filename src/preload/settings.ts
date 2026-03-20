import { contextBridge, ipcRenderer } from 'electron'

export interface ProxyConfig {
  enabled: boolean
  address: string
  useForCliTools: boolean
}

export interface ReasoningConfig {
  showPanel: boolean
}

export interface SettingsAPI {
  getProxyConfig: () => Promise<ProxyConfig>
  saveProxyConfig: (config: ProxyConfig) => Promise<void>
  getReasoningConfig: () => Promise<ReasoningConfig>
  saveReasoningConfig: (config: ReasoningConfig) => Promise<void>
}

const settingsApi: SettingsAPI = {
  getProxyConfig: () => ipcRenderer.invoke('settings:get-proxy'),
  saveProxyConfig: (config) => ipcRenderer.invoke('settings:save-proxy', config),
  getReasoningConfig: () => ipcRenderer.invoke('settings:get-reasoning'),
  saveReasoningConfig: (config) => ipcRenderer.invoke('settings:save-reasoning', config)
}

contextBridge.exposeInMainWorld('settingsApi', settingsApi)
