import { contextBridge, ipcRenderer } from 'electron'
import type { SettingsField } from '../shared/settingsTypes'

export type { SettingsField }

export interface ReasoningConfig {
  showPanel: boolean
}

export interface ToolSettingsEntry {
  toolId: string
  name: string
  fields: SettingsField[]
  values: Record<string, unknown>
}

export interface AccountToolEntry {
  id: string
  name: string
  hasAccount: boolean
}

export interface SettingsAPI {
  getReasoningConfig: () => Promise<ReasoningConfig>
  saveReasoningConfig: (config: ReasoningConfig) => Promise<void>
  getToolSettings: () => Promise<ToolSettingsEntry[]>
  updateToolSettings: (toolId: string, values: Record<string, unknown>) => Promise<void>
  getAccountTools: () => Promise<AccountToolEntry[]>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  resizeWindow: (height: number) => void
}

const settingsApi: SettingsAPI = {
  getReasoningConfig: () => ipcRenderer.invoke('settings:get-reasoning'),
  saveReasoningConfig: (config) => ipcRenderer.invoke('settings:save-reasoning', config),
  getToolSettings: () => ipcRenderer.invoke('tool-settings:get-all'),
  updateToolSettings: (toolId, values) => ipcRenderer.invoke('tool-settings:update', toolId, values),
  getAccountTools: () => ipcRenderer.invoke('accounts:get-tools'),
  getLoginIdentifier: (toolId) => ipcRenderer.invoke('accounts:get-login-identifier', toolId),
  resizeWindow: (height) => ipcRenderer.send('settings:resize', height)
}

contextBridge.exposeInMainWorld('settingsApi', settingsApi)
