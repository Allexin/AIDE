import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RunStore, currentStartCommits } from './runStore'
import type { RunState } from './types'

const root = mkdtempSync(join(tmpdir(), 'aide-runstore-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A state as AIDE stored it before `startCommits` existed. */
const legacy = (extra: Record<string, unknown> = {}): RunState => ({
  runId: 'r', machineId: 'm', projectPath: '/p', actors: 2, status: 'finished', current: null, visits: {}, outputs: {}, history: [],
  escalations: [], sessions: {}, startCommit: 'abc123', result: 'success', startedAt: '', updatedAt: '', finishedAt: null, ...extra
} as unknown as RunState)

describe('currentStartCommits', () => {
  it('reads the old startCommit of a run without a stored setup as the root repo', () => {
    expect(currentStartCommits(legacy()).startCommits).toEqual({ root: 'abc123' })
    expect(currentStartCommits(legacy({ startCommit: null })).startCommits).toEqual({ root: null })
  })

  it('keys it by the first repo of a stored setup; a run without git has none', () => {
    const repos = { mode: 'git', repos: [{ id: 'web', path: 'frontend', abs: '/p/frontend' }, { id: 'api', path: 'api', abs: '/p/api' }], commits: true }
    expect(currentStartCommits(legacy({ git: repos })).startCommits).toEqual({ web: 'abc123' })
    expect(currentStartCommits(legacy({ git: { mode: 'none' }, startCommit: null })).startCommits).toEqual({})
  })

  it('leaves a current state alone', () => {
    const state = legacy({ startCommits: { web: 'x', api: null } })
    expect(currentStartCommits(state).startCommits).toEqual({ web: 'x', api: null })
  })
})

describe('RunStore.load', () => {
  it('loads a run stored before startCommits existed', () => {
    const store = new RunStore(root)
    const dir = store.dir('old-run')
    mkdirSync(dir, { recursive: true })
    const { actors: _actors, ...old } = legacy() as unknown as Record<string, unknown>
    writeFileSync(join(dir, 'state.json'), JSON.stringify(old))
    writeFileSync(join(dir, 'machine.json'), JSON.stringify({ machine: { id: 'm', name: 'M', steps: [] }, machineDir: root }))
    writeFileSync(join(dir, 'params.json'), '{}')
    const loaded = store.load('old-run')
    expect(loaded?.state.startCommit).toBe('abc123')
    expect(loaded?.state.startCommits).toEqual({ root: 'abc123' })
  })
})
