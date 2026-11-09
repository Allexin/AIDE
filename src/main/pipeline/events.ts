/**
 * In-memory pipeline event log per project, the source of the orchestrator
 * event feed (`/events`, `/wait`). Event ids increase monotonically per
 * project so a subscriber can resume losslessly with `since`.
 *
 * The run store (Phase 1) persists events to disk; this bus is the live view.
 */

export type PipelineEventType =
  | 'node_started'
  | 'node_finished'
  | 'check_failed'
  | 'loop_repeated'
  | 'escalation'
  | 'commit_done'
  | 'pipeline_issue'
  | 'amended'
  | 'run_paused'
  | 'run_stopped'
  | 'run_finished'
  | 'run_failed'
  | 'account_switched'
  | 'step_retrying'
  /** A plan holds and needs the Strategist. Its `runId` is `plan:<planId>`. */
  | 'plan_attention'

export interface PipelineEvent {
  id: number
  runId: string
  type: PipelineEventType
  at: string
  data: Record<string, unknown>
}

/**
 * Events after which the orchestrator has to act: a decision is needed, the run
 * changed hands (paused/stopped, possibly by the user), or it ended. `wait` and
 * the default event stream deliver only these; progress (steps, loop repeats,
 * failed checks inside loops, commits) is in the report.
 */
export const SIGNIFICANT_EVENTS: ReadonlySet<PipelineEventType> = new Set([
  'escalation', 'run_paused', 'run_stopped', 'run_finished', 'run_failed', 'plan_attention'
])

/**
 * Whether the Strategist gets the event. `quiet: true` in the data marks a
 * significant type that AIDE handles by itself (a usage limit the account pool
 * switches away from, an escalation the plan's Orchestrator answers): it stays in
 * the run's event log, but nobody is woken. `resolved: true` marks one that has
 * been dealt with since (the escalation answered, the plan continued, the run
 * resumed), so a wait from an older `since` does not hand it out again.
 */
export function isSignificant(event: { type: string; data: Record<string, unknown> }): boolean {
  return SIGNIFICANT_EVENTS.has(event.type as PipelineEventType) && event.data.quiet !== true && event.data.resolved !== true
}

/**
 * Whether a wait or event stream scoped to `runId` (null: the whole project)
 * covers the event. A plan_attention belongs to the project, not to a run: the
 * Strategist blocked on any run must still learn that the plan needs it.
 */
export function inWaitScope(runId: string | null, event: Pick<PipelineEvent, 'runId' | 'type'>): boolean {
  return runId === null || event.runId === runId || event.type === 'plan_attention'
}

/** Shorten text for the orchestrator's context; the full text stays available through pipeline_output. */
export function clip(text: string, max: number, keep: 'head' | 'tail' = 'head'): string {
  if (text.length <= max) return text
  return keep === 'head' ? `${text.slice(0, max)}… [truncated]` : `[truncated] …${text.slice(-max)}`
}

const MAX_EVENTS_PER_PROJECT = 5000

/** A live wait or event stream. */
export interface EventWaiter {
  /** Whether this waiter takes the event: its run scope and which kinds of events it wants. */
  covers(event: PipelineEvent): boolean
  /** Hand the event over; false when it can no longer reach the asker (the connection is gone). */
  deliver(event: PipelineEvent): boolean
}

/** Who was there when an event was emitted, decided per event. */
export interface EventDelivery {
  /** Live waiters whose filter covers the event. */
  covering: number
  /** Live waiters whose filter does not. */
  other: number
  /** How many of the covering ones took it. Zero means nobody got it, and the terminal is the way left. */
  handedTo: number
}

/** A delivery that was counted and then could not be written to the asker. */
type UndeliveredListener = (projectPath: string, event: PipelineEvent) => void

const undeliveredListeners = new Set<UndeliveredListener>()

class ProjectEvents {
  private readonly events: PipelineEvent[] = []
  private readonly waiters = new Set<EventWaiter>()
  /** Askers that hold each event (live or from the backlog), by event id; only events still in the log. */
  private readonly handedOut = new Map<number, number>()
  private nextId = 1

  publish(runId: string, type: PipelineEventType, data: Record<string, unknown> = {}): { event: PipelineEvent; delivery: EventDelivery } {
    const event: PipelineEvent = { id: this.nextId++, runId, type, at: new Date().toISOString(), data }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS_PER_PROJECT) {
      for (const dropped of this.events.splice(0, this.events.length - MAX_EVENTS_PER_PROJECT)) this.handedOut.delete(dropped.id)
    }
    const waiters = [...this.waiters]
    let covering = 0
    let handedTo = 0
    for (const waiter of waiters) {
      if (!waiter.covers(event)) continue
      covering++
      if (waiter.deliver(event)) handedTo++
    }
    if (handedTo > 0) this.handedOut.set(event.id, handedTo)
    return { event, delivery: { covering, other: waiters.length - covering, handedTo } }
  }

  since(runId: string | null, since: number): PipelineEvent[] {
    return this.events.filter((event) => event.id > since && (runId === null || event.runId === runId))
  }

  /** Mark the events that match as dealt with. */
  resolve(match: (event: PipelineEvent) => boolean): void {
    for (const event of this.events) if (event.data.resolved !== true && match(event)) event.data = { ...event.data, resolved: true }
  }

  /** Continue numbering after ids already handed out (by an AIDE instance that has since restarted). */
  seed(nextId: number): void {
    if (nextId > this.nextId) this.nextId = nextId
  }

  /** An event from the log went to an asker (a wait or stream reading its backlog). */
  handOut(eventId: number): void {
    this.handedOut.set(eventId, (this.handedOut.get(eventId) ?? 0) + 1)
  }

  wasHandedOut(eventId: number): boolean {
    return this.handedOut.has(eventId)
  }

  /** An asker's copy never arrived. True when no other asker holds the event. */
  undelivered(eventId: number): boolean {
    const left = (this.handedOut.get(eventId) ?? 1) - 1
    if (left > 0) { this.handedOut.set(eventId, left); return false }
    this.handedOut.delete(eventId)
    return true
  }

  subscribe(waiter: EventWaiter): () => void {
    this.waiters.add(waiter)
    return () => { this.waiters.delete(waiter) }
  }
}

const projects = new Map<string, ProjectEvents>()

function forProject(projectPath: string): ProjectEvents {
  let events = projects.get(projectPath)
  if (!events) {
    events = new ProjectEvents()
    projects.set(projectPath, events)
  }
  return events
}

export const pipelineEvents = {
  /** Emit an event and hand it to the live waiters that cover it. */
  publish: (projectPath: string, runId: string, type: PipelineEventType, data?: Record<string, unknown>): { event: PipelineEvent; delivery: EventDelivery } =>
    forProject(projectPath).publish(runId, type, data),
  emit: (projectPath: string, runId: string, type: PipelineEventType, data?: Record<string, unknown>): PipelineEvent =>
    forProject(projectPath).publish(runId, type, data).event,
  since: (projectPath: string, runId: string | null, since: number): PipelineEvent[] =>
    forProject(projectPath).since(runId, since),
  subscribe: (projectPath: string, waiter: EventWaiter): (() => void) =>
    forProject(projectPath).subscribe(waiter),
  seed: (projectPath: string, nextId: number): void => forProject(projectPath).seed(nextId),
  resolve: (projectPath: string, match: (event: PipelineEvent) => boolean): void => forProject(projectPath).resolve(match),
  /** Record that an event from the log went to an asker, so the terminal relay does not send it too. */
  handOut: (projectPath: string, eventId: number): void => forProject(projectPath).handOut(eventId),
  wasHandedOut: (projectPath: string, eventId: number): boolean => forProject(projectPath).wasHandedOut(eventId),
  /** The response carrying this event could not be written: it counts as not delivered. */
  undelivered: (projectPath: string, event: PipelineEvent): void => {
    if (!forProject(projectPath).undelivered(event.id)) return
    for (const listener of [...undeliveredListeners]) listener(projectPath, event)
  },
  onUndelivered: (listener: UndeliveredListener): (() => void) => {
    undeliveredListeners.add(listener)
    return () => { undeliveredListeners.delete(listener) }
  },
  /** Test helper: forget all events of a project. */
  reset: (projectPath: string): void => { projects.delete(projectPath) }
}
