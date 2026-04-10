import { contextBridge, ipcRenderer } from 'electron'

interface CliAccountInfo {
  id: string
  name: string
  identifier: string
  savedAt: string
}

interface AccountSwitchConflict {
  savedName: string
  savedIdentifier: string
  currentIdentifier: string
}

type LoadAccountResult = true | false | { conflict: AccountSwitchConflict }

interface AccountManagerAPI {
  getTools: () => Promise<{ id: string; name: string }[]>
  isLoggedIn: (toolId: string) => Promise<boolean>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  listAccounts: (toolId: string) => Promise<CliAccountInfo[]>
  saveCurrent: (toolId: string, name: string) => Promise<CliAccountInfo | null>
  deleteAccount: (toolId: string, accountId: string) => Promise<void>
  updateAccount: (toolId: string, accountId: string) => Promise<CliAccountInfo | null>
  loadAccount: (toolId: string, accountId: string, autoSaveMode?: 'check' | 'force' | 'skip') => Promise<LoadAccountResult>
}

const accountManagerApi: AccountManagerAPI = {
  getTools: () => ipcRenderer.invoke('accounts:get-tools'),
  isLoggedIn: (toolId) => ipcRenderer.invoke('accounts:is-logged-in', toolId),
  getLoginIdentifier: (toolId) => ipcRenderer.invoke('accounts:get-login-identifier', toolId),
  listAccounts: (toolId) => ipcRenderer.invoke('accounts:list', toolId),
  saveCurrent: (toolId, name) => ipcRenderer.invoke('accounts:save-current', toolId, name),
  deleteAccount: (toolId, accountId) => ipcRenderer.invoke('accounts:delete', toolId, accountId),
  updateAccount: (toolId, accountId) => ipcRenderer.invoke('accounts:update', toolId, accountId),
  loadAccount: (toolId, accountId, autoSaveMode) => ipcRenderer.invoke('accounts:load', toolId, accountId, autoSaveMode)
}

contextBridge.exposeInMainWorld('accountManagerApi', accountManagerApi)
