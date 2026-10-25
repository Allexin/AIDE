import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { EventRelay, eventMessage } from './eventRelay'
import { pipelineEvents } from './events'
import { orchestrators } from './orchestrators'
import { tabActivity } from '../pty/tabActivity'
import { ptyRegistry } from '../pty/registry'
import type { PtyManager } from '../pty/ptyManager'

const PROJECT = '/projects/relay'
const TAB = 'tab-9'

/** A PTY manager holding one tab, recording what is submitted to it. */
function fakeTabs(toolId = 'claude-code'): { sent: string[] } {
  const sent: string[] = []
  const mgr = {
    getTabs: () => [{ tabId: TAB, sessionId: 's', toolId, toolName: toolId }],
    submitWhenReady: async (tabId: string, text: string) => { sent.push(`${tabId}: ${text}`); tabActivity.markBusy(tabId); return true }
  } as unknown as PtyManager
  ptyRegistry.set({} as never, mgr)
  return { sent }
}

function setup(enabled = true): { manager: EventEmitter; sent: string[]; emit: (type: string, data?: Record<string, unknown>, observed?: boolean) => void } {
  const manager = new EventEmitter()
  const { sent } = fakeTabs()
  new EventRelay(manager as never, () => enabled).attach()
  let id = 10
  const emit = (type: string, data: Record<string, unknown> = {}, observed = false): void => {
    manager.emit('event', PROJECT, 'run-1', type, { summary: `${type} happened`, ...data }, ++id, observed)
  }
  return { manager, sent, emit }
}

const flushed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
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
  it('sends nothing while an orchestrator waits, or for progress events', async () => {
    const { sent, emit } = setup()
    orchestrators.touch(PROJECT, TAB)
    tabActivity.markIdle(TAB)
    emit('escalation', {}, true)
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

  it('drops the message when the orchestrator asks for events before the tab is idle', async () => {
    const { sent, emit } = setup()
    orchestrators.touch(PROJECT, TAB)
    emit('escalation')
    pipelineEvents.noteObserver(PROJECT)
    tabActivity.markIdle(TAB)
    await flushed()
    expect(sent).toEqual([])
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
