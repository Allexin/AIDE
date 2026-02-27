import { contextBridge, ipcRenderer } from 'electron'

interface CliAccountInfo {
  id: string
  name: string
  identifier: string
  savedAt: string
}

interface AccountManagerAPI {
  getTools: () => Promise<{ id: string; name: string }[]>
  isLoggedIn: (toolId: string) => Promise<boolean>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  listAccounts: (toolId: string) => Promise<CliAccountInfo[]>
  saveCurrent: (toolId: string, name: string) => Promise<CliAccountInfo | null>
  deleteAccount: (toolId: string, accountId: string) => Promise<void>
  updateAccount: (toolId: string, accountId: string) => Promise<CliAccountInfo | null>
  loadAccount: (toolId: string, accountId: string) => Promise<boolean>
}

const accountManagerApi: AccountManagerAPI = {
  getTools: () => ipcRenderer.invoke('accounts:get-tools'),
  isLoggedIn: (toolId) => ipcRenderer.invoke('accounts:is-logged-in', toolId),
  getLoginIdentifier: (toolId) => ipcRenderer.invoke('accounts:get-login-identifier', toolId),
  listAccounts: (toolId) => ipcRenderer.invoke('accounts:list', toolId),
  saveCurrent: (toolId, name) => ipcRenderer.invoke('accounts:save-current', toolId, name),
  deleteAccount: (toolId, accountId) => ipcRenderer.invoke('accounts:delete', toolId, accountId),
  updateAccount: (toolId, accountId) => ipcRenderer.invoke('accounts:update', toolId, accountId),
  loadAccount: (toolId, accountId) => ipcRenderer.invoke('accounts:load', toolId, accountId)
}

contextBridge.exposeInMainWorld('accountManagerApi', accountManagerApi)
