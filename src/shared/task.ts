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

/** A hit of `TaskService.search`. */
export interface TaskSearchHit {
  id: string
  title: string
  status: TaskStatus
  label: string | null
  claimFirstLine: string | null
  tags: string[]
  /** In history: no longer true or no longer relevant. Only found when the search includes history. */
  history: boolean
}

export interface TaskChainEntry {
  id: string
  title: string
  status: TaskStatus
  label: string | null
  claim: string | null
  closed: string | null
  /** The task that superseded this one. */
  supersededBy: string | null
  journal: string[]
}

/** A task as `TaskService.get` returns it. */
export interface TaskDetail {
  task: TaskFile
  revision: string
  /** The claim chain: the tasks this one superseded (oldest first), and the ones that superseded it, in order. */
  chain: { earlier: TaskChainEntry[]; later: TaskChainEntry[] }
  /** Tabs of this user bound to the task. */
  tabs: string[]
  /** Plans that list the task in `solves` (empty until plans have `solves`). */
  plans: string[]
}

/** One task in a section of the Tasks tab (docs/task-tracker-implementation.md §8). */
export interface TaskBoardItem {
  id: string
  title: string
  status: TaskStatus
  rank: number | null
  tags: string[]
  label: string | null
  claimFirstLine: string | null
  /** Why it is blocked or cancelled. */
  reason: string | null
  decidedAgainst: string | null
  reopened: boolean
  /** A claim nobody has confirmed (`confirmed: null`). */
  unverified: boolean
  /** Who works on an active task: tabs of this AIDE, other users and hosts, users without a tab. */
  workers: string[]
  /** For writes based on this reading. */
  revision: string
}

/** The sections of the Tasks tab, read from `aide/tasks/`; tasks in history are left out. */
export interface TaskBoard {
  /** The project has `aide/tasks/`: the Tasks tab is shown. */
  exists: boolean
  /** Load-check problems and stale active tasks, one message each. */
  problems: string[]
  active: TaskBoardItem[]
  blocked: TaskBoardItem[]
  /** By rank, smaller first; unranked last, oldest first. */
  planned: TaskBoardItem[]
  backlog: TaskBoardItem[]
  /** Claims by label, grouped by each task's first tag. */
  project: { tag: string; items: TaskBoardItem[] }[]
  decidedAgainst: TaskBoardItem[]
}

/** The result of a write from the Tasks tab: the error text, or null when it was written. */
export interface TaskWriteResult {
  error: string | null
  id?: string
}
