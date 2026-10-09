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
  | 'escalation'
  | 'commit_done'
  | 'run_paused'
  | 'run_stopped'
  | 'run_finished'
  | 'run_failed'

export interface PipelineEvent {
  id: number
  runId: string
  type: PipelineEventType
  at: string
  data: Record<string, unknown>
}

/** Events after which an orchestrator usually has to act. `wait` returns on these. */
export const SIGNIFICANT_EVENTS: ReadonlySet<PipelineEventType> = new Set([
  'check_failed', 'escalation', 'commit_done', 'run_paused', 'run_stopped', 'run_finished', 'run_failed'
])

const MAX_EVENTS_PER_PROJECT = 5000

type Listener = (event: PipelineEvent) => void

class ProjectEvents {
  private readonly events: PipelineEvent[] = []
  private readonly listeners = new Set<Listener>()
  private nextId = 1

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
  /** Test helper: forget all events of a project. */
  reset: (projectPath: string): void => { projects.delete(projectPath) }
}
