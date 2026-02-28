import { contextBridge, ipcRenderer } from 'electron'

export interface ProxyConfig {
  enabled: boolean
  address: string
  useForCliTools: boolean
}

export interface SettingsAPI {
  getProxyConfig: () => Promise<ProxyConfig>
  saveProxyConfig: (config: ProxyConfig) => Promise<void>
}

const settingsApi: SettingsAPI = {
  getProxyConfig: () => ipcRenderer.invoke('settings:get-proxy'),
  saveProxyConfig: (config) => ipcRenderer.invoke('settings:save-proxy', config)
}

contextBridge.exposeInMainWorld('settingsApi', settingsApi)
