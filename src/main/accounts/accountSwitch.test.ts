import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Stored { id: string; name: string; identifier: string; savedAt: string; credentials: Record<string, unknown>; revision: number }

const store = vi.hoisted(() => ({
  accounts: [] as Stored[],
  active: null as string | null,
  login: null as string | null,
  credentials: null as Record<string, unknown> | null,
  imported: [] as Array<Record<string, unknown>>
}))

vi.mock('../config/accountStorage', () => ({
  listAccounts: () => store.accounts,
  getActiveAccount: () => store.active,
  setActiveAccount: (_tool: string, id: string | null) => { store.active = id },
  updateAccount: (_tool: string, id: string, identifier: string, credentials: Record<string, unknown>) => {
    const account = store.accounts.find((a) => a.id === id)!
    account.identifier = identifier
    account.credentials = credentials
    account.revision++
    return null
  },
  clearAccountExhausted: () => {}
}))

vi.mock('../pty/cliTools/registry', () => ({
  getToolById: () => ({
    getLoginIdentifier: async () => store.login,
    exportCredentials: async () => store.credentials,
    importCredentials: async (credentials: Record<string, unknown>) => {
      store.imported.push(credentials)
      store.credentials = credentials
      store.login = String(credentials.login)
    }
  })
}))

import { currentAccount, loadSavedAccount } from './accountSwitch'

const account = (id: string): Stored => ({
  id, name: id.toUpperCase(), identifier: `${id}@example.com`, savedAt: '2026-10-01T00:00:00Z',
  credentials: { login: `${id}@example.com`, token: `${id}-saved` }, revision: 0
})

beforeEach(() => {
  store.accounts = [account('a'), account('b')]
  store.imported = []
})

describe('account switching without a user', () => {
  it('finds the account the CLI is logged in to, not the stale recorded one', async () => {
    store.active = 'b'
    store.login = 'a@example.com'
    expect(await currentAccount('codex')).toBe('a')
    expect(store.active).toBe('a')
  })

  it('knows no account when the CLI is logged in to one that is not saved', async () => {
    store.active = 'b'
    store.login = 'c@example.com'
    expect(await currentAccount('codex')).toBeNull()
  })

  it('keeps the recorded account when the login is unknown', async () => {
    store.active = 'b'
    store.login = null
    expect(await currentAccount('codex')).toBe('b')
  })

  it('saves the rotated credentials of the account logged in to before loading another', async () => {
    store.active = 'a'
    store.login = 'a@example.com'
    store.credentials = { login: 'a@example.com', token: 'a-rotated' }
    expect(await loadSavedAccount('codex', 'b')).toBe(true)
    expect(store.accounts[0].credentials.token).toBe('a-rotated')
    expect(store.imported).toEqual([{ login: 'b@example.com', token: 'b-saved' }])
    expect(store.active).toBe('b')
  })

  it('does not overwrite the recorded account with another login', async () => {
    store.active = 'b'
    store.login = 'a@example.com'
    store.credentials = { login: 'a@example.com', token: 'a-rotated' }
    expect(await loadSavedAccount('codex', 'a')).toBe(true)
    expect(store.accounts[1]).toMatchObject({ identifier: 'b@example.com', credentials: { token: 'b-saved' }, revision: 0 })
  })
})
