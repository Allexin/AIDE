import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { EventRelay, eventMessage } from './eventRelay'
import { pipelineEvents, type EventDelivery } from './events'
import { orchestrators } from './orchestrators'
import { tabActivity } from '../pty/tabActivity'
import { ptyRegistry } from '../pty/registry'
import type { PtyManager } from '../pty/ptyManager'
import { logEvent } from '../diagnostics'

vi.mock('../diagnostics', () => ({ logEvent: vi.fn() }))

const PROJECT = '/projects/relay'
const TAB = 'tab-9'

/** A PTY manager holding one tab, recording what is submitted to it. */
function fakeTabs(toolId = 'claude-code', submitted = true): { sent: string[] } {
  const sent: string[] = []
  const mgr = {
    getTabs: () => [{ tabId: TAB, sessionId: 's', toolId, toolName: toolId }],
    submitWhenReady: async (tabId: string, text: string) => { sent.push(`${tabId}: ${text}`); tabActivity.markBusy(tabId); return submitted }
  } as unknown as PtyManager
  ptyRegistry.set({} as never, mgr)
  return { sent }
}

const detach: Array<() => void> = []

type Emit = (type: string, data?: Record<string, unknown>, delivery?: Partial<EventDelivery>) => void

function setup(enabled = true, submitted = true): { manager: EventEmitter; sent: string[]; emit: Emit } {
  const manager = new EventEmitter()
  const { sent } = fakeTabs('claude-code', submitted)
  detach.push(new EventRelay(manager as never, () => enabled).attach())
  let id = 10
  const emit: Emit = (type, data = {}, delivery = {}) => {
    manager.emit('event', PROJECT, 'run-1', type, { summary: `${type} happened`, ...data }, ++id, { covering: 0, other: 0, handedTo: 0, ...delivery })
  }
  return { manager, sent, emit }
}

/** The publish path a real engine event takes, through the bus and then the manager. */
function publishThrough(manager: EventEmitter, runId: string, type: 'escalation' | 'plan_attention', data: Record<string, unknown> = {}): number {
  const { event, delivery } = pipelineEvents.publish(PROJECT, runId, type, { summary: `${type} happened`, ...data })
  manager.emit('event', PROJECT, runId, type, event.data, event.id, delivery)
  return event.id
}

const flushed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const trail = (): Array<Record<string, unknown>> => vi.mocked(logEvent).mock.calls.filter(([kind]) => kind === 'pipeline-event-delivery').map(([, data]) => data as Record<string, unknown>)

beforeEach(() => vi.mocked(logEvent).mockClear())

afterEach(() => {
  for (const stop of detach.splice(0)) stop()
  ptyRegistry.clear()
  orchestrators.forgetProject(PROJECT)
  tabActivity.forget(TAB)
  pipelineEvents.reset(PROJECT)
})

describe('eventMessage', () => {
  it('tells what happened, what to do and how to wait again', () => {
    const text = eventMessage([{ id: 57, runId: 'run-1', type: 'escalation', data: { escalationId: 'esc-3', summary: 'step escalation at review: tests fail', message: 'Two tests fail.', actions: ['continue', 'retry', 'stop'] } }])
    expect(text).toContain('you were not waiting for pipeline events')
    expect(text).toContain('escalation esc-3')
    expect(text).toContain('Decide with pipeline_answer (escalationId esc-3, action: continue, retry, stop)')
    expect(text).toContain('call pipeline_wait for run run-1 with since=57')
  })

  it('points to the report when the run ended, without asking to wait', () => {
    const text = eventMessage([{ id: 3, runId: 'run-1', type: 'run_finished', data: { summary: 'all steps done' } }])
    expect(text).toContain('finished — all steps done')
    expect(text).toContain('pipeline_report')
    expect(text).not.toContain('pipeline_wait')
  })
})

describe('EventRelay', () => {
  it('sends nothing when a waiter took the event, or for progress events', async () => {
    const { sent, emit } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markIdle(TAB)
    emit('escalation', {}, { covering: 1, handedTo: 1 })
    emit('node_finished')
    await flushed()
    expect(sent).toEqual([])
  })

  it('types the event into the last tab once it is idle', async () => {
    const { sent, emit } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markBusy(TAB)
    emit('run_paused')
    emit('escalation', { escalationId: 'esc-1' })
    await flushed()
    expect(sent).toEqual([])
    tabActivity.markIdle(TAB)
    await flushed()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Run run-1: run_paused — run_paused happened.')
    expect(sent[0]).toContain('escalation esc-1')
  })

  it('types an event when the only wait is scoped to another run', async () => {
    const { manager, sent } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markIdle(TAB)
    pipelineEvents.subscribe(PROJECT, { covers: (e) => e.runId === 'run-1', deliver: () => { throw new Error('must not be called') } })
    publishThrough(manager, 'run-2', 'escalation')
    await flushed()
    expect(sent).toHaveLength(1)
    expect(trail()[0]).toMatchObject({ covering: 0, other: 1 })
  })

  it('types an event whose waiter can no longer write it', async () => {
    const { manager, sent } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markIdle(TAB)
    pipelineEvents.subscribe(PROJECT, { covers: () => true, deliver: () => false })
    publishThrough(manager, 'run-1', 'escalation')
    await flushed()
    expect(sent).toHaveLength(1)
  })

  it('keeps the queued events no waiter received when flushing', async () => {
    const { manager, sent } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markBusy(TAB)
    const received = publishThrough(manager, 'run-1', 'escalation', { escalationId: 'esc-received' })
    publishThrough(manager, 'run-1', 'escalation', { escalationId: 'esc-missed' })
    // A wait reads its backlog: it takes the first event, and the second stays unread.
    pipelineEvents.handOut(PROJECT, received)
    tabActivity.markIdle(TAB)
    await flushed()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('esc-missed')
    expect(sent[0]).not.toContain('esc-received')
    expect(trail()).toContainEqual(expect.objectContaining({ id: received, outcome: 'handed-to-waiter', via: 'backlog' }))
  })

  it('keeps every queued event when a wait asked with a later since and received none', async () => {
    const { manager, sent } = setup()
    orchestrators.touch(PROJECT, TAB)
    publishThrough(manager, 'run-1', 'escalation', { escalationId: 'esc-a' })
    tabActivity.markIdle(TAB)
    await flushed()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('esc-a')
  })

  it('sends a queued event again when the response that carried it could not be written', async () => {
    const { manager, sent } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markIdle(TAB)
    const { event, delivery } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', { summary: 'escalation happened', escalationId: 'esc-lost' })
    expect(delivery.handedTo).toBe(0)
    pipelineEvents.handOut(PROJECT, event.id)
    manager.emit('event', PROJECT, 'run-1', 'escalation', event.data, event.id, { covering: 1, other: 0, handedTo: 1 })
    await flushed()
    expect(sent).toEqual([])

    pipelineEvents.undelivered(PROJECT, event)
    await flushed()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('esc-lost')
  })

  it('sends nowhere without a tab that called the pipeline, or with the setting off', async () => {
    const off = setup(false)
    tabActivity.markIdle(TAB)
    off.emit('escalation')
    orchestrators.touch(PROJECT, TAB)
    off.emit('escalation')
    await flushed()
    expect(off.sent).toEqual([])
  })
})

describe('delivery trail', () => {
  it('records a handed-out event with the waiters that covered it', () => {
    const { emit } = setup()
    emit('escalation', {}, { covering: 1, other: 2, handedTo: 1 })
    expect(trail()).toEqual([expect.objectContaining({ id: 11, type: 'escalation', runId: 'run-1', covering: 1, other: 2, outcome: 'handed-to-waiter' })])
  })

  it('records queued and then typed, with the tab', async () => {
    const { emit } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markBusy(TAB)
    emit('escalation')
    await flushed()
    expect(trail()).toEqual([expect.objectContaining({ outcome: 'queued', tabId: TAB })])
    tabActivity.markIdle(TAB)
    await flushed()
    expect(trail()).toContainEqual(expect.objectContaining({ id: 11, outcome: 'typed', tabId: TAB }))
  })

  it('records why an event went nowhere: no tab known, or the setting off', async () => {
    const off = setup(false)
    tabActivity.markIdle(TAB)
    off.emit('escalation')
    orchestrators.touch(PROJECT, TAB)
    off.emit('run_paused')
    await flushed()
    expect(trail().map((entry) => entry.outcome)).toEqual(['no-tab', 'setting-off'])
    expect(trail()[0].tabId).toBeNull()
  })

  it('records a submit that failed', async () => {
    const failing = setup(true, false)
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markIdle(TAB)
    failing.emit('escalation')
    await flushed()
    expect(trail()).toContainEqual(expect.objectContaining({ outcome: 'submit-failed', tabId: TAB }))
  })

  it('records no progress events', async () => {
    const { emit } = setup()
    emit('node_finished')
    emit('loop_repeated')
    await flushed()
    expect(trail()).toEqual([])
  })
})
