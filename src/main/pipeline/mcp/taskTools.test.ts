import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolContext, ToolResult } from './protocol'
import { NO_TAB_TEXT, buildTaskTools } from './taskTools'
import { buildPipelineTools } from './tools'
import { TaskService } from '../../tasks/taskService'

vi.mock('../../diagnostics', () => ({ logEvent: vi.fn() }))

let dir = ''
let service: TaskService
const LIVE = new Set(['tab-3'])

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aide-task-tools-'))
  service = new TaskService({ userDir: () => join(dir, '.aide', 'users', 'alice', 'tasks'), user: () => 'alice', owner: { user: 'alice', host: 'pc1' } })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const tools = (): ReturnType<typeof buildTaskTools> => buildTaskTools(() => ({ tasks: service, guide: () => 'GUIDE', liveTab: (tabId) => LIVE.has(tabId) }))
const context = (tabId: string | null): ToolContext => ({ projectPath: dir, connectionId: 'c', tabId, clientInfo: null })
async function call(name: string, args: Record<string, unknown> = {}, tabId: string | null = 'tab-3'): Promise<ToolResult> {
  const tool = tools().find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.handler(args, context(tabId))
}
const revision = async (id: string): Promise<string> => JSON.parse((await call('task_get', { id }, null)).text).revision as string

const WRITE_TOOLS: [string, Record<string, unknown>][] = [
  ['task_create', { title: 'T' }],
  ['task_update', { id: 't', baseRevision: 'r', fields: {} }],
  ['task_start', { id: 't' }],
  ['task_note', { id: 't', text: 'x' }],
  ['task_close', { id: 't', baseRevision: 'r', outcome: 'done' }],
  ['task_reopen', { id: 't', reason: 'x' }],
  ['task_to_history', { id: 't' }],
  ['task_restore', { id: 't' }]
]

describe('task tools', () => {
  it('are registered on the pipeline MCP server next to the plan tools', () => {
    const names = buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l' })).map((t) => t.name)
    for (const name of ['task_guide', 'task_snapshot', 'task_search', 'task_get', ...WRITE_TOOLS.map(([n]) => n)]) expect(names).toContain(name)
  })

  it('every write tool fails without a live tab id, writing nothing; read tools work without one', async () => {
    for (const tabId of [null, 'tab-99']) {
      for (const [name, args] of WRITE_TOOLS) {
        expect(await call(name, args, tabId)).toEqual({ text: NO_TAB_TEXT, isError: true })
      }
    }
    expect(service.store(dir).list()).toEqual([])
    expect((await call('task_guide', {}, null)).text).toBe('GUIDE')
    expect((await call('task_search', {}, null)).text).toBe('No matching tasks.')
    expect((await call('task_snapshot', {}, null)).isError).toBeUndefined()
  })

  it('round trip: create, get, update, start, note, close with supersedes, search, reopen, history, restore', async () => {
    expect((await call('task_create', { title: 'Old titles', status: 'done', label: 'Titles', claim: 'Titles v1.', source: 'STAGES.md' })).text).toMatch(/^Task old-titles created, revision [0-9a-f]{12}\.$/)
    expect((await call('task_create', { title: 'Better titles' })).text).toContain('Task better-titles created')
    const created = JSON.parse((await call('task_get', { id: 'old-titles' }, null)).text)
    expect(created.task).toMatchObject({ status: 'done', confirmed: null, source: 'STAGES.md' })
    expect(created.task.journal).toEqual([expect.stringMatching(/created by alice\/tab 3$/)])

    expect((await call('task_update', { id: 'better-titles', baseRevision: await revision('better-titles'), fields: { status: 'planned', rank: 1, tags: ['terminal'] } })).text).toMatch(/^Updated, revision/)
    const refused = await call('task_update', { id: 'better-titles', baseRevision: await revision('better-titles'), fields: { status: 'done' } })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('cannot go from planned to done')
    expect(refused.text).toContain('task_update changes status only')

    expect((await call('task_start', { id: 'better-titles' })).text).toContain('is active and the current task of this tab')
    expect(JSON.parse((await call('task_get', { id: 'better-titles' }, null)).text).tabs).toEqual(['tab-3'])
    expect((await call('task_note', { id: 'better-titles', text: 'kept out of JSONL' })).text).toMatch(/^Noted/)

    const closed = await call('task_close', { id: 'better-titles', baseRevision: await revision('better-titles'), outcome: 'done', label: 'Titles', claim: 'Titles v2.', supersedes: ['old-titles'] })
    expect(closed.text).toContain('Task better-titles closed done')
    expect(closed.text).toContain('To history: old-titles.')
    const detail = JSON.parse((await call('task_get', { id: 'better-titles' }, null)).text)
    expect(detail.chain.earlier.map((t: { id: string }) => t.id)).toEqual(['old-titles'])
    expect(detail.tabs).toEqual([])

    expect(JSON.parse((await call('task_search', { query: 'titles' }, null)).text).map((h: { id: string }) => h.id)).toEqual(['better-titles'])
    expect(JSON.parse((await call('task_search', { query: 'titles', history: true }, null)).text).map((h: { id: string }) => h.id)).toEqual(['better-titles', 'old-titles'])

    expect((await call('task_reopen', { id: 'better-titles', reason: 'missing tooltip' })).text).toContain('reopened')
    await call('task_close', { id: 'better-titles', baseRevision: await revision('better-titles'), outcome: 'done' })
    expect((await call('task_to_history', { id: 'better-titles', reason: 'gone' })).text).toContain('is in history')
    expect((await call('task_restore', { id: 'better-titles' })).text).toContain('restored')
  })

  it('a stale baseRevision is refused with the conflict text', async () => {
    await call('task_create', { id: 'a', title: 'A' })
    const stale = await revision('a')
    await call('task_note', { id: 'a', text: 'changed' })
    const result = await call('task_update', { id: 'a', baseRevision: stale, fields: { title: 'B' } })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^Nothing was written: these tasks changed since you read them: a \(now revision [0-9a-f]{12}\)\. Read them again and retry\.$/)
  })

  it('task_get refuses an id that is not a slug', async () => {
    const result = await call('task_get', { id: '../../x' }, null)
    expect(result).toMatchObject({ isError: true })
    expect(result.text).toContain('is not a task id')
  })
})

describe('the tracker tail and task_snapshot', () => {
  const server = (): ReturnType<typeof buildPipelineTools> => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', tasks: service, guide: () => 'GUIDE', liveTab: (tabId) => LIVE.has(tabId) }))
  async function on(connectionId: string, tabId: string | null, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const tool = server().find((t) => t.name === name)!
    return (await tool.handler(args, { projectPath: dir, connectionId, tabId, clientInfo: null })).text
  }
  const TAIL = '— tracker since your last call:'

  it('a result gets the tail only when something changed for that connection since its last tail, at most 5 items', async () => {
    service.beginConnection(dir, 'agent') // the tab's session starts
    service.beginConnection(dir, 'other') // a headless session starts
    expect(await on('other', null, 'task_search')).toBe('No matching tasks.')

    expect(await on('agent', 'tab-3', 'task_create', { id: 'a', title: 'A' })).not.toContain(TAIL)
    // The connection that made the change is not told about it; the other one is, once.
    expect(await on('agent', 'tab-3', 'task_search')).not.toContain(TAIL)
    expect(await on('other', null, 'task_search')).toContain(`\n\n${TAIL} task a created by alice/tab 3.`)
    expect(await on('other', null, 'task_search')).not.toContain(TAIL)

    // A notice of a change that changed nothing (the watcher's echo of a write) brings no tail.
    service.notifyDiskChange(dir)
    await Promise.resolve()
    expect(await on('other', null, 'task_search')).not.toContain(TAIL)

    for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) await on('agent', 'tab-3', 'task_create', { id, title: id.toUpperCase() })
    // Plan and pipeline results carry it too.
    const result = await on('other', null, 'pipeline_schema')
    expect(result.slice(result.indexOf(TAIL))).toBe(`${TAIL} task b created by alice/tab 3; task c created by alice/tab 3; task d created by alice/tab 3; task e created by alice/tab 3; task f created by alice/tab 3; and 1 more.`)
    expect(await on('other', null, 'toolbar_guide')).not.toContain(TAIL)
  })

  it('task_snapshot shows the tab its task and counts as seen', async () => {
    service.beginConnection(dir, 'agent')
    service.beginConnection(dir, 'other')
    await on('agent', 'tab-3', 'task_create', { id: 'work', title: 'The work', description: 'What to do.' })
    await on('agent', 'tab-3', 'task_start', { id: 'work' })
    const snapshot = await on('other', null, 'task_snapshot')
    expect(snapshot).not.toContain(TAIL)
    expect(snapshot).toContain('- active work: The work — alice/tab 3')
    expect(await on('other', null, 'task_search')).not.toContain(TAIL)
    const mine = await on('agent', 'tab-3', 'task_snapshot')
    expect(mine).toContain("## This tab's task\nThe work (work), active\nWhat to do.")
  })
})
