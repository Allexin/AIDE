import { describe, expect, it } from 'vitest'
import { choosePoolAccount } from './accountPool'
import type { CliAccountInfo } from '../config/accountStorage'

const account = (id: string, extra: Partial<CliAccountInfo> = {}): CliAccountInfo => ({
  id, name: id.toUpperCase(), identifier: `${id}@example.com`, savedAt: '2026-10-01T00:00:00Z',
  inPool: true, exhausted: false, exhaustedUntil: null, ...extra
})
const soon = new Date(Date.now() + 3_600_000).toISOString()
const later = new Date(Date.now() + 7_200_000).toISOString()

describe('choosePoolAccount', () => {
  it('does nothing without checked accounts', () => {
    expect(choosePoolAccount([account('a', { inPool: false })], 'a')).toBeNull()
  })

  it('takes the next available checked account in list order', () => {
    const accounts = [account('a', { exhausted: true }), account('b', { exhausted: true, exhaustedUntil: soon }), account('c'), account('d')]
    expect(choosePoolAccount(accounts, 'a')).toEqual({ load: accounts[2], waitUntil: null })
  })

  it('leaves an unchecked active account for a checked one', () => {
    const accounts = [account('a', { inPool: false, exhausted: true }), account('b')]
    expect(choosePoolAccount(accounts, 'a')?.load?.id).toBe('b')
  })

  it('cannot switch when the only checked account is the active one', () => {
    expect(choosePoolAccount([account('a', { exhausted: true })], 'a')).toBeNull()
    expect(choosePoolAccount([account('a', { exhausted: true, exhaustedUntil: soon })], 'a')).toEqual({ load: null, waitUntil: soon })
  })

  it('when every checked account is exhausted, sets the one that resets soonest', () => {
    const accounts = [account('a', { exhausted: true, exhaustedUntil: later }), account('b', { exhausted: true, exhaustedUntil: soon }), account('c', { exhausted: true })]
    expect(choosePoolAccount(accounts, 'a')).toEqual({ load: accounts[1], waitUntil: soon })
  })

  it('stays on the active account when it resets soonest, checked or not', () => {
    const accounts = [account('a', { inPool: false, exhausted: true, exhaustedUntil: soon }), account('b', { exhausted: true, exhaustedUntil: later })]
    expect(choosePoolAccount(accounts, 'a')).toEqual({ load: null, waitUntil: soon })
  })

  it('gives up when no exhausted account says when it resets', () => {
    expect(choosePoolAccount([account('a', { exhausted: true }), account('b', { exhausted: true })], 'a')).toBeNull()
  })
})
