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
  'escalation', 'run_paused', 'run_stopped', 'run_finished', 'run_failed'
])

/**
 * Whether the orchestrator gets the event. `quiet: true` in the data marks a
 * significant type that AIDE handles by itself (a usage limit the account pool
 * switches away from): it stays in the run's event log, but nobody is woken.
 */
export function isSignificant(event: { type: string; data: Record<string, unknown> }): boolean {
  return SIGNIFICANT_EVENTS.has(event.type as PipelineEventType) && event.data.quiet !== true
}

/** Shorten text for the orchestrator's context; the full text stays available through pipeline_output. */
export function clip(text: string, max: number, keep: 'head' | 'tail' = 'head'): string {
  if (text.length <= max) return text
  return keep === 'head' ? `${text.slice(0, max)}… [truncated]` : `[truncated] …${text.slice(-max)}`
}

const MAX_EVENTS_PER_PROJECT = 5000

type Listener = (event: PipelineEvent) => void

class ProjectEvents {
  private readonly events: PipelineEvent[] = []
  private readonly listeners = new Set<Listener>()
  private nextId = 1
  private observed = 0

  emit(runId: string, type: PipelineEventType, data: Record<string, unknown> = {}): PipelineEvent {
    const event: PipelineEvent = { id: this.nextId++, runId, type, at: new Date().toISOString(), data }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS_PER_PROJECT) this.events.splice(0, this.events.length - MAX_EVENTS_PER_PROJECT)
    for (const listener of [...this.listeners]) listener(event)
    return event
  }

  since(runId: string | null, since: number): PipelineEvent[] {
    return this.events.filter((event) => event.id > since && (runId === null || event.runId === runId))
  }

  /** Continue numbering after ids already handed out (by an AIDE instance that has since restarted). */
  seed(nextId: number): void {
    if (nextId > this.nextId) this.nextId = nextId
  }

  /** An orchestrator asked for events (a wait, an event stream); counts observer activity. */
  noteObserver(): void {
    this.observed++
  }

  observerActivity(): number {
    return this.observed
  }

  /** Whether an orchestrator is subscribed right now — the only subscribers are waits and event streams. */
  hasObserver(): boolean {
    return this.listeners.size > 0
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
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
  emit: (projectPath: string, runId: string, type: PipelineEventType, data?: Record<string, unknown>): PipelineEvent =>
    forProject(projectPath).emit(runId, type, data),
  since: (projectPath: string, runId: string | null, since: number): PipelineEvent[] =>
    forProject(projectPath).since(runId, since),
  subscribe: (projectPath: string, listener: Listener): (() => void) =>
    forProject(projectPath).subscribe(listener),
  seed: (projectPath: string, nextId: number): void => forProject(projectPath).seed(nextId),
  noteObserver: (projectPath: string): void => forProject(projectPath).noteObserver(),
  observerActivity: (projectPath: string): number => forProject(projectPath).observerActivity(),
  hasObserver: (projectPath: string): boolean => forProject(projectPath).hasObserver(),
  /** Test helper: forget all events of a project. */
  reset: (projectPath: string): void => { projects.delete(projectPath) }
}
