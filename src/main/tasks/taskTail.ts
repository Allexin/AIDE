import type { TaskFile, TaskListEntry, TaskStatus } from '../../shared/task'

/**
 * The tracker tail of tool results (docs/task-tracker-implementation.md §7): per MCP
 * connection, what changed in the tracker since the connection last got a tail.
 *
 * Changes are found by comparing task revisions and problem keys between two readings
 * of the tracker, never by counting change events: one write reaches the service both
 * from the writer and from the FS watcher, and a change made by another AIDE reaches it
 * only through the watcher. An event only marks the project for a new reading.
 */

/** What the tail compares of one task. */
export interface TaskSummary {
  revision: string
  title: string
  status: TaskStatus
  inHistory: boolean
  /** The task that superseded this one. */
  historyBy: string | null
  activeBy: string[]
  journal: string[]
}

export interface TrackerState {
  tasks: Map<string, TaskSummary>
  /** One key per problem, so a problem seen before is not new. */
  problems: Set<string>
}

export interface TailItem {
  text: string
  /** Who made the change, when the task's journal says so ("alice/tab 2", "bob"). */
  by: string | null
}

export const TAIL_ITEMS = 5
const LOG_LIMIT = 500
const CONNECTION_LIMIT = 1000

export function summarize(entries: TaskListEntry[], problemKeys: Iterable<string>): TrackerState {
  const tasks = new Map<string, TaskSummary>()
  for (const entry of entries) {
    const task: TaskFile | null = entry.task
    if (!task || !entry.revision) continue
    tasks.set(task.id, { revision: entry.revision, title: task.title, status: task.status, inHistory: task.history !== null, historyBy: task.history?.by ?? null, activeBy: task.activeBy, journal: task.journal })
  }
  return { tasks, problems: new Set(problemKeys) }
}

/** `by` of a journal line: "YYYY-MM-DD <by>: <text>" or "YYYY-MM-DD created by <by>". */
export function journalBy(line: string): string | null {
  const created = /^\d{4}-\d{2}-\d{2} created by (.+)$/.exec(line)
  if (created) return created[1]
  return /^\d{4}-\d{2}-\d{2} (.+?): /.exec(line)?.[1] ?? null
}

function changeText(id: string, before: TaskSummary, after: TaskSummary): string {
  if (!before.inHistory && after.inHistory) return `task ${id} moved to history${after.historyBy ? ` (superseded by ${after.historyBy})` : ''}`
  if (before.inHistory && !after.inHistory) return `task ${id} restored`
  if (before.status !== after.status) {
    if (after.status === 'done' || after.status === 'cancelled') return `task ${id} closed ${after.status}`
    if (after.status === 'active') return before.status === 'done' ? `task ${id} reopened` : `task ${id} started`
    if (before.status === 'active' && after.status === 'planned') return `task ${id} paused`
    return `task ${id} ${before.status} → ${after.status}`
  }
  if (after.activeBy.some((user) => !before.activeBy.includes(user))) return `task ${id} started`
  return `task ${id} changed`
}

/** The changes from `before` to `after`, one item per changed task, and one for new problems. */
export function diffState(before: TrackerState, after: TrackerState): TailItem[] {
  const items: TailItem[] = []
  for (const [id, task] of after.tasks) {
    const old = before.tasks.get(id)
    if (old && old.revision === task.revision) continue
    // Only a journal that grew says who acted; an edit by hand names no one.
    const grew = !old || task.journal.length > old.journal.length
    let by = grew && task.journal.length ? journalBy(task.journal[task.journal.length - 1]) : null
    if (!old) {
      items.push({ text: `task ${id} created`, by })
      continue
    }
    const text = changeText(id, old, task)
    if (!by && text.endsWith('started')) by = task.activeBy.find((user) => !old.activeBy.includes(user)) ?? null
    items.push({ text, by })
  }
  for (const id of before.tasks.keys()) if (!after.tasks.has(id)) items.push({ text: `task ${id} removed`, by: null })
  const fresh = [...after.problems].filter((key) => !before.problems.has(key)).length
  if (fresh) items.push({ text: `${fresh} new problem${fresh === 1 ? '' : 's'} (task_snapshot)`, by: null })
  return items
}

/** The tail block, or null when there is nothing to tell. */
export function tailText(items: string[], more: number = 0): string | null {
  if (!items.length) return null
  const shown = items.slice(0, TAIL_ITEMS)
  const left = items.length - shown.length + more
  return `— tracker since your last call: ${shown.join('; ')}${left > 0 ? `; and ${left} more` : ''}.`
}

interface ProjectLog {
  state: TrackerState | null
  /** A change event came since the last reading. */
  dirty: boolean
  /** Sequence number of the last item. */
  seq: number
  items: { seq: number; item: TailItem }[]
}

/**
 * The tails of the connections to one AIDE. `read` reads the tracker of a project;
 * `markDirty` is called on every change event, so a quiet tracker is not read again.
 */
export class TrackerTail {
  private readonly projects = new Map<string, ProjectLog>()
  /** Per connection: its project and the sequence number of the last item it was told. */
  private readonly connections = new Map<string, { projectPath: string; seen: number }>()

  constructor(private readonly read: (projectPath: string) => TrackerState) {}

  markDirty(projectPath: string): void {
    const log = this.projects.get(projectPath)
    if (log) log.dirty = true
  }

  private refresh(projectPath: string): ProjectLog {
    let log = this.projects.get(projectPath)
    if (!log) {
      log = { state: this.read(projectPath), dirty: false, seq: 0, items: [] }
      this.projects.set(projectPath, log)
      return log
    }
    if (!log.dirty) return log
    log.dirty = false
    const next = this.read(projectPath)
    for (const item of diffState(log.state!, next)) log.items.push({ seq: ++log.seq, item })
    if (log.items.length > LOG_LIMIT) log.items.splice(0, log.items.length - LOG_LIMIT)
    log.state = next
    return log
  }

  /** The connection has seen the tracker as it is now (a session start, a snapshot). */
  seen(projectPath: string, connectionId: string): void {
    const log = this.refresh(projectPath)
    this.remember(connectionId, projectPath, log.seq)
  }

  /**
   * The tail for one tool result of a connection: the changes since its last tail,
   * leaving out its own (made by `self`), or null when there are none. A connection
   * seen for the first time starts from now.
   */
  take(projectPath: string, connectionId: string, self: string | null): string | null {
    const log = this.refresh(projectPath)
    const connection = this.connections.get(connectionId)
    this.remember(connectionId, projectPath, log.seq)
    if (!connection || connection.projectPath !== projectPath || connection.seen >= log.seq) return null
    const first = log.items[0]?.seq ?? log.seq + 1
    const lost = Math.max(0, first - connection.seen - 1)
    const items = log.items
      .filter((entry) => entry.seq > connection.seen && (self === null || entry.item.by !== self))
      .map(({ item }) => item.by ? `${item.text} by ${item.by}` : item.text)
    return tailText(items, lost)
  }

  private remember(connectionId: string, projectPath: string, seen: number): void {
    this.connections.delete(connectionId)
    this.connections.set(connectionId, { projectPath, seen })
    if (this.connections.size > CONNECTION_LIMIT) this.connections.delete(this.connections.keys().next().value!)
  }

  /** The project closed. */
  forget(projectPath: string): void {
    this.projects.delete(projectPath)
    for (const [id, connection] of this.connections) if (connection.projectPath === projectPath) this.connections.delete(id)
  }
}
