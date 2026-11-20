import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { hostname, userInfo } from 'os'
import { join } from 'path'
import { CLOSED_TASK_STATUSES, DEFAULT_TASK_CONFIG, type TaskFile, type TaskListEntry, type TaskStatus } from '../../shared/task'
import { TASK_ID_PATTERN } from './taskFile'
import { TASKS_DIR, TaskStore, type LeaseOwner, type TaskChange } from './taskStore'
import { bindTab, isOwn, isThisUserHere, readAllBindings, unbindTabs, unbindTask, type BindingOwner } from './taskBindings'
import { renderSnapshot, staleActives, trackerOrientation, type Workers } from './taskSnapshot'
import { TrackerTail, summarize, type TrackerState } from './taskTail'

/**
 * The task tracker of the open projects (docs/task-tracker-implementation.md §4): every
 * operation validates, applies and writes through `TaskStore.write`, so a write based on
 * a task that changed since it was read is refused.
 *
 * Emits 'changed' (projectPath) after every write and when `aide/tasks/` changes on disk
 * (`notifyDiskChange`), so views read the tasks again.
 *
 * `by` names who acts: "<user>/tab <n>" for an agent in a tab, "<user>" for the UI.
 */

export interface TaskEnvironment {
  /** `.aide/users/<user>/tasks` of the project: bindings and other per-user state. */
  userDir(projectPath: string): string
  /** The user name recorded in `activeBy` and in journal lines; the OS user by default. */
  user?: () => string
  /** Owner of the write lease; this OS user and host by default. */
  owner?: LeaseOwner
  /** The clock, for tests. */
  now?: () => Date
  /** Whether `tabId` names a terminal tab open in this AIDE; a binding of a closed tab is not counted. All tabs count as open without it. */
  liveTab?: (tabId: string) => boolean
  /** Whether a pipeline run of the project is going: an active task bound to no tab is not stale then. */
  runActive?: (projectPath: string) => boolean
}

/** A tab binding as the tracker shows it (§6). */
export interface TaskBindingView {
  tabId: string
  task: string
  since: string
  user: string
  host: string
  /** A tab of this AIDE; otherwise the tab of another user or host. */
  here: boolean
  /** "alice/tab 3" for a tab of this AIDE, "bob" (or "alice on PC2") for another. */
  who: string
}

export interface TaskSearchQuery {
  query?: string
  status?: TaskStatus | TaskStatus[]
  /** A task matches when it has any of these tags. */
  tags?: string[]
  /** Include tasks in history; excluded by default. */
  history?: boolean
}

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

export interface TaskCloseArgs {
  outcome: 'done' | 'cancelled'
  label?: string
  claim?: string
  code?: string[]
  decidedAgainst?: string
  supersedes?: string[]
}

const CREATE_KEYS = ['id', 'title', 'description', 'tags', 'docs', 'code', 'status', 'rank', 'label', 'claim', 'source'] as const
const UPDATE_KEYS = ['title', 'description', 'tags', 'docs', 'code', 'rank', 'reason', 'status'] as const
const SEARCH_LIMIT = 50

/** The status changes `update` makes, as told to a caller whose change is refused. */
export const STATUS_RULE = 'task_update changes status only backlog ↔ planned; backlog, planned or active → blocked (with a reason); blocked → the status it was blocked from; active → planned (pause). A task becomes active by task_start, is closed by task_close and reopened by task_reopen.'

const ORDER: Record<TaskStatus, number> = { planned: 0, active: 1, blocked: 2, backlog: 3, done: 4, cancelled: 5 }

/** A slug from a task title: lowercase ASCII letters and digits joined by "-", "task" when nothing is left. */
export function slugFromTitle(title: string): string {
  const slug = title.replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 58).replace(/-+$/, '')
  return slug || 'task'
}

/** One journal line's text: no line breaks. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function firstLine(text: string | null): string | null {
  if (text === null) return null
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
}

function checkKeys(fields: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${what} cannot set ${unknown.map((key) => `"${key}"`).join(', ')}; it sets ${allowed.join(', ')}.`)
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`)
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, name)
}

function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`"${name}" must be a list of strings.`)
  return value as string[]
}

function rankValue(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('"rank" must be a number or null.')
  return value
}

/** `by` of a user's tab: "<user>/tab <n>" with the number of its tab id; the user alone without a tab. */
export function actorOf(user: string, tabId: string | null): string {
  if (!tabId) return user
  return `${user}/tab ${/^tab-(\d+)$/.exec(tabId)?.[1] ?? tabId}`
}

function isOrdered(status: TaskStatus): boolean {
  return status === 'backlog' || status === 'planned'
}

export class TaskService extends EventEmitter {
  private readonly pendingNotify = new Set<string>()
  /** The tracker tails of the MCP connections (§7); every 'changed' marks the project for a new reading. */
  private readonly tail = new TrackerTail((projectPath) => this.trackerState(projectPath))

  constructor(private readonly env: TaskEnvironment) {
    super()
    this.on('changed', (projectPath: string) => this.tail.markDirty(projectPath))
  }

  store(projectPath: string): TaskStore {
    return new TaskStore(projectPath, this.env.userDir(projectPath), this.env.owner)
  }

  /** The user name recorded in `activeBy` and journal lines. */
  user(): string {
    return this.env.user?.() ?? userInfo().username
  }

  /** `by` for an agent in a tab ("<user>/tab <n>", the number of its tab id) or for the UI ("<user>"). */
  actor(tabId: string | null): string {
    return actorOf(this.user(), tabId)
  }

  /** Who writes bindings: this user, on this host, in this AIDE process. */
  private bindingOwner(): BindingOwner {
    return { user: this.user(), host: this.env.owner?.host ?? hostname(), pid: process.pid }
  }

  private now(): Date {
    return this.env.now?.() ?? new Date()
  }

  private day(): string {
    return this.now().toISOString().slice(0, 10)
  }

  private async write(projectPath: string, changes: TaskChange[]): Promise<Record<string, string>> {
    const revisions = await this.store(projectPath).write(changes)
    this.emit('changed', projectPath)
    return revisions
  }

  /**
   * `aide/tasks/` changed on disk: a hand edit, a pull, another AIDE, or one of this
   * service's own writes. The changes the watcher reports together become one notice.
   */
  notifyDiskChange(projectPath: string): void {
    if (this.pendingNotify.has(projectPath)) return
    this.pendingNotify.add(projectPath)
    queueMicrotask(() => {
      this.pendingNotify.delete(projectPath)
      this.emit('changed', projectPath)
    })
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /**
   * A new task, `backlog` unless `status` says `planned`. A task with `label` and
   * `claim` migrates an existing feature: it is created `done`, with `confirmed: null`
   * (unverified), and needs `status: "done"`.
   */
  async create(projectPath: string, fields: Record<string, unknown>, by: string): Promise<{ id: string; revision: string }> {
    checkKeys(fields, CREATE_KEYS, 'task_create')
    const store = this.store(projectPath)
    const title = oneLine(text(fields.title, 'title'))
    if (!title) throw new Error('"title" must not be empty.')
    const status = (optionalText(fields.status, 'status') ?? 'backlog') as TaskStatus
    const label = optionalText(fields.label, 'label') ?? null
    const claim = optionalText(fields.claim, 'claim') ?? null
    if (status === 'done') {
      if (label === null || claim === null) throw new Error('A task is created done only to migrate an existing feature: give its "label" and "claim".')
    } else if (status !== 'backlog' && status !== 'planned') {
      throw new Error(`A new task is backlog or planned (or done with a label and claim, to migrate an existing feature), not "${status}".`)
    } else if (label !== null || claim !== null) {
      throw new Error('"label" and "claim" at creation migrate an existing feature: pass status "done" with them. A task in work gets its claim when it is closed.')
    }
    const rank = fields.rank === undefined ? null : rankValue(fields.rank)
    if (rank !== null && !isOrdered(status)) throw new Error('"rank" orders backlog and planned tasks only.')

    let id: string
    if (fields.id !== undefined && fields.id !== null) {
      id = text(fields.id, 'id')
      if (!TASK_ID_PATTERN.test(id)) throw new Error(`"${id}" is not a valid task id: lowercase letters, digits and "-", starting with a letter or digit, at most 64 characters.`)
      if (store.exists(id)) throw new Error(`Task id "${id}" is taken; choose another or leave "id" out to generate one.`)
    } else {
      const base = slugFromTitle(title)
      id = base
      for (let n = 2; store.exists(id); n++) id = `${base}-${n}`
    }

    const created = this.now().toISOString()
    const task: TaskFile = {
      id,
      title,
      status,
      rank,
      tags: fields.tags === undefined ? [] : list(fields.tags, 'tags'),
      docs: fields.docs === undefined ? [] : list(fields.docs, 'docs'),
      code: fields.code === undefined ? [] : list(fields.code, 'code'),
      reason: null,
      blockedFrom: null,
      label,
      claim,
      decidedAgainst: null,
      reopened: false,
      history: null,
      confirmed: null,
      acknowledged: null,
      check: null,
      source: optionalText(fields.source, 'source') ?? null,
      activeBy: [],
      created,
      closed: status === 'done' ? created : null,
      description: optionalText(fields.description, 'description') ?? '',
      journal: [`${this.day()} created by ${by}`]
    }
    const revisions = await this.write(projectPath, [{ task, baseRevision: null }])
    return { id, revision: revisions[id] }
  }

  /** Title, description, tags, docs, code, rank, reason, and the status changes of `STATUS_RULE`. */
  async update(projectPath: string, id: string, baseRevision: string, fields: Record<string, unknown>, by: string): Promise<{ revision: string }> {
    checkKeys(fields, UPDATE_KEYS, 'task_update')
    const userDir = this.env.userDir(projectPath)
    const { task: current } = this.store(projectPath).read(id)
    const task: TaskFile = { ...current }
    if (fields.title !== undefined) {
      task.title = oneLine(text(fields.title, 'title'))
      if (!task.title) throw new Error('"title" must not be empty.')
    }
    if (fields.description !== undefined) task.description = fields.description === null ? '' : text(fields.description, 'description')
    if (fields.tags !== undefined) task.tags = list(fields.tags, 'tags')
    if (fields.docs !== undefined) task.docs = list(fields.docs, 'docs')
    if (fields.code !== undefined) task.code = list(fields.code, 'code')
    if (fields.reason !== undefined) task.reason = fields.reason === null ? null : text(fields.reason, 'reason')

    const to = fields.status === undefined ? current.status : text(fields.status, 'status') as TaskStatus
    const from = current.status
    if (to !== from) {
      if (current.history) throw new Error(`Task "${id}" is in history; task_restore brings it back first.`)
      if (to === 'blocked' && (from === 'backlog' || from === 'planned' || from === 'active')) {
        if (!task.reason?.trim()) throw new Error('Blocking a task needs a "reason".')
        task.blockedFrom = from
      } else if (from === 'blocked' && to === current.blockedFrom) {
        task.blockedFrom = null
        if (fields.reason === undefined) task.reason = null
      } else if (from === 'active' && to === 'planned') {
        task.activeBy = []
      } else if (!(isOrdered(from) && isOrdered(to))) {
        const hint = from === 'blocked' ? ` This task was blocked from ${current.blockedFrom}.` : ''
        throw new Error(`Task "${id}" cannot go from ${from} to ${to}.${hint} ${STATUS_RULE}`)
      }
      task.status = to
      if (!isOrdered(to)) task.rank = null
      const why = fields.reason !== undefined && task.reason ? `: ${oneLine(task.reason)}` : ''
      task.journal = [...task.journal, `${this.day()} ${by}: ${from} → ${to}${why}`]
    }
    if (fields.rank !== undefined) {
      const rank = rankValue(fields.rank)
      if (rank !== null && !isOrdered(task.status)) throw new Error(`"rank" orders backlog and planned tasks; "${id}" is ${task.status}.`)
      task.rank = rank
    }
    const revisions = await this.write(projectPath, [{ task, baseRevision }])
    if (from === 'active' && task.status !== 'active') unbindTask(userDir, id)
    return { revision: revisions[id] }
  }

  /** Appends the journal line "YYYY-MM-DD <by>: <text>". */
  async note(projectPath: string, id: string, note: string, by: string): Promise<{ revision: string }> {
    const line = oneLine(text(note, 'text'))
    if (!line) throw new Error('"text" must not be empty.')
    const { task, revision } = this.store(projectPath).read(id)
    const revisions = await this.write(projectPath, [{ task: { ...task, journal: [...task.journal, `${this.day()} ${by}: ${line}`] }, baseRevision: revision }])
    return { revision: revisions[id] }
  }

  /** Makes the task `active`, records `user` in `activeBy`, and binds the tab to it (its earlier task, if any, is no longer its current one). */
  async start(projectPath: string, id: string, tabId: string, user: string): Promise<{ revision: string }> {
    const { task, revision } = this.store(projectPath).read(id)
    if (task.history) throw new Error(`Task "${id}" is in history; task_restore brings it back first.`)
    if (task.status === 'blocked') throw new Error(`Task "${id}" is blocked (${task.reason ?? 'no reason given'}); unblock it with task_update status "${task.blockedFrom}" first.`)
    if (task.status === 'done') throw new Error(`Task "${id}" is done; task_reopen it when the work turned out unfinished.`)
    if (task.status === 'cancelled') throw new Error(`Task "${id}" is cancelled; create a new task if the work is wanted after all.`)
    let current = revision
    let written = false
    if (task.status !== 'active' || !task.activeBy.includes(user)) {
      const line = task.status === 'active' ? 'started' : `started (${task.status} → active)`
      const next: TaskFile = {
        ...task,
        status: 'active',
        rank: null,
        activeBy: task.activeBy.includes(user) ? task.activeBy : [...task.activeBy, user],
        journal: [...task.journal, `${this.day()} ${this.actor(tabId)}: ${line}`]
      }
      current = (await this.store(projectPath).write([{ task: next, baseRevision: revision }]))[id]
      written = true
    }
    // One notice for the write and the binding, sent once both are on disk.
    const bound = bindTab(this.env.userDir(projectPath), tabId, id, this.bindingOwner(), this.now())
    if (written || bound) this.emit('changed', projectPath)
    return { revision: current }
  }

  /**
   * The interim close of this build step, without candidates or drift (the full close
   * replaces it). Sets the outcome, the claim and `closed`; the superseded tasks go to
   * history pointing at this one; a task left without a claim and without
   * `decidedAgainst` goes to history itself. The superseded tasks are written first and
   * this one last, so an interrupted close is found by the load check.
   */
  async closeSimple(projectPath: string, id: string, baseRevision: string, args: TaskCloseArgs, by: string): Promise<{ revisions: Record<string, string>; history: string[] }> {
    const store = this.store(projectPath)
    const { task: current } = store.read(id)
    if (args.outcome !== 'done' && args.outcome !== 'cancelled') throw new Error('"outcome" must be done or cancelled.')
    if (current.history) throw new Error(`Task "${id}" is in history; task_restore brings it back first.`)
    if (CLOSED_TASK_STATUSES.includes(current.status)) throw new Error(`Task "${id}" is already ${current.status}; task_reopen it first when the work turned out unfinished.`)
    if ((args.label === undefined) !== (args.claim === undefined)) throw new Error('"label" and "claim" go together: give both or neither.')
    if (args.claim !== undefined && args.outcome === 'cancelled') throw new Error('A cancelled task makes no claim: the claim says what the project now has.')
    const label = args.label !== undefined ? oneLine(args.label) : current.label
    const claim = args.claim !== undefined ? args.claim.trim() : current.claim
    const decidedAgainst = args.decidedAgainst !== undefined ? args.decidedAgainst.trim() || null : current.decidedAgainst
    if (claim !== null && decidedAgainst !== null) throw new Error('A task decided against carries no claim: give "claim" or "decidedAgainst", not both.')
    const code = args.code !== undefined ? list(args.code, 'code') : current.code

    const at = this.now().toISOString()
    const changes: TaskChange[] = []
    const superseded: string[] = []
    for (const otherId of args.supersedes ?? []) {
      if (otherId === id) throw new Error('A task cannot supersede itself.')
      if (superseded.includes(otherId)) continue
      const { task: other, revision } = store.read(otherId)
      if (other.history) throw new Error(`Task "${otherId}" is already in history.`)
      if (!CLOSED_TASK_STATUSES.includes(other.status)) throw new Error(`Task "${otherId}" is ${other.status}: only a closed task can be superseded. Close or cancel it first.`)
      changes.push({
        task: { ...other, history: { at, by: id, reason: `superseded by ${id}` }, journal: [...other.journal, `${this.day()} ${by}: superseded by ${id}`] },
        baseRevision: revision
      })
      superseded.push(otherId)
    }

    const toHistory = claim === null && decidedAgainst === null
    const parts = [`closed ${args.outcome}`]
    if (args.claim !== undefined) parts.push(`claim "${label}"`)
    if (superseded.length) parts.push(`supersedes ${superseded.join(', ')}`)
    if (decidedAgainst !== null) parts.push('decided against')
    if (toHistory) parts.push('to history: no claim')
    const claimChanged = label !== current.label || claim !== current.claim || JSON.stringify(code) !== JSON.stringify(current.code)
    const task: TaskFile = {
      ...current,
      status: args.outcome,
      rank: null,
      code,
      reason: args.outcome === 'cancelled' ? current.reason : null,
      blockedFrom: null,
      label,
      claim,
      decidedAgainst,
      reopened: false,
      history: toHistory ? { at, by: null, reason: 'closed without a claim' } : null,
      // Nothing computes `confirmed` yet (drift is a later build step); a changed claim is unverified.
      confirmed: claimChanged ? null : current.confirmed,
      activeBy: [],
      closed: at,
      journal: [...current.journal, `${this.day()} ${by}: ${parts.join('; ')}`]
    }
    changes.push({ task, baseRevision })
    const revisions = await this.write(projectPath, changes)
    unbindTask(this.env.userDir(projectPath), id)
    return { revisions, history: [...superseded, ...(toHistory ? [id] : [])] }
  }

  /** A done task goes back to active: the work turned out unfinished. Its claim stays, marked reopened until the next close. */
  async reopen(projectPath: string, id: string, reason: string, by: string): Promise<{ revision: string }> {
    const why = oneLine(text(reason, 'reason'))
    if (!why) throw new Error('Reopening a task needs a "reason".')
    const { task, revision } = this.store(projectPath).read(id)
    if (task.history) throw new Error(`Task "${id}" is in history; task_restore brings it back first.`)
    if (task.status !== 'done') throw new Error(`Only a done task is reopened; "${id}" is ${task.status}.`)
    const user = this.user()
    const next: TaskFile = {
      ...task,
      status: 'active',
      reopened: true,
      closed: null,
      reason: null,
      activeBy: task.activeBy.includes(user) ? task.activeBy : [...task.activeBy, user],
      journal: [...task.journal, `${this.day()} ${by}: reopened: ${why}`]
    }
    const revisions = await this.write(projectPath, [{ task: next, baseRevision: revision }])
    return { revision: revisions[id] }
  }

  /** A closed task leaves the project's state by hand, outside a close. */
  async toHistory(projectPath: string, id: string, reason: string | undefined, by: string): Promise<{ revision: string }> {
    const { task, revision } = this.store(projectPath).read(id)
    if (task.history) throw new Error(`Task "${id}" is already in history.`)
    if (!CLOSED_TASK_STATUSES.includes(task.status)) throw new Error(`Only a done or cancelled task goes to history; "${id}" is ${task.status}.`)
    const why = reason !== undefined ? oneLine(reason) : ''
    const next: TaskFile = {
      ...task,
      history: { at: this.now().toISOString(), by: null, reason: why || `moved by ${by}` },
      journal: [...task.journal, `${this.day()} ${by}: to history${why ? `: ${why}` : ''}`]
    }
    const revisions = await this.write(projectPath, [{ task: next, baseRevision: revision }])
    return { revision: revisions[id] }
  }

  /** A task in history comes back to the project's state. */
  async restore(projectPath: string, id: string, by: string): Promise<{ revision: string }> {
    const { task, revision } = this.store(projectPath).read(id)
    if (!task.history) throw new Error(`Task "${id}" is not in history.`)
    const next: TaskFile = { ...task, history: null, journal: [...task.journal, `${this.day()} ${by}: restored from history`] }
    const revisions = await this.write(projectPath, [{ task: next, baseRevision: revision }])
    return { revision: revisions[id] }
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  private tasks(projectPath: string): TaskFile[] {
    return this.store(projectPath).list().flatMap((entry) => entry.task ? [entry.task] : [])
  }

  /**
   * Case-insensitive substring match over id, title, label, claim, tags and description;
   * history only when asked for. Planned tasks by rank first, at most 50.
   */
  search(projectPath: string, query: TaskSearchQuery = {}): TaskSearchHit[] {
    const needle = query.query?.trim().toLowerCase() ?? ''
    const statuses = query.status === undefined ? null : Array.isArray(query.status) ? query.status : [query.status]
    const tags = query.tags?.length ? query.tags.map((tag) => tag.toLowerCase()) : null
    const matches = this.tasks(projectPath).filter((task) => {
      if (task.history && !query.history) return false
      if (statuses && !statuses.includes(task.status)) return false
      if (tags && !task.tags.some((tag) => tags.includes(tag.toLowerCase()))) return false
      if (!needle) return true
      return [task.id, task.title, task.label ?? '', task.claim ?? '', ...task.tags, task.description].some((field) => field.toLowerCase().includes(needle))
    })
    matches.sort((a, b) => {
      if (!!a.history !== !!b.history) return a.history ? 1 : -1
      if (ORDER[a.status] !== ORDER[b.status]) return ORDER[a.status] - ORDER[b.status]
      if (isOrdered(a.status)) {
        if (a.rank !== b.rank) return a.rank === null ? 1 : b.rank === null ? -1 : a.rank - b.rank
        return a.created.localeCompare(b.created)
      }
      // Others: the most recent first.
      return (b.closed ?? b.created).localeCompare(a.closed ?? a.created)
    })
    return matches.slice(0, SEARCH_LIMIT).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      label: task.label,
      claimFirstLine: firstLine(task.claim),
      tags: task.tags,
      history: task.history !== null
    }))
  }

  /** The task, its revision, its claim chain, the tabs bound to it and the plans that solve it. */
  get(projectPath: string, id: string): TaskDetail {
    const store = this.store(projectPath)
    const { task, revision } = store.read(id)
    const all = new Map(this.tasks(projectPath).map((t) => [t.id, t]))
    const entry = (t: TaskFile): TaskChainEntry => ({ id: t.id, title: t.title, status: t.status, label: t.label, claim: t.claim, closed: t.closed, supersededBy: t.history?.by ?? null, journal: t.journal })

    // Backwards: every task superseded by this one, and by those, and so on; the oldest generation first.
    const seen = new Set([id])
    const earlier: { task: TaskFile; depth: number }[] = []
    const queue = [{ id, depth: 0 }]
    while (queue.length) {
      const current = queue.shift()!
      for (const t of all.values()) {
        if (t.history?.by === current.id && !seen.has(t.id)) {
          seen.add(t.id)
          earlier.push({ task: t, depth: current.depth + 1 })
          queue.push({ id: t.id, depth: current.depth + 1 })
        }
      }
    }
    earlier.sort((a, b) => b.depth - a.depth || (a.task.closed ?? a.task.created).localeCompare(b.task.closed ?? b.task.created))

    // Forwards: the task that superseded this one, and the one that superseded that.
    const later: TaskFile[] = []
    for (let next = task.history?.by; next && !seen.has(next) && all.has(next); next = all.get(next)!.history?.by) {
      seen.add(next)
      later.push(all.get(next)!)
    }

    return {
      task,
      revision,
      chain: { earlier: earlier.map((e) => entry(e.task)), later: later.map(entry) },
      tabs: this.bindings(projectPath).filter((binding) => binding.here && binding.task === id).map((binding) => binding.tabId),
      plans: []
    }
  }
  // ── tab bindings (§6) ──────────────────────────────────────────────────────

  /** Tabs of this AIDE closed: their bindings go. */
  unbindTabs(projectPath: string, tabIds: string[]): void {
    if (!tabIds.length) return
    if (unbindTabs(this.env.userDir(projectPath), tabIds, this.bindingOwner())) this.emit('changed', projectPath)
  }

  /**
   * The bindings of every user of the project that count: to an active task, and for this
   * user on this host only those of tabs open in this AIDE (a binding of an earlier AIDE
   * process or a closed tab is left over). A binding of another user or host is theirs.
   */
  bindings(projectPath: string, tasks: TaskFile[] = this.tasks(projectPath)): TaskBindingView[] {
    const active = new Set(tasks.filter((task) => task.status === 'active' && !task.history).map((task) => task.id))
    const owner = this.bindingOwner()
    const views: TaskBindingView[] = []
    for (const binding of readAllBindings(this.env.userDir(projectPath))) {
      if (!active.has(binding.task)) continue
      const user = binding.user ?? owner.user
      const host = binding.host ?? owner.host
      if (isThisUserHere(binding, owner)) {
        if (!isOwn(binding, owner) || !(this.env.liveTab?.(binding.tabId) ?? true)) continue
        views.push({ tabId: binding.tabId, task: binding.task, since: binding.since, user, host, here: true, who: actorOf(user, binding.tabId) })
      } else {
        views.push({ tabId: binding.tabId, task: binding.task, since: binding.since, user, host, here: false, who: user === owner.user ? `${user} on ${host}` : user })
      }
    }
    return views
  }

  /** The current task of each tab of this AIDE, for the terminal tab strip. */
  tabTasks(projectPath: string): Record<string, { id: string; title: string }> {
    const tasks = this.tasks(projectPath)
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const result: Record<string, { id: string; title: string }> = {}
    for (const binding of this.bindings(projectPath, tasks)) {
      if (binding.here) result[binding.tabId] = { id: binding.task, title: byId.get(binding.task)?.title ?? binding.task }
    }
    return result
  }

  // ── orientation, snapshot and tails (§7) ───────────────────────────────────

  /** The tracker part of the MCP server instructions; the rule only for a project without `aide/tasks/`. */
  orientation(projectPath: string): string {
    return trackerOrientation(existsSync(join(projectPath, TASKS_DIR)) ? this.tasks(projectPath) : null)
  }

  /** Load-check problems and stale active tasks, one message each, with a key per problem for the tail. */
  private problems(projectPath: string, entries: TaskListEntry[], bindings: TaskBindingView[]): { key: string; message: string }[] {
    const tasks = entries.flatMap((entry) => entry.task ? [entry.task] : [])
    const loaded = this.store(projectPath).problems(entries).map((problem) => ({ key: `${problem.kind}:${problem.ids.join(',')}`, message: problem.message }))
    const bound = new Set(bindings.map((binding) => binding.task))
    const stale = staleActives(tasks, bound, this.env.runActive?.(projectPath) ?? false, this.now())
      .map((problem) => ({ key: `stale:${problem.id}`, message: problem.message }))
    return [...loaded, ...stale]
  }

  /** The text of `task_snapshot` for a tab (null outside a tab); the connection has seen the tracker as it is now. */
  snapshot(projectPath: string, tabId: string | null, connectionId?: string): string {
    const store = this.store(projectPath)
    const entries = store.list()
    const tasks = entries.flatMap((entry) => entry.task ? [entry.task] : [])
    const bindings = this.bindings(projectPath, tasks)
    const own = tabId ? bindings.find((binding) => binding.here && binding.tabId === tabId) : undefined
    const workers: Workers = new Map()
    for (const task of tasks) {
      if (task.status !== 'active' || task.history) continue
      const who = bindings.filter((binding) => binding.task === task.id).map((binding) => binding.who)
      for (const user of task.activeBy) if (!bindings.some((binding) => binding.task === task.id && binding.user === user)) who.push(`${user} (no tab)`)
      workers.set(task.id, who)
    }
    let budget: number
    let configProblem: string[] = []
    try {
      budget = store.config().snapshotLabelBudget
    } catch (err) {
      budget = DEFAULT_TASK_CONFIG.snapshotLabelBudget
      configProblem = [err instanceof Error ? err.message : String(err)]
    }
    const text = renderSnapshot({
      tasks,
      labelBudget: budget,
      tabId,
      current: own ? tasks.find((task) => task.id === own.task) ?? null : null,
      problems: [...configProblem, ...this.problems(projectPath, entries, bindings).map((problem) => problem.message)],
      workers,
      now: this.now()
    })
    if (connectionId) this.tail.seen(projectPath, connectionId)
    return text
  }

  /** A connection starts (MCP initialize): its tail counts from now. */
  beginConnection(projectPath: string, connectionId: string): void {
    this.tail.seen(projectPath, connectionId)
  }

  /** The tail for a tool result of a connection, or null when nothing changed since its last one (its own changes left out). */
  tailFor(projectPath: string, connectionId: string, tabId: string | null): string | null {
    return this.tail.take(projectPath, connectionId, tabId ? this.actor(tabId) : null)
  }

  /** The project closed: drop its tails. */
  forget(projectPath: string): void {
    this.tail.forget(projectPath)
  }

  private trackerState(projectPath: string): TrackerState {
    const entries = this.store(projectPath).list()
    const tasks = entries.flatMap((entry) => entry.task ? [entry.task] : [])
    const problems = this.problems(projectPath, entries, this.bindings(projectPath, tasks))
    return summarize(entries, problems.map((problem) => problem.key))
  }
}
