import { describe, expect, it } from 'vitest'
import { choosePoolAccount, orchestratorResumeMessage } from './accountPool'
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

describe('orchestratorResumeMessage', () => {
  const base = { cli: 'Claude Code', from: 'Work', to: 'Personal', runId: 'run-1', node: 'implement', since: 42 }

  it('says what happened and how to continue', () => {
    const text = orchestratorResumeMessage({ ...base, resumesAt: null })
    expect(text).toContain('switched Claude Code from account Work to Personal')
    expect(text).toContain('restarted')
    expect(text).toContain('Run run-1 has been resumed at step implement')
    expect(text).toContain('call pipeline_wait for run run-1 with since=42')
  })

  it('tells when the run resumes by itself if every account is exhausted', () => {
    expect(orchestratorResumeMessage({ ...base, resumesAt: soon })).toContain(`resumes by itself at ${soon}`)
  })
})
