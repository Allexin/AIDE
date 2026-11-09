import { getToolConfig } from '../config/appConfig'
import { logEvent } from '../diagnostics'
import { cliLog } from '../pty/cliTools/cliLogger'
import { ptyRegistry } from '../pty/registry'
import { tabActivity } from '../pty/tabActivity'
import type { SettingsField } from '../pty/cliTools/types'
import type { PtyManager } from '../pty/ptyManager'
import { clip, isSignificant, pipelineEvents, type EventDelivery } from './events'
import { orchestrators } from './orchestrators'
import type { PipelineManager } from './manager'

/**
 * Pipeline events as messages for an orchestrator that is not waiting for them.
 * Some models forget `pipeline_wait` and then never learn that the run needs
 * them. When an event that needs the orchestrator is emitted and no live wait or
 * event stream took it (none is open, or those open cover other runs), AIDE types
 * it into the tab that last called the pipeline server — once that tab's CLI is
 * idle. If an asker receives such an event from the backlog before then, it is
 * not typed. A per-CLI setting, on by default: an orchestrator that waits never
 * reaches the idle-and-not-waiting state.
 *
 * Every significant event leaves a trail in the diagnostics (`pipeline-event-delivery`,
 * see docs/crash-diagnostics.md): how it was delivered, or why it was not.
 */

export const EVENT_MESSAGES_KEY = 'pipelineEventMessages'

export const EVENT_MESSAGES_FIELD: SettingsField = {
  key: EVENT_MESSAGES_KEY,
  label: 'Send pipeline events to the orchestrator as messages',
  description: 'When the orchestrator in this CLI is not waiting for pipeline events, type each event into its tab once the tab is idle',
  type: 'boolean',
  default: true
}

export function eventMessagesEnabled(toolId: string): boolean {
  return getToolConfig(toolId)[EVENT_MESSAGES_KEY] !== false
}

export interface RelayedEvent {
  id: number
  runId: string
  type: string
  data: Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The message for events the orchestrator missed: what happened, what to do, how to wait again. */
export function eventMessage(events: RelayedEvent[]): string {
  const last = events[events.length - 1]
  const lines = events.map((event) => {
    const summary = text(event.data.summary) || event.type
    if (event.type === 'escalation') {
      const actions = Array.isArray(event.data.actions) ? event.data.actions.join(', ') : ''
      return `Run ${event.runId}: escalation ${text(event.data.escalationId)} — ${summary}. ${clip(text(event.data.message), 600)} ` +
        `Decide with pipeline_answer (escalationId ${text(event.data.escalationId)}${actions ? `, action: ${actions}` : ''}).`
    }
    if (event.type === 'run_finished' || event.type === 'run_failed') {
      return `Run ${event.runId}: ${event.type === 'run_finished' ? 'finished' : 'failed'} — ${summary}. Read the result with pipeline_report and tell the user.`
    }
    if (event.type === 'plan_attention') {
      const proposal = text(event.data.proposal)
      return `Plan ${text(event.data.plan)} needs you (${text(event.data.kind)}): ${text(event.data.reason)}${proposal ? ` Proposal: ${proposal}` : ''} Read it with plan_status; change it with plan_edit if needed, then plan_run with a note.`
    }
    return `Run ${event.runId}: ${event.type} — ${summary}.`
  })
  const runEnded = last.type === 'run_finished' || last.type === 'run_failed'
  const planEvent = last.type === 'plan_attention'
  return `AIDE pipeline: you were not waiting for pipeline events, so they are sent as a message. ${lines.join(' ')}` +
    (runEnded || planEvent ? '' : ` Then keep waiting: call pipeline_wait for run ${last.runId} with since=${last.id}.`)
}

/** How a significant event ended up, recorded in the `pipeline-event-delivery` trail. */
export type DeliveryOutcome = 'handed-to-waiter' | 'queued' | 'typed' | 'no-tab' | 'setting-off' | 'submit-failed'

/** An event waiting for its tab to become idle, with who was there when it was emitted. */
type QueuedEvent = RelayedEvent & { delivery: EventDelivery }

interface Pending {
  projectPath: string
  events: QueuedEvent[]
}

const NOBODY: EventDelivery = { covering: 0, other: 0, handedTo: 0 }

function recordDelivery(projectPath: string, event: RelayedEvent, delivery: EventDelivery, outcome: DeliveryOutcome, extra: Record<string, unknown> = {}): void {
  const failed = outcome === 'no-tab' || outcome === 'submit-failed'
  logEvent('pipeline-event-delivery', {
    id: event.id, type: event.type, runId: event.runId, projectPath,
    covering: delivery.covering, other: delivery.other, outcome, ...extra
  }, failed ? 'warn' : 'info')
}

export class EventRelay {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly manager: Pick<PipelineManager, 'on' | 'off'>,
    private readonly enabled: (toolId: string) => boolean = eventMessagesEnabled
  ) {}

  attach(): () => void {
    const onEvent = (projectPath: string, runId: string, type: string, data: Record<string, unknown>, id: number, delivery: EventDelivery): void => {
      if (!isSignificant({ type, data })) return
      const event: RelayedEvent = { id, runId, type, data }
      if (delivery.handedTo > 0) recordDelivery(projectPath, event, delivery, 'handed-to-waiter')
      else this.queue(projectPath, event, delivery)
    }
    const onUndelivered = (projectPath: string, event: RelayedEvent): void => {
      // Still needs the Strategist: the waiter that took it is gone before reading it.
      if (isSignificant(event)) this.queue(projectPath, event, NOBODY, { reason: 'response-not-written' })
    }
    const onIdle = (tabId: string): void => { void this.flush(tabId) }
    this.manager.on('event', onEvent)
    const stopUndelivered = pipelineEvents.onUndelivered(onUndelivered)
    tabActivity.on('idle', onIdle)
    return () => {
      this.manager.off('event', onEvent)
      stopUndelivered()
      tabActivity.off('idle', onIdle)
    }
  }

  private managerOf(tabId: string): PtyManager | null {
    for (const mgr of ptyRegistry.values()) if (mgr.getTabs().some((tab) => tab.tabId === tabId)) return mgr
    return null
  }

  private queue(projectPath: string, event: RelayedEvent, delivery: EventDelivery, extra: Record<string, unknown> = {}): void {
    const tabId = orchestrators.lastTab(projectPath)
    const mgr = tabId ? this.managerOf(tabId) : null
    const tool = mgr?.getTabs().find((tab) => tab.tabId === tabId)?.toolId
    if (!tabId || !tool) { recordDelivery(projectPath, event, delivery, 'no-tab', { tabId, ...extra }); return }
    if (!this.enabled(tool)) { recordDelivery(projectPath, event, delivery, 'setting-off', { tabId, tool, ...extra }); return }
    const entry = this.pending.get(tabId) ?? { projectPath, events: [] }
    if (!entry.events.some((queued) => queued.id === event.id)) {
      entry.events.push({ ...event, delivery })
      recordDelivery(projectPath, event, delivery, 'queued', { tabId, ...extra })
    }
    this.pending.set(tabId, entry)
    void this.flush(tabId)
  }

  private async flush(tabId: string): Promise<void> {
    const entry = this.pending.get(tabId)
    if (!entry) return
    entry.events = entry.events.filter((event) => {
      if (!pipelineEvents.wasHandedOut(entry.projectPath, event.id)) return true
      recordDelivery(entry.projectPath, event, event.delivery, 'handed-to-waiter', { via: 'backlog' })
      return false
    })
    if (entry.events.length === 0) {
      this.pending.delete(tabId)
      return
    }
    if (!tabActivity.isIdle(tabId)) return
    this.pending.delete(tabId)
    const record = (outcome: DeliveryOutcome): void => {
      for (const event of entry.events) recordDelivery(entry.projectPath, event, event.delivery, outcome, { tabId })
    }
    const mgr = this.managerOf(tabId)
    if (!mgr) { record('no-tab'); return }
    let sent = false
    try {
      sent = await mgr.submitWhenReady(tabId, eventMessage(entry.events))
    } catch (err) {
      logEvent('pipeline-event-submit-failed', { tabId, message: err instanceof Error ? err.message : String(err) }, 'warn')
    }
    record(sent ? 'typed' : 'submit-failed')
    if (sent) cliLog('Pipeline', `Sent ${entry.events.length} pipeline event(s) as a message to tab ${tabId}: no wait received them.`)
  }
}
