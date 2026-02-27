import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

/** Full account record stored on disk (credentials included). */
export interface CliAccount {
  id: string
  name: string
  identifier: string // human-readable login identifier (e.g. email)
  savedAt: string // ISO 8601
  credentials: Record<string, unknown>
}

/** Account info safe to send to renderer (no credentials). */
export interface CliAccountInfo {
  id: string
  name: string
  identifier: string
  savedAt: string
}

interface AccountsFile {
  [toolId: string]: CliAccount[]
}

let accountsPath = ''
let accounts: AccountsFile = {}

export function initAccountStorage(): void {
  accountsPath = join(app.getPath('userData'), 'aide-accounts.json')

  if (existsSync(accountsPath)) {
    try {
      accounts = JSON.parse(readFileSync(accountsPath, 'utf8'))
    } catch {
      accounts = {}
    }
  }
}

function save(): void {
  writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), 'utf8')
}

export function listAccounts(toolId: string): CliAccount[] {
  return accounts[toolId] ?? []
}

/** Return account list without credentials — safe for renderer. */
export function listAccountInfos(toolId: string): CliAccountInfo[] {
  return (accounts[toolId] ?? []).map(({ id, name, identifier, savedAt }) => ({
    id, name, identifier, savedAt
  }))
}

export function saveAccount(
  toolId: string,
  name: string,
  identifier: string,
  credentials: Record<string, unknown>
): CliAccountInfo {
  const account: CliAccount = {
    id: randomUUID(),
    name,
    identifier,
    savedAt: new Date().toISOString(),
    credentials
  }

  if (!accounts[toolId]) accounts[toolId] = []
  accounts[toolId].push(account)
  save()
  return { id: account.id, name: account.name, identifier: account.identifier, savedAt: account.savedAt }
}

export function deleteAccount(toolId: string, accountId: string): void {
  if (!accounts[toolId]) return
  accounts[toolId] = accounts[toolId].filter((a) => a.id !== accountId)
  save()
}

export function updateAccount(
  toolId: string,
  accountId: string,
  identifier: string,
  credentials: Record<string, unknown>
): CliAccountInfo | null {
  const list = accounts[toolId]
  if (!list) return null
  const account = list.find((a) => a.id === accountId)
  if (!account) return null
  account.credentials = credentials
  account.identifier = identifier
  account.savedAt = new Date().toISOString()
  save()
  return { id: account.id, name: account.name, identifier: account.identifier, savedAt: account.savedAt }
}
