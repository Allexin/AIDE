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

export interface UpdatesConfig {
  notifyFrequency: 'never' | 'daily' | 'weekly' | 'monthly'
}

export interface SessionsConfig {
  maxSessionsInPicker: number
  maxRecentProjects: number
  maxRestoredSessions: number
}

export interface RemoteCustomButton {
  label: string
  send: string
}

export interface RemoteButtonRow {
  buttons: RemoteCustomButton[]
}

export interface RemoteConfig {
  enabled: boolean
  remoteHost: string
  buttonSize: 'small' | 'medium' | 'large'
  buttonRows: RemoteButtonRow[]
}

export interface SettingsAPI {
  getReasoningConfig: () => Promise<ReasoningConfig>
  saveReasoningConfig: (config: ReasoningConfig) => Promise<void>
  getToolSettings: () => Promise<ToolSettingsEntry[]>
  updateToolSettings: (toolId: string, values: Record<string, unknown>) => Promise<void>
  getAccountTools: () => Promise<AccountToolEntry[]>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  resizeWindow: (height: number) => void
  getUpdatesConfig: () => Promise<UpdatesConfig>
  saveUpdatesConfig: (config: UpdatesConfig) => Promise<void>
  getSessionsConfig: () => Promise<SessionsConfig>
  saveSessionsConfig: (config: SessionsConfig) => Promise<void>
  getRemoteConfig: () => Promise<RemoteConfig>
  saveRemoteConfig: (config: RemoteConfig) => Promise<void>
  getActivatedTools: () => Promise<{ id: string; name: string }[]>
  askAiAboutRemote: (toolId: string) => Promise<void>
}

const settingsApi: SettingsAPI = {
  getReasoningConfig: () => ipcRenderer.invoke('settings:get-reasoning'),
  saveReasoningConfig: (config) => ipcRenderer.invoke('settings:save-reasoning', config),
  getToolSettings: () => ipcRenderer.invoke('tool-settings:get-all'),
  updateToolSettings: (toolId, values) => ipcRenderer.invoke('tool-settings:update', toolId, values),
  getAccountTools: () => ipcRenderer.invoke('accounts:get-tools'),
  getLoginIdentifier: (toolId) => ipcRenderer.invoke('accounts:get-login-identifier', toolId),
  resizeWindow: (height) => ipcRenderer.send('settings:resize', height),
  getUpdatesConfig: () => ipcRenderer.invoke('settings:get-updates'),
  saveUpdatesConfig: (config) => ipcRenderer.invoke('settings:save-updates', config),
  getSessionsConfig: () => ipcRenderer.invoke('settings:get-sessions'),
  saveSessionsConfig: (config) => ipcRenderer.invoke('settings:save-sessions', config),
  getRemoteConfig: () => ipcRenderer.invoke('settings:get-remote'),
  saveRemoteConfig: (config) => ipcRenderer.invoke('settings:save-remote', config),
  getActivatedTools: () => ipcRenderer.invoke('settings:get-activated-tools'),
  askAiAboutRemote: (toolId) => ipcRenderer.invoke('settings:ask-ai-remote', toolId)
}

contextBridge.exposeInMainWorld('settingsApi', settingsApi)
