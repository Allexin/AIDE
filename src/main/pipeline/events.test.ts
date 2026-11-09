import { afterEach, describe, expect, it, vi } from 'vitest'
import { inWaitScope, pipelineEvents, type EventWaiter, type PipelineEvent } from './events'

const PROJECT = '/projects/events'

afterEach(() => pipelineEvents.reset(PROJECT))

const waiter = (covers: EventWaiter['covers'], deliver: EventWaiter['deliver'] = () => true): EventWaiter => ({ covers, deliver })

describe('inWaitScope', () => {
  it('covers the waited run, and everything for a wait on the whole project', () => {
    expect(inWaitScope('run-1', { runId: 'run-1', type: 'escalation' })).toBe(true)
    expect(inWaitScope('run-1', { runId: 'run-2', type: 'escalation' })).toBe(false)
    expect(inWaitScope(null, { runId: 'run-2', type: 'run_failed' })).toBe(true)
  })

  it('treats plan_attention as an event of the project, whatever run is waited for', () => {
    expect(inWaitScope('run-1', { runId: 'plan:p1', type: 'plan_attention' })).toBe(true)
    expect(inWaitScope(null, { runId: 'plan:p1', type: 'plan_attention' })).toBe(true)
  })
})

describe('publish', () => {
  it('delivers only to waiters whose filter covers the event, and counts per event', () => {
    const got: number[] = []
    pipelineEvents.subscribe(PROJECT, waiter((e) => e.runId === 'run-1', (e) => { got.push(e.id); return true }))
    pipelineEvents.subscribe(PROJECT, waiter((e) => e.runId === 'run-2', () => { throw new Error('must not be called') }))

    const { event, delivery } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {})

    expect(got).toEqual([event.id])
    expect(delivery).toEqual({ covering: 1, other: 1, handedTo: 1 })
    expect(pipelineEvents.wasHandedOut(PROJECT, event.id)).toBe(true)
  })

  it('counts a waiter whose connection is gone as not having received the event', () => {
    pipelineEvents.subscribe(PROJECT, waiter(() => true, () => false))
    const { event, delivery } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {})
    expect(delivery).toEqual({ covering: 1, other: 0, handedTo: 0 })
    expect(pipelineEvents.wasHandedOut(PROJECT, event.id)).toBe(false)
  })

  it('stops counting a waiter once it unsubscribed', () => {
    const stop = pipelineEvents.subscribe(PROJECT, waiter(() => true))
    stop()
    expect(pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {}).delivery).toEqual({ covering: 0, other: 0, handedTo: 0 })
  })

  it('since stays strict about the run: plan_attention appears only under its own id', () => {
    pipelineEvents.emit(PROJECT, 'plan:p1', 'plan_attention', {})
    expect(pipelineEvents.since(PROJECT, 'run-1', 0)).toEqual([])
    expect(pipelineEvents.since(PROJECT, 'plan:p1', 0)).toHaveLength(1)
  })
})

describe('undelivered', () => {
  const heard = (): { events: PipelineEvent[]; stop: () => void } => {
    const events: PipelineEvent[] = []
    return { events, stop: pipelineEvents.onUndelivered((_p, event) => { events.push(event) }) }
  }

  it('reports the event once nobody holds it', () => {
    const { events, stop } = heard()
    const { event } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {})
    pipelineEvents.handOut(PROJECT, event.id)

    pipelineEvents.undelivered(PROJECT, event)

    expect(events).toEqual([event])
    expect(pipelineEvents.wasHandedOut(PROJECT, event.id)).toBe(false)
    stop()
  })

  it('does not report an event another asker still holds', () => {
    const { events, stop } = heard()
    pipelineEvents.subscribe(PROJECT, waiter(() => true))
    pipelineEvents.subscribe(PROJECT, waiter(() => true))
    const { event } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {})

    pipelineEvents.undelivered(PROJECT, event)

    expect(events).toEqual([])
    expect(pipelineEvents.wasHandedOut(PROJECT, event.id)).toBe(true)
    stop()
  })

  it('stops notifying a listener that unsubscribed', () => {
    const listener = vi.fn()
    pipelineEvents.onUndelivered(listener)()
    pipelineEvents.undelivered(PROJECT, pipelineEvents.emit(PROJECT, 'run-1', 'escalation', {}))
    expect(listener).not.toHaveBeenCalled()
  })
})
