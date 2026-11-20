import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TaskFile } from '../../shared/task'
import { serializeTask } from './taskFile'
import { TaskConflictError, TaskStore, isTrackerPath } from './taskStore'

/** Every rename the store makes, so the order of its writes can be checked. */
const renames = vi.hoisted(() => [] as string[])
/**
 * A lease file "pending deletion", as Windows reports it: while `pendingDelete` is set,
 * an exclusive create and a read of the lease file fail with EPERM although the file
 * is there. `leaseOpens` counts the create attempts.
 */
const faults = vi.hoisted(() => ({ pendingDelete: false, leaseOpens: 0 }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const isLease = (path: unknown): boolean => String(path).endsWith('.write-lock')
  const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renames.push(to)
      return actual.renameSync(from, to)
    },
    openSync: (path: string, ...rest: unknown[]) => {
      if (isLease(path)) {
        faults.leaseOpens++
        if (faults.pendingDelete) throw eperm()
      }
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest)
    },
    readFileSync: (path: string, ...rest: unknown[]) => {
      if (isLease(path) && faults.pendingDelete) throw eperm()
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }
  }
})

function task(id: string, overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id, title: `Task ${id}`, status: 'backlog', rank: null, tags: [], docs: [], code: [], reason: null, blockedFrom: null,
    label: null, claim: null, decidedAgainst: null, reopened: false, history: null, confirmed: null, acknowledged: null,
    check: null, source: null, activeBy: [], created: '2026-11-20T10:00:00Z', closed: null, description: '', journal: [],
    ...overrides
  }
}

let dir = ''
let store: TaskStore
const tasksDir = (): string => join(dir, 'aide', 'tasks')
const file = (id: string): string => join(tasksDir(), `${id}.md`)
const lockPath = (): string => join(tasksDir(), '.write-lock')
const owner = { user: 'alice', host: 'pc1' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aide-task-store-'))
  store = new TaskStore(dir, join(dir, '.aide', 'users', 'alice', 'tasks'), owner)
  renames.length = 0
  faults.pendingDelete = false
  faults.leaseOpens = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeLease(expires: number, user = 'bob'): void {
  mkdirSync(tasksDir(), { recursive: true })
  writeFileSync(lockPath(), JSON.stringify({ user, host: 'pc2', pid: 1, expires: new Date(expires).toISOString(), token: 'theirs' }))
}

describe('TaskStore reads', () => {
  it('lists every task file, reading the files each time', async () => {
    expect(store.list()).toEqual([])
    const revisions = await store.write([{ task: task('a'), baseRevision: null }, { task: task('b'), baseRevision: null }])
    expect(store.list().map((e) => [e.id, e.file, e.revision, e.error])).toEqual([['a', 'aide/tasks/a.md', revisions.a, null], ['b', 'aide/tasks/b.md', revisions.b, null]])
    writeFileSync(file('a'), serializeTask(task('a', { title: 'Edited by hand' })))
    expect(store.read('a').task.title).toBe('Edited by hand')
    expect(store.read('a').revision).not.toBe(revisions.a)
    writeFileSync(file('b'), 'broken')
    const broken = store.list().find((e) => e.id === 'b')!
    expect(broken).toMatchObject({ task: null, error: expect.stringContaining('aide/tasks/b.md is invalid') })
    expect(broken.revision).toMatch(/^[0-9a-f]{12}$/)
    expect(() => store.read('b')).toThrow('aide/tasks/b.md is invalid')
    expect(() => store.read('zzz')).toThrow('Unknown task "zzz"')
    expect(store.exists('a')).toBe(true)
    expect(store.exists('zzz')).toBe(false)
  })

  it('reads config.json, a missing file meaning the defaults', () => {
    expect(store.config()).toEqual({ snapshotLabelBudget: 12000 })
    mkdirSync(tasksDir(), { recursive: true })
    writeFileSync(join(tasksDir(), 'config.json'), '{ "snapshotLabelBudget": 500, "later": true }')
    expect(store.config()).toEqual({ snapshotLabelBudget: 500 })
    writeFileSync(join(tasksDir(), 'config.json'), '{}')
    expect(store.config()).toEqual({ snapshotLabelBudget: 12000 })
    writeFileSync(join(tasksDir(), 'config.json'), '{ "snapshotLabelBudget": "big" }')
    expect(() => store.config()).toThrow('"snapshotLabelBudget" must be a positive whole number')
    writeFileSync(join(tasksDir(), 'config.json'), '{')
    expect(() => store.config()).toThrow('config.json is not valid JSON')
  })
})

describe('task ids', () => {
  it('read and exists reject an id that is not a slug, so no id resolves outside aide/tasks/', async () => {
    mkdirSync(join(dir, 'aide'), { recursive: true })
    writeFileSync(join(dir, 'x.md'), serializeTask(task('x')))
    expect(store.exists('../../x')).toBe(false)
    expect(store.exists('../x')).toBe(false)
    expect(() => store.read('../../x')).toThrow('is not a task id')
    expect(() => store.read('../x')).toThrow('is not a task id')
    expect(() => store.read('A')).toThrow('is not a task id')
    await store.write([{ task: task('a'), baseRevision: null }])
    expect(store.exists('a')).toBe(true)
    expect(store.read('a').task.id).toBe('a')
  })
})

describe('TaskStore.write', () => {
  it('writes the files in the order of the changes, the last change last, and returns their revisions', async () => {
    await store.write([{ task: task('c'), baseRevision: null }, { task: task('a'), baseRevision: null }, { task: task('b'), baseRevision: null }])
    expect(renames.filter((p) => p.endsWith('.md')).map((p) => p.split(/[\\/]/).pop())).toEqual(['c.md', 'a.md', 'b.md'])
    expect(readFileSync(file('a'), 'utf8')).toBe(serializeTask(task('a')))
    expect(existsSync(lockPath())).toBe(false)
  })

  it('refuses the whole batch when any task changed, naming every changed task, and writes nothing', async () => {
    const base = await store.write([{ task: task('a'), baseRevision: null }, { task: task('b'), baseRevision: null }, { task: task('c'), baseRevision: null }])
    writeFileSync(file('b'), serializeTask(task('b', { title: 'Hand edit' })))
    rmSync(file('c'))
    const before = { a: readFileSync(file('a'), 'utf8'), b: readFileSync(file('b'), 'utf8') }
    const attempt = store.write([
      { task: task('a', { title: 'New A' }), baseRevision: base.a },
      { task: task('b', { title: 'New B' }), baseRevision: base.b },
      { task: task('c', { title: 'New C' }), baseRevision: base.c },
      { task: task('a2'), baseRevision: null }
    ])
    await expect(attempt).rejects.toBeInstanceOf(TaskConflictError)
    await expect(attempt).rejects.toMatchObject({ ids: ['b', 'c'], message: expect.stringMatching(/Nothing was written.*b \(now revision [0-9a-f]{12}\), c \(deleted\)/) })
    expect(readFileSync(file('a'), 'utf8')).toBe(before.a)
    expect(readFileSync(file('b'), 'utf8')).toBe(before.b)
    expect(existsSync(file('c'))).toBe(false)
    expect(existsSync(file('a2'))).toBe(false)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('refuses to create a task that exists and to overwrite an invalid file', async () => {
    await store.write([{ task: task('a'), baseRevision: null }])
    await expect(store.write([{ task: task('a'), baseRevision: null }])).rejects.toMatchObject({ ids: ['a'], message: expect.stringContaining('a (already exists') })
    writeFileSync(file('a'), '---\nid: a\n---\n')
    const revision = store.list()[0].revision
    await expect(store.write([{ task: task('a'), baseRevision: revision }])).rejects.toThrow('aide/tasks/a.md is invalid; fix the file by hand first')
  })

  it('refuses an invalid task and a task twice in one write', async () => {
    await expect(store.write([{ task: task('a', { rank: 1, status: 'done' }), baseRevision: null }])).rejects.toThrow('"rank" is only for backlog and planned tasks')
    await expect(store.write([{ task: task('a'), baseRevision: null }, { task: task('a'), baseRevision: null }])).rejects.toThrow('appears twice')
    expect(existsSync(file('a'))).toBe(false)
  })
})

describe('the write lease', () => {
  it('is taken by creating the file exclusively, and serialises writers', async () => {
    const other = new TaskStore(dir, join(dir, '.aide', 'users', 'bob', 'tasks'), { user: 'bob', host: 'pc2' })
    const results = await Promise.all([store.write([{ task: task('a'), baseRevision: null }]), other.write([{ task: task('b'), baseRevision: null }])])
    expect(Object.keys(results[0])).toEqual(['a'])
    expect(Object.keys(results[1])).toEqual(['b'])
    expect(store.list().map((e) => e.id)).toEqual(['a', 'b'])
    expect(existsSync(lockPath())).toBe(false)
  })

  it('takes over an expired lease', async () => {
    writeLease(Date.now() - 1000)
    await store.write([{ task: task('a'), baseRevision: null }])
    expect(existsSync(file('a'))).toBe(true)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('takes over an unreadable lease once it is older than the lease time', async () => {
    mkdirSync(tasksDir(), { recursive: true })
    writeFileSync(lockPath(), '')
    const { utimesSync } = await import('fs')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath(), old, old)
    await store.write([{ task: task('a'), baseRevision: null }])
    expect(existsSync(file('a'))).toBe(true)
  })

  it('waits for a held lease to change, not for a timer', async () => {
    writeLease(Date.now() + 8000) // longer than the test's timeout: only the file's change can end the wait
    let done = false
    const writing = store.write([{ task: task('a'), baseRevision: null }]).then(() => { done = true })
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    expect(existsSync(file('a'))).toBe(false)
    unlinkSync(lockPath())
    await writing
    expect(existsSync(file('a'))).toBe(true)
  })

  it('a held lease that is never released is waited for until it expires, then taken over', async () => {
    const expires = Date.now() + 300
    writeLease(expires)
    await store.write([{ task: task('a'), baseRevision: null }])
    expect(Date.now()).toBeGreaterThanOrEqual(expires)
    expect(existsSync(file('a'))).toBe(true)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('treats EPERM on the exclusive create as a lease that exists while the file is there, and waits for it to go', async () => {
    writeLease(Date.now() + 8000)
    faults.pendingDelete = true
    let done = false
    const writing = store.write([{ task: task('a'), baseRevision: null }]).then(() => { done = true })
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    // One attempt, then a wait for the lease file's change: no spinning on the unreadable file.
    expect(faults.leaseOpens).toBe(1)
    faults.pendingDelete = false
    unlinkSync(lockPath())
    await writing
    expect(existsSync(file('a'))).toBe(true)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('reports EPERM on the exclusive create when there is no lease file', async () => {
    faults.pendingDelete = true
    await expect(store.write([{ task: task('a'), baseRevision: null }])).rejects.toThrow('EPERM')
    expect(existsSync(file('a'))).toBe(false)
  })

  it('does not remove a lease another writer took over', async () => {
    // A lease written by someone else while this store writes: release must leave it.
    const original = TaskStore.prototype as unknown as { releaseLease: (lease: unknown) => void }
    const release = original.releaseLease
    const spy = vi.spyOn(original, 'releaseLease').mockImplementation(function (this: TaskStore, lease: unknown) {
      writeLease(Date.now() + 5000, 'carol')
      release.call(this, lease)
    })
    await store.write([{ task: task('a'), baseRevision: null }])
    spy.mockRestore()
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).user).toBe('carol')
  })
})

describe('TaskStore.problems', () => {
  it('reports duplicate ids, invalid files and history pointing at a task that is not closed', async () => {
    await store.write([
      { task: task('a'), baseRevision: null },
      { task: task('new', { status: 'active' }), baseRevision: null },
      { task: task('old', { status: 'done', closed: '2026-11-21T00:00:00Z', history: { at: '2026-11-21T00:00:00Z', by: 'new', reason: 'superseded' } }), baseRevision: null },
      { task: task('gone', { status: 'cancelled', history: { at: '2026-11-21T00:00:00Z', by: 'missing', reason: 'superseded' } }), baseRevision: null },
      { task: task('fine', { status: 'done', history: { at: '2026-11-21T00:00:00Z', by: 'closer', reason: 'superseded' } }), baseRevision: null },
      { task: task('closer', { status: 'done' }), baseRevision: null },
      { task: task('alone', { status: 'done', history: { at: '2026-11-21T00:00:00Z', by: null, reason: 'no longer true' } }), baseRevision: null }
    ])
    writeFileSync(file('a-copy'), readFileSync(file('a')))
    const problems = store.problems()
    expect(problems).toEqual(expect.arrayContaining([
      { kind: 'duplicate-id', ids: ['a'], message: 'Task id "a" is used by 2 files: aide/tasks/a-copy.md, aide/tasks/a.md.' },
      { kind: 'invalid', ids: ['a-copy'], message: expect.stringContaining('"id" is "a" but the file is a-copy.md') },
      { kind: 'dangling-history', ids: ['old', 'new'], message: expect.stringContaining('"new", which is active, not closed') },
      { kind: 'dangling-history', ids: ['gone', 'missing'], message: expect.stringContaining('"missing", which does not exist') }
    ]))
    expect(problems).toHaveLength(4)
  })

  it('is empty for a consistent tracker', async () => {
    expect(store.problems()).toEqual([])
    await store.write([{ task: task('a'), baseRevision: null }])
    expect(store.problems()).toEqual([])
  })
})

describe('isTrackerPath', () => {
  it('matches files under aide/tasks only', () => {
    expect(isTrackerPath('aide/tasks/a.md')).toBe(true)
    expect(isTrackerPath('aide\\tasks\\config.json')).toBe(true)
    expect(isTrackerPath('aide/tasks-old/a.md')).toBe(false)
    expect(isTrackerPath('src/aide/tasks/a.md')).toBe(false)
  })
})
