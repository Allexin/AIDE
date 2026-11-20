/**
 * Task tracker files (`aide/tasks/<id>.md`), shared with the renderer.
 * See docs/task-tracker-spec.md and docs/task-tracker-implementation.md.
 */

export type TaskStatus = 'backlog' | 'planned' | 'active' | 'blocked' | 'done' | 'cancelled'

export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'planned', 'active', 'blocked', 'done', 'cancelled']

/** Statuses of a closed task: only these may carry `history`. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'cancelled']

export interface TaskHistory {
  at: string
  /** The task that superseded this one, or null when it went to history on its own. */
  by: string | null
  reason: string
}

export interface TaskConfirmed {
  at: string
  by: 'close' | 'documenter' | 'user' | 'migration'
  /** Project-relative path → content hash at confirmation. */
  files: Record<string, string>
}

export interface TaskAcknowledged {
  at: string
  by: string
  kind: 'keep' | 'restore'
  note: string
}

export interface TaskCheck {
  at: string
  result: 'ok' | 'suspect'
  note: string
}

export interface TaskFile {
  /** Slug: [a-z0-9][a-z0-9-]{0,63}, equal to the file name. */
  id: string
  title: string
  status: TaskStatus
  /** Order among planned/backlog; fractional, smaller first. */
  rank: number | null
  tags: string[]
  /** Project-relative paths, optional #anchor. */
  docs: string[]
  /** Globs relative to the project root. */
  code: string[]
  /** Why it is blocked / cancelled. */
  reason: string | null
  /** Status to return to on unblock. */
  blockedFrom: TaskStatus | null
  label: string | null
  claim: string | null
  decidedAgainst: string | null
  reopened: boolean
  history: TaskHistory | null
  /** Stored and preserved; nothing computes it yet (drift is build step 5). */
  confirmed: TaskConfirmed | null
  acknowledged: TaskAcknowledged | null
  check: TaskCheck | null
  source: string | null
  activeBy: string[]
  /** ISO time. */
  created: string
  closed: string | null
  /** Markdown body section "## Description", without surrounding blank lines. */
  description: string
  /** Lines of section "## Journal", without the leading "- ". */
  journal: string[]
}

/** One file of `aide/tasks/`, as the store reads it. */
export interface TaskListEntry {
  id: string
  /** Project-relative path with forward slashes. */
  file: string
  task: TaskFile | null
  /** Content hash of the file; null only when it could not be read. */
  revision: string | null
  error: string | null
}

export interface TaskProblem {
  kind: 'duplicate-id' | 'invalid' | 'dangling-history'
  ids: string[]
  message: string
}

/** `aide/tasks/config.json`; a missing file or key means the default. */
export interface TaskConfig {
  /** Characters of section 0 of `task_snapshot`. */
  snapshotLabelBudget: number
}

export const DEFAULT_TASK_CONFIG: TaskConfig = { snapshotLabelBudget: 12000 }
