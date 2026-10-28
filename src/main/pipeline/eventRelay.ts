import { getToolConfig } from '../config/appConfig'
import { cliLog } from '../pty/cliTools/cliLogger'
import { ptyRegistry } from '../pty/registry'
import { tabActivity } from '../pty/tabActivity'
import type { SettingsField } from '../pty/cliTools/types'
import type { PtyManager } from '../pty/ptyManager'
import { clip, isSignificant, pipelineEvents } from './events'
import { orchestrators } from './orchestrators'
import type { PipelineManager } from './manager'

/**
 * Pipeline events as messages for an orchestrator that is not waiting for them.
 * Some models forget `pipeline_wait` and then never learn that the run needs
 * them. When an event that needs the orchestrator is emitted and no orchestrator
 * is waiting (no wait call or event stream is open), AIDE types it into the tab
 * that last called the pipeline server — once that tab's CLI is idle. If an
 * orchestrator asks for events before then, it gets them itself and nothing is
 * typed. A per-CLI setting, on by default: an orchestrator that waits never
 * reaches the idle-and-not-waiting state.
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
    return `Run ${event.runId}: ${event.type} — ${summary}.`
  })
  const runEnded = last.type === 'run_finished' || last.type === 'run_failed'
  return `AIDE pipeline: you were not waiting for pipeline events, so they are sent as a message. ${lines.join(' ')}` +
    (runEnded ? '' : ` Then keep waiting: call pipeline_wait for run ${last.runId} with since=${last.id}.`)
}

interface Pending {
  projectPath: string
  events: RelayedEvent[]
  /** Observer activity of the project when the first event was queued; a change means an orchestrator asked for events. */
  observerMark: number
}

export class EventRelay {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly manager: Pick<PipelineManager, 'on' | 'off'>,
    private readonly enabled: (toolId: string) => boolean = eventMessagesEnabled
  ) {}

  attach(): () => void {
    const onEvent = (projectPath: string, runId: string, type: string, data: Record<string, unknown>, id: number, observed: boolean): void => {
      if (!isSignificant({ type, data }) || observed) return
      this.queue(projectPath, { id, runId, type, data })
    }
    const onIdle = (tabId: string): void => { void this.flush(tabId) }
    this.manager.on('event', onEvent)
    tabActivity.on('idle', onIdle)
    return () => {
      this.manager.off('event', onEvent)
      tabActivity.off('idle', onIdle)
    }
  }

  private managerOf(tabId: string): PtyManager | null {
    for (const mgr of ptyRegistry.values()) if (mgr.getTabs().some((tab) => tab.tabId === tabId)) return mgr
    return null
  }

  private queue(projectPath: string, event: RelayedEvent): void {
    const tabId = orchestrators.lastTab(projectPath)
    const mgr = tabId ? this.managerOf(tabId) : null
    const tool = mgr?.getTabs().find((tab) => tab.tabId === tabId)?.toolId
    if (!tabId || !tool || !this.enabled(tool)) return
    const entry = this.pending.get(tabId) ?? { projectPath, events: [], observerMark: pipelineEvents.observerActivity(projectPath) }
    entry.events.push(event)
    this.pending.set(tabId, entry)
    void this.flush(tabId)
  }

  private async flush(tabId: string): Promise<void> {
    const entry = this.pending.get(tabId)
    if (!entry) return
    if (pipelineEvents.observerActivity(entry.projectPath) !== entry.observerMark) {
      this.pending.delete(tabId) // an orchestrator asked for events since: it gets these itself
      return
    }
    if (!tabActivity.isIdle(tabId)) return
    this.pending.delete(tabId)
    const mgr = this.managerOf(tabId)
    if (!mgr) return
    if (await mgr.submitWhenReady(tabId, eventMessage(entry.events))) {
      cliLog('Pipeline', `Sent ${entry.events.length} pipeline event(s) as a message to tab ${tabId}: the orchestrator was not waiting.`)
    }
  }
}
