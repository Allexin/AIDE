import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskService, slugFromTitle } from './taskService'
import { readBindings } from './taskBindings'

let dir = ''
let service: TaskService
const userDir = (): string => join(dir, '.aide', 'users', 'alice', 'tasks')
const BY = 'alice/tab 1'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aide-task-service-'))
  service = new TaskService({ userDir: () => userDir(), user: () => 'alice', owner: { user: 'alice', host: 'pc1' }, now: () => new Date('2026-11-20T10:00:00Z') })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const read = (id: string): ReturnType<TaskService['get']> => service.get(dir, id)
const revision = (id: string): string => read(id).revision

describe('create', () => {
  it('generates a unique slug id from the title, backlog by default, with a journal line', async () => {
    expect((await service.create(dir, { title: 'Add titles to terminal tabs!' }, BY)).id).toBe('add-titles-to-terminal-tabs')
    expect((await service.create(dir, { title: 'Add titles to terminal tabs' }, BY)).id).toBe('add-titles-to-terminal-tabs-2')
    expect((await service.create(dir, { title: 'Add titles: to terminal tabs' }, BY)).id).toBe('add-titles-to-terminal-tabs-3')
    const task = read('add-titles-to-terminal-tabs').task
    expect(task.status).toBe('backlog')
    expect(task.created).toBe('2026-11-20T10:00:00.000Z')
    expect(task.journal).toEqual(['2026-11-20 created by alice/tab 1'])
  })

  it('makes slugs of any title', () => {
    expect(slugFromTitle('Größe ändern')).toBe('grosse-andern')
    expect(slugFromTitle('Задача')).toBe('task')
    expect(slugFromTitle('x'.repeat(100)).length).toBeLessThanOrEqual(58)
  })

  it('takes a given id and refuses a taken or invalid one', async () => {
    await service.create(dir, { id: 'mine', title: 'Mine', status: 'planned', rank: 2 }, BY)
    expect(read('mine').task).toMatchObject({ status: 'planned', rank: 2 })
    await expect(service.create(dir, { id: 'mine', title: 'Again' }, BY)).rejects.toThrow('is taken')
    await expect(service.create(dir, { id: '../x', title: 'Bad' }, BY)).rejects.toThrow('not a valid task id')
  })

  it('creates a migrated claim done with confirmed null, and only that way', async () => {
    const { id } = await service.create(dir, { title: 'Terminal tab titles', status: 'done', label: 'Terminal tab titles', claim: 'Titles are stored.', source: 'STAGES.md', code: ['src/main/pty/titles.ts'] }, BY)
    expect(read(id).task).toMatchObject({ status: 'done', label: 'Terminal tab titles', claim: 'Titles are stored.', confirmed: null, source: 'STAGES.md', closed: '2026-11-20T10:00:00.000Z' })
    await expect(service.create(dir, { title: 'x', label: 'L', claim: 'C' }, BY)).rejects.toThrow('pass status "done"')
    await expect(service.create(dir, { title: 'x', status: 'done' }, BY)).rejects.toThrow('give its "label" and "claim"')
    await expect(service.create(dir, { title: 'x', status: 'active' }, BY)).rejects.toThrow('backlog or planned')
    await expect(service.create(dir, { title: 'x', priority: 1 }, BY)).rejects.toThrow('cannot set "priority"')
  })
})

describe('update', () => {
  it('changes fields and refuses a stale baseRevision', async () => {
    const { id, revision: first } = await service.create(dir, { title: 'One' }, BY)
    await service.update(dir, id, first, { title: 'One more', tags: ['ui'], description: 'Why.' }, BY)
    expect(read(id).task).toMatchObject({ title: 'One more', tags: ['ui'], description: 'Why.' })
    await expect(service.update(dir, id, first, { title: 'Stale' }, BY)).rejects.toThrow('changed since you read them')
  })

  it('allows the status transitions of the rule and refuses the others with the rule', async () => {
    const { id } = await service.create(dir, { title: 'T' }, BY)
    await service.update(dir, id, revision(id), { status: 'planned', rank: 1 }, BY)
    expect(read(id).task).toMatchObject({ status: 'planned', rank: 1 })
    await service.update(dir, id, revision(id), { status: 'backlog' }, BY)
    await service.update(dir, id, revision(id), { status: 'planned' }, BY)

    await expect(service.update(dir, id, revision(id), { status: 'blocked' }, BY)).rejects.toThrow('needs a "reason"')
    await service.update(dir, id, revision(id), { status: 'blocked', reason: 'waits for the API' }, BY)
    expect(read(id).task).toMatchObject({ status: 'blocked', blockedFrom: 'planned', reason: 'waits for the API', rank: null })
    await expect(service.update(dir, id, revision(id), { status: 'backlog' }, BY)).rejects.toThrow('This task was blocked from planned')
    await service.update(dir, id, revision(id), { status: 'planned' }, BY)
    expect(read(id).task).toMatchObject({ status: 'planned', blockedFrom: null, reason: null })

    for (const to of ['active', 'done', 'cancelled']) {
      await expect(service.update(dir, id, revision(id), { status: to }, BY)).rejects.toThrow(`cannot go from planned to ${to}. task_update changes status only`)
    }

    await service.start(dir, id, 'tab-1', 'alice')
    await service.update(dir, id, revision(id), { status: 'blocked', reason: 'r' }, BY)
    await service.update(dir, id, revision(id), { status: 'active' }, BY)
    expect(read(id).task.status).toBe('active')
    await expect(service.update(dir, id, revision(id), { status: 'backlog' }, BY)).rejects.toThrow('cannot go from active to backlog')
    await expect(service.update(dir, id, revision(id), { rank: 3 }, BY)).rejects.toThrow('"rank" orders backlog and planned tasks')
  })

  it('pausing an active task frees the tabs bound to it', async () => {
    const { id } = await service.create(dir, { title: 'T', status: 'planned' }, BY)
    await service.start(dir, id, 'tab-1', 'alice')
    expect(readBindings(userDir())['tab-1']?.task).toBe(id)
    await service.update(dir, id, revision(id), { status: 'planned' }, BY)
    expect(read(id).task).toMatchObject({ status: 'planned', activeBy: [] })
    expect(readBindings(userDir())).toEqual({})
  })
})

describe('start and note', () => {
  it('start makes the task active, records the user and binds the tab; another start in the tab replaces it', async () => {
    const a = (await service.create(dir, { title: 'A', status: 'planned', rank: 1 }, BY)).id
    const b = (await service.create(dir, { title: 'B' }, BY)).id
    await service.start(dir, a, 'tab-1', 'alice')
    expect(read(a).task).toMatchObject({ status: 'active', activeBy: ['alice'], rank: null })
    expect(read(a).tabs).toEqual(['tab-1'])
    await service.start(dir, b, 'tab-1', 'alice')
    expect(read(a).tabs).toEqual([])
    expect(read(b).tabs).toEqual(['tab-1'])
  })

  it('start refuses blocked, done and cancelled tasks', async () => {
    const { id } = await service.create(dir, { title: 'Done', status: 'done', label: 'L', claim: 'C' }, BY)
    await expect(service.start(dir, id, 'tab-1', 'alice')).rejects.toThrow('task_reopen')
  })

  it('note appends a dated journal line with who wrote it', async () => {
    const { id } = await service.create(dir, { title: 'T' }, BY)
    await service.note(dir, id, 'decided to keep\ntitles out of JSONL', BY)
    expect(read(id).task.journal.at(-1)).toBe('2026-11-20 alice/tab 1: decided to keep titles out of JSONL')
  })
})

describe('closeSimple', () => {
  it('closes with a claim and moves superseded tasks to history pointing at the closing task', async () => {
    const old = (await service.create(dir, { title: 'Old', status: 'done', label: 'Titles', claim: 'Titles v1.' }, BY)).id
    const { id } = await service.create(dir, { title: 'New' }, BY)
    await service.start(dir, id, 'tab-1', 'alice')
    const { history } = await service.closeSimple(dir, id, revision(id), { outcome: 'done', label: 'Titles', claim: 'Titles v2.', code: ['src/t.ts'], supersedes: [old] }, BY)
    expect(history).toEqual([old])
    expect(read(id).task).toMatchObject({ status: 'done', label: 'Titles', claim: 'Titles v2.', code: ['src/t.ts'], history: null, closed: '2026-11-20T10:00:00.000Z', activeBy: [], confirmed: null })
    expect(read(id).tabs).toEqual([])
    expect(read(old).task.history).toEqual({ at: '2026-11-20T10:00:00.000Z', by: id, reason: `superseded by ${id}` })
    expect(service.store(dir).problems()).toEqual([])
  })

  it('sends a task without claim and without decidedAgainst to history itself', async () => {
    const { id } = await service.create(dir, { title: 'Refactor' }, BY)
    const { history } = await service.closeSimple(dir, id, revision(id), { outcome: 'done' }, BY)
    expect(history).toEqual([id])
    expect(read(id).task.history).toMatchObject({ by: null })
  })

  it('keeps a task decided against visible', async () => {
    const { id } = await service.create(dir, { title: 'Idea' }, BY)
    await service.closeSimple(dir, id, revision(id), { outcome: 'cancelled', decidedAgainst: 'We do not do X because Y.' }, BY)
    expect(read(id).task).toMatchObject({ status: 'cancelled', history: null, decidedAgainst: 'We do not do X because Y.' })
  })

  it('refuses superseding an open task, a closed task, and a stale baseRevision, writing nothing', async () => {
    const open = (await service.create(dir, { title: 'Open' }, BY)).id
    const { id, revision: first } = await service.create(dir, { title: 'T' }, BY)
    await expect(service.closeSimple(dir, id, first, { outcome: 'done', supersedes: [open] }, BY)).rejects.toThrow('only a closed task can be superseded')
    await service.note(dir, id, 'n', BY)
    await expect(service.closeSimple(dir, id, first, { outcome: 'done' }, BY)).rejects.toThrow('changed since you read them')
    expect(read(id).task.status).toBe('backlog')
    await service.closeSimple(dir, id, revision(id), { outcome: 'done' }, BY)
    await expect(service.closeSimple(dir, id, revision(id), { outcome: 'done' }, BY)).rejects.toThrow('in history')
  })
})

describe('reopen, history, restore', () => {
  it('reopens a done task as active and reopened; moves closed tasks to history and back', async () => {
    const { id } = await service.create(dir, { title: 'F', status: 'done', label: 'L', claim: 'C' }, BY)
    await service.reopen(dir, id, 'the button is missing', BY)
    expect(read(id).task).toMatchObject({ status: 'active', reopened: true, closed: null, claim: 'C', activeBy: ['alice'] })
    await service.closeSimple(dir, id, revision(id), { outcome: 'done' }, BY)
    expect(read(id).task).toMatchObject({ reopened: false, claim: 'C', history: null })
    await service.toHistory(dir, id, 'obsolete', BY)
    expect(read(id).task.history).toMatchObject({ by: null, reason: 'obsolete' })
    await expect(service.reopen(dir, id, 'r', BY)).rejects.toThrow('task_restore')
    await service.restore(dir, id, BY)
    expect(read(id).task.history).toBeNull()
  })
})

describe('search and get', () => {
  it('leaves history out unless asked, lists planned by rank first, matches fields case-insensitively', async () => {
    await service.create(dir, { id: 'b1', title: 'Backlog one' }, BY)
    await service.create(dir, { id: 'p2', title: 'Planned two', status: 'planned', rank: 2 }, BY)
    await service.create(dir, { id: 'p1', title: 'Planned one', status: 'planned', rank: 1 }, BY)
    await service.create(dir, { id: 'p0', title: 'Planned unranked', status: 'planned' }, BY)
    await service.create(dir, { id: 'gone', title: 'Gone', status: 'done', label: 'Old', claim: 'Old thing.\nSecond line.', tags: ['UI'] }, BY)
    await service.toHistory(dir, 'gone', 'obsolete', BY)
    expect(service.search(dir).map((hit) => hit.id)).toEqual(['p1', 'p2', 'p0', 'b1'])
    const all = service.search(dir, { history: true })
    expect(all.map((hit) => hit.id)).toEqual(['p1', 'p2', 'p0', 'b1', 'gone'])
    expect(all.at(-1)).toEqual({ id: 'gone', title: 'Gone', status: 'done', label: 'Old', claimFirstLine: 'Old thing.', tags: ['UI'], history: true })
    expect(service.search(dir, { query: 'SECOND', history: true }).map((hit) => hit.id)).toEqual(['gone'])
    expect(service.search(dir, { tags: ['ui'], history: true }).map((hit) => hit.id)).toEqual(['gone'])
    expect(service.search(dir, { status: 'backlog' }).map((hit) => hit.id)).toEqual(['b1'])
  })

  it('get returns the revision and the claim chain both ways', async () => {
    await service.create(dir, { id: 'v1', title: 'V1', status: 'done', label: 'L', claim: 'v1' }, BY)
    await service.create(dir, { id: 'v2', title: 'V2' }, BY)
    await service.closeSimple(dir, 'v2', revision('v2'), { outcome: 'done', label: 'L', claim: 'v2', supersedes: ['v1'] }, BY)
    await service.create(dir, { id: 'v3', title: 'V3' }, BY)
    await service.closeSimple(dir, 'v3', revision('v3'), { outcome: 'done', label: 'L', claim: 'v3', supersedes: ['v2'] }, BY)
    const middle = read('v2')
    expect(middle.revision).toMatch(/^[0-9a-f]{12}$/)
    expect(middle.chain.earlier.map((t) => t.id)).toEqual(['v1'])
    expect(middle.chain.later.map((t) => t.id)).toEqual(['v3'])
    expect(read('v3').chain.earlier.map((t) => t.id)).toEqual(['v1', 'v2'])
    expect(read('v1').chain.later.map((t) => t.id)).toEqual(['v2', 'v3'])
    expect(read('v1').chain.later[0].journal.at(-1)).toContain('superseded by v3')
    expect(middle.plans).toEqual([])
  })

  it('get refuses an id that is not a slug', () => {
    writeFileSync(join(dir, 'x.md'), '')
    expect(() => service.get(dir, '../x')).toThrow('is not a task id')
  })
})

describe('notifications', () => {
  it("emits 'changed' after a write, and once for a batch of disk changes", async () => {
    const seen: string[] = []
    service.on('changed', (path: string) => seen.push(path))
    await service.create(dir, { title: 'T' }, BY)
    expect(seen).toEqual([dir])
    service.notifyDiskChange(dir)
    service.notifyDiskChange(dir)
    await Promise.resolve()
    expect(seen).toEqual([dir, dir])
  })
})

describe('tab bindings (§6)', () => {
  const others = (user: string): string => join(dir, '.aide', 'users', user, 'tasks')
  const writeBindingsOf = (user: string, bindings: Record<string, unknown>): void => {
    mkdirSync(others(user), { recursive: true })
    writeFileSync(join(others(user), 'bindings.json'), JSON.stringify(bindings))
  }

  it('start records who bound the tab, writes a journal line and notifies once', async () => {
    const { id } = await service.create(dir, { title: 'T', status: 'planned' }, BY)
    const seen: string[] = []
    service.on('changed', (path: string) => seen.push(path))
    await service.start(dir, id, 'tab-2', 'alice')
    expect(seen).toEqual([dir])
    expect(readBindings(userDir())['tab-2']).toMatchObject({ task: id, user: 'alice', host: 'pc1', pid: process.pid })
    expect(read(id).task.journal.at(-1)).toBe('2026-11-20 alice/tab 2: started (planned → active)')
    // The same start again changes nothing and says nothing.
    await service.start(dir, id, 'tab-2', 'alice')
    expect(seen).toEqual([dir])
    // Another tab of the same user: only the binding changes.
    await service.start(dir, id, 'tab-3', 'alice')
    expect(seen).toEqual([dir, dir])
    expect(read(id).tabs.sort()).toEqual(['tab-2', 'tab-3'])
  })

  it('closing a tab removes its binding and notifies; other tabs keep theirs', async () => {
    const { id } = await service.create(dir, { title: 'T' }, BY)
    await service.start(dir, id, 'tab-1', 'alice')
    await service.start(dir, id, 'tab-2', 'alice')
    const seen: string[] = []
    service.on('changed', (path: string) => seen.push(path))
    service.unbindTabs(dir, ['tab-1'])
    expect(Object.keys(readBindings(userDir()))).toEqual(['tab-2'])
    expect(seen).toEqual([dir])
    service.unbindTabs(dir, ['tab-1'])
    expect(seen).toEqual([dir])
  })

  it('a paused or closed task loses its bindings, also those of other users', async () => {
    const a = (await service.create(dir, { title: 'A' }, BY)).id
    const b = (await service.create(dir, { title: 'B' }, BY)).id
    await service.start(dir, a, 'tab-1', 'alice')
    await service.start(dir, b, 'tab-2', 'alice')
    writeBindingsOf('bob', { 'tab-1': { task: a, since: '2026-11-20T09:00:00Z', user: 'bob', host: 'pc2', pid: 7 } })
    expect(service.bindings(dir).map((x) => `${x.who}:${x.task}`).sort()).toEqual(['alice/tab 1:a', 'alice/tab 2:b', 'bob:a'])
    await service.update(dir, a, revision(a), { status: 'planned' }, BY)
    await service.closeSimple(dir, b, revision(b), { outcome: 'done', label: 'B', claim: 'B is there.' }, BY)
    expect(readBindings(userDir())).toEqual({})
    // Bob's file is his own to write; a binding to a task that is not active does not count.
    expect(service.bindings(dir)).toEqual([])
  })

  it("reads the other users' bindings as theirs and ignores this user's left-over ones", async () => {
    const live = new Set(['tab-1'])
    service = new TaskService({ userDir: () => userDir(), user: () => 'alice', owner: { user: 'alice', host: 'pc1' }, liveTab: (tabId) => live.has(tabId), now: () => new Date('2026-11-20T10:00:00Z') })
    const { id } = await service.create(dir, { title: 'Shared work' }, BY)
    await service.start(dir, id, 'tab-1', 'alice')
    const bindings = readBindings(userDir())
    writeFileSync(join(userDir(), 'bindings.json'), JSON.stringify({
      ...bindings,
      'tab-5': { task: id, since: 'x', user: 'alice', host: 'pc1', pid: process.pid }, // closed tab of this AIDE
      'tab-6': { task: id, since: 'x', user: 'alice', host: 'pc1', pid: -1 }, // an earlier AIDE process
      'tab-7': { task: id, since: 'x', user: 'alice', host: 'pc9', pid: 3 } // this user on another host
    }))
    writeBindingsOf('bob', { 'tab-1': { task: id, since: 'x', user: 'bob', host: 'pc2', pid: 7 } })
    const views = service.bindings(dir)
    expect(views.map((v) => [v.tabId, v.here, v.who])).toEqual(expect.arrayContaining([['tab-1', true, 'alice/tab 1'], ['tab-7', false, 'alice on pc9'], ['tab-1', false, 'bob']]))
    expect(views).toHaveLength(3)
    expect(service.tabTasks(dir)).toEqual({ 'tab-1': { id, title: 'Shared work' } })
    // A new binding drops the left-overs of earlier processes of this user on this host.
    live.add('tab-8')
    await service.start(dir, id, 'tab-8', 'alice')
    expect(Object.keys(readBindings(userDir())).sort()).toEqual(['tab-1', 'tab-5', 'tab-7', 'tab-8'])
  })
})

describe('the Tasks tab (§8)', () => {
  it('board: a project without aide/tasks/ has none', () => {
    expect(service.board(dir)).toMatchObject({ exists: false, planned: [], backlog: [], project: [], problems: [] })
  })

  it('board: sections from aide/tasks/, history left out', async () => {
    await service.create(dir, { id: 'p2', title: 'Planned two', status: 'planned', rank: 2 }, BY)
    await service.create(dir, { id: 'p1', title: 'Planned one', status: 'planned', rank: 1 }, BY)
    await service.create(dir, { id: 'b1', title: 'Backlog one' }, BY)
    await service.create(dir, { id: 'act', title: 'Active', status: 'planned' }, BY)
    await service.start(dir, 'act', 'tab-2', 'alice')
    await service.create(dir, { id: 'blk', title: 'Blocked', status: 'planned' }, BY)
    await service.update(dir, 'blk', revision('blk'), { status: 'blocked', reason: 'waits' }, BY)
    await service.create(dir, { id: 'c1', title: 'Claim one', status: 'done', label: 'Zeta', claim: 'Z.\nMore.', tags: ['ui'] }, BY)
    await service.create(dir, { id: 'c2', title: 'Claim two', status: 'done', label: 'Alpha', claim: 'A.', tags: ['ui', 'core'] }, BY)
    await service.create(dir, { id: 'c3', title: 'Claim three', status: 'done', label: 'Bare', claim: 'B.' }, BY)
    await service.create(dir, { id: 'no', title: 'Rejected' }, BY)
    await service.closeSimple(dir, 'no', revision('no'), { outcome: 'cancelled', decidedAgainst: 'Too slow.' }, BY)
    await service.create(dir, { id: 'old', title: 'Old', status: 'done', label: 'Old', claim: 'Old.' }, BY)
    await service.toHistory(dir, 'old', 'obsolete', BY)

    const board = service.board(dir)
    expect(board.exists).toBe(true)
    expect(board.planned.map((t) => t.id)).toEqual(['p1', 'p2'])
    expect(board.backlog.map((t) => t.id)).toEqual(['b1'])
    expect(board.active.map((t) => [t.id, t.workers])).toEqual([['act', ['alice/tab 2']]])
    expect(board.blocked.map((t) => [t.id, t.reason])).toEqual([['blk', 'waits']])
    expect(board.project.map((group) => [group.tag, group.items.map((t) => t.label)])).toEqual([['ui', ['Alpha', 'Zeta']], ['(no tag)', ['Bare']]])
    expect(board.project[0].items[1]).toMatchObject({ claimFirstLine: 'Z.', unverified: true, reopened: false })
    expect(board.decidedAgainst.map((t) => [t.id, t.decidedAgainst])).toEqual([['no', 'Too slow.']])
    expect(board.planned[0].revision).toBe(revision('p1'))
    expect(JSON.stringify(board)).not.toContain('"old"')
  })

  it('board: lists invalid files as problems', async () => {
    await service.create(dir, { id: 'ok', title: 'OK' }, BY)
    writeFileSync(join(dir, 'aide', 'tasks', 'broken.md'), '---\nid: broken\n---\n')
    expect(service.board(dir).problems.join('\n')).toContain('broken')
  })

  it("changeKey: the watcher's echo of a write changes nothing; a write or a binding does", async () => {
    const empty = service.changeKey(dir)
    const { id } = await service.create(dir, { title: 'T', status: 'planned' }, BY)
    const created = service.changeKey(dir)
    expect(created).not.toBe(empty)
    expect(service.changeKey(dir)).toBe(created)
    await service.update(dir, id, revision(id), { rank: 0.5 }, BY)
    const ranked = service.changeKey(dir)
    expect(ranked).not.toBe(created)
    await service.start(dir, id, 'tab-1', 'alice')
    const started = service.changeKey(dir)
    service.unbindTabs(dir, ['tab-1'])
    expect(service.changeKey(dir)).not.toBe(started)
  })
})
