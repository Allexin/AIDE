import { randomBytes } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, writeSync, type FSWatcher } from 'fs'
import { hostname, userInfo } from 'os'
import { join } from 'path'
import { CLOSED_TASK_STATUSES, DEFAULT_TASK_CONFIG, type TaskConfig, type TaskFile, type TaskListEntry, type TaskProblem } from '../../shared/task'
import { frontMatterId, parseTask, revisionOf, serializeTask, taskProblems } from './taskFile'

/**
 * Task files on disk (docs/task-tracker-implementation.md §3):
 *   <project>/aide/tasks/<id>.md          one task, written by AIDE only through `write`
 *   <project>/aide/tasks/config.json      tracker settings
 *   <project>/aide/tasks/.write-lock      the write lease
 *   <userDir>                             `.aide/users/<user>/tasks`, per-user state (bindings, later)
 *
 * Every read goes to the files, so an edit made by hand or by another AIDE on a
 * shared folder is seen at once.
 */

export const TASKS_DIR = 'aide/tasks'

/** How long a taken lease is valid; a write never takes that long, so it is not renewed. */
export const LEASE_MS = 10_000
/** A writer gives up after waiting this long for leases that other writers keep taking. */
export const LEASE_WAIT_LIMIT_MS = 3 * LEASE_MS

const LEASE_FILE = '.write-lock'

/** Project-relative path of a task file, with forward slashes. */
export function taskRelativePath(id: string): string {
  return `${TASKS_DIR}/${id}.md`
}

/** A change to a tracker file is not part of a run's work: AIDE never stages it. */
export function isTrackerPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(`${TASKS_DIR}/`)
}

/** A write refused because tasks changed since the caller read them; nothing was written. */
export class TaskConflictError extends Error {
  constructor(readonly ids: string[], message: string) {
    super(message)
    this.name = 'TaskConflictError'
  }
}

export interface TaskChange {
  task: TaskFile
  /** Revision the caller read; null for a new task. */
  baseRevision: string | null
}

interface Lease {
  user: string
  host: string
  pid: number
  /** ISO time. */
  expires: string
  /** Tells two writers of one process apart when the holder confirms a takeover. */
  token: string
}

export interface LeaseOwner { user: string; host: string }

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, path)
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

export class TaskStore {
  private readonly owner: LeaseOwner

  constructor(private readonly projectPath: string, readonly userDir: string, owner?: LeaseOwner) {
    this.owner = owner ?? { user: userInfo().username, host: hostname() }
  }

  private tasksDir(): string {
    return join(this.projectPath, 'aide', 'tasks')
  }

  private taskPath(id: string): string {
    return join(this.tasksDir(), `${id}.md`)
  }

  private leasePath(): string {
    return join(this.tasksDir(), LEASE_FILE)
  }

  list(): TaskListEntry[] {
    if (!existsSync(this.tasksDir())) return []
    return readdirSync(this.tasksDir()).filter((name) => name.endsWith('.md')).sort().map((name) => this.entry(name.slice(0, -'.md'.length)))
  }

  private entry(id: string): TaskListEntry {
    const file = taskRelativePath(id)
    const bytes = readOrNull(this.taskPath(id))
    if (bytes === null) return { id, file, task: null, revision: null, error: `${file} cannot be read` }
    const parsed = parseTask(bytes.toString('utf8'), `${id}.md`)
    if ('errors' in parsed) return { id, file, task: null, revision: revisionOf(bytes), error: `${file} is invalid:\n- ${parsed.errors.join('\n- ')}` }
    return { id, file, task: parsed.task, revision: revisionOf(bytes), error: null }
  }

  exists(id: string): boolean {
    return existsSync(this.taskPath(id))
  }

  /** The task and its revision; throws with a readable message when it is missing or invalid. */
  read(id: string): { task: TaskFile; revision: string } {
    if (!this.exists(id)) throw new Error(`Unknown task "${id}".`)
    const entry = this.entry(id)
    if (!entry.task || !entry.revision) throw new Error(entry.error ?? `${entry.file} cannot be read`)
    return { task: entry.task, revision: entry.revision }
  }

  /**
   * The only write path. Every change names the revision it was based on; when any
   * task changed since (or a new one already exists), the whole batch is refused and
   * nothing is written. Files are written in array order, the last change last, so an
   * interrupted multi-file write leaves the earlier tasks pointing at a task that is
   * not closed, which `problems()` reports. Returns the new revision of each task.
   */
  async write(changes: TaskChange[]): Promise<Record<string, string>> {
    const seen = new Set<string>()
    for (const { task } of changes) {
      const problems = taskProblems(task)
      if (problems.length) throw new Error(`Task "${String((task as Partial<TaskFile>)?.id)}" is invalid:\n- ${problems.join('\n- ')}`)
      if (seen.has(task.id)) throw new Error(`Task "${task.id}" appears twice in one write.`)
      seen.add(task.id)
    }
    // Fail fast without the lease; checked again under it.
    this.checkRevisions(changes)
    mkdirSync(this.tasksDir(), { recursive: true })
    const lease = await this.acquireLease()
    try {
      this.checkRevisions(changes)
      const revisions: Record<string, string> = {}
      for (const { task } of changes) {
        const text = serializeTask(task)
        writeAtomic(this.taskPath(task.id), text)
        revisions[task.id] = revisionOf(text)
      }
      return revisions
    } finally {
      this.releaseLease(lease)
    }
  }

  private checkRevisions(changes: TaskChange[]): void {
    const changed: { id: string; what: string }[] = []
    const invalid: string[] = []
    for (const { task, baseRevision } of changes) {
      const bytes = readOrNull(this.taskPath(task.id))
      if (bytes === null) {
        if (baseRevision !== null) changed.push({ id: task.id, what: 'deleted' })
        continue
      }
      const revision = revisionOf(bytes)
      if (baseRevision === null) changed.push({ id: task.id, what: `already exists, revision ${revision}` })
      else if (revision !== baseRevision) changed.push({ id: task.id, what: `now revision ${revision}` })
      else if ('errors' in parseTask(bytes.toString('utf8'), `${task.id}.md`)) invalid.push(task.id)
    }
    if (changed.length) {
      const list = changed.map((c) => `${c.id} (${c.what})`).join(', ')
      throw new TaskConflictError(changed.map((c) => c.id), `Nothing was written: these tasks changed since you read them: ${list}. Read them again and retry.`)
    }
    if (invalid.length) throw new Error(`Nothing was written: ${invalid.map(taskRelativePath).join(', ')} ${invalid.length > 1 ? 'are' : 'is'} invalid; fix the file by hand first.`)
  }

  // ── write lease ────────────────────────────────────────────────────────────

  private newLease(): Lease {
    return { ...this.owner, pid: process.pid, expires: new Date(Date.now() + LEASE_MS).toISOString(), token: randomBytes(8).toString('hex') }
  }

  /** The lease on disk and when it expires; an unreadable lease (being written, or left empty by a crash) expires by its mtime. */
  private readLease(): { lease: Lease | null; text: string; expiresAt: number } | null {
    const path = this.leasePath()
    let text: string
    let mtime: number
    try {
      text = readFileSync(path, 'utf8')
      mtime = statSync(path).mtimeMs
    } catch {
      return null
    }
    try {
      const lease = JSON.parse(text) as Lease
      const expiresAt = Date.parse(lease.expires)
      if (!Number.isNaN(expiresAt)) return { lease, text, expiresAt }
    } catch { /* fall through */ }
    return { lease: null, text, expiresAt: mtime + LEASE_MS }
  }

  /** Create the lease file exclusively; false when it exists. */
  private tryCreate(lease: Lease): boolean {
    let fd: number
    try {
      fd = openSync(this.leasePath(), 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
    try {
      writeSync(fd, JSON.stringify(lease))
    } finally {
      closeSync(fd)
    }
    return true
  }

  /** Replace an expired lease, then read it back: another writer may have replaced it at the same moment. */
  private tryTakeOver(lease: Lease): boolean {
    writeAtomic(this.leasePath(), JSON.stringify(lease))
    return this.readLease()?.lease?.token === lease.token
  }

  private async acquireLease(): Promise<Lease> {
    const giveUpAt = Date.now() + LEASE_WAIT_LIMIT_MS
    for (;;) {
      const lease = this.newLease()
      if (this.tryCreate(lease)) return lease
      const current = this.readLease()
      if (current === null) continue // released between our attempt and the read
      if (current.expiresAt <= Date.now()) {
        if (this.tryTakeOver(lease)) return lease
        continue
      }
      if (Date.now() >= giveUpAt) {
        const holder = current.lease ? `${current.lease.user} on ${current.lease.host}` : 'another writer'
        throw new Error(`The task tracker is being written by ${holder}; try again.`)
      }
      await this.waitForLeaseChange(current.text, Math.min(current.expiresAt, giveUpAt))
    }
  }

  /** Resolves when the lease file changes or disappears, or at `until` at the latest. */
  private waitForLeaseChange(seen: string, until: number): Promise<void> {
    return new Promise((resolve) => {
      let watcher: FSWatcher | null = null
      let timer: NodeJS.Timeout | null = null
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        watcher?.close()
        resolve()
      }
      try {
        watcher = watch(this.tasksDir(), (_event, name) => {
          if (!name || name.toString() === LEASE_FILE) finish()
        })
        // A watcher that fails (the folder went away, a share dropped) ends the wait; the loop looks again.
        watcher.on('error', finish)
      } catch {
        // No watching on this file system: the expiry bounds the wait.
      }
      // Bounds the wait for the event: on a share the change may never be reported.
      timer = setTimeout(finish, Math.max(0, until - Date.now()))
      // The lease may have been released between the read and the watch.
      const now = this.readLease()
      if (now === null || now.text !== seen) finish()
    })
  }

  private releaseLease(lease: Lease): void {
    if (this.readLease()?.lease?.token !== lease.token) return // expired and taken over: not ours to remove
    try {
      unlinkSync(this.leasePath())
    } catch { /* already gone */ }
  }

  // ── load check and config ──────────────────────────────────────────────────

  /** Duplicate ids, invalid files, and tasks in history pointing at a task that is not closed. */
  problems(entries: TaskListEntry[] = this.list()): TaskProblem[] {
    const problems: TaskProblem[] = []
    const byId = new Map<string, string[]>()
    for (const entry of entries) {
      const id = entry.task?.id ?? this.rawId(entry.id) ?? entry.id
      byId.set(id, [...(byId.get(id) ?? []), entry.file])
    }
    for (const [id, files] of byId) {
      if (files.length > 1) problems.push({ kind: 'duplicate-id', ids: [id], message: `Task id "${id}" is used by ${files.length} files: ${files.join(', ')}.` })
    }
    for (const entry of entries) {
      if (entry.error) problems.push({ kind: 'invalid', ids: [entry.id], message: entry.error })
    }
    const tasks = new Map(entries.filter((e) => e.task).map((e) => [e.task!.id, e.task!]))
    const files = new Set(entries.map((e) => e.id))
    for (const task of tasks.values()) {
      const by = task.history?.by
      if (!by) continue
      const target = tasks.get(by)
      if (target && CLOSED_TASK_STATUSES.includes(target.status)) continue
      if (!target && files.has(by)) continue // its file is invalid, reported above
      const state = target ? `is ${target.status}, not closed` : 'does not exist'
      problems.push({ kind: 'dangling-history', ids: [task.id, by], message: `Task "${task.id}" is in history as superseded by "${by}", which ${state} (an interrupted close?).` })
    }
    return problems
  }

  private rawId(fileId: string): string | null {
    const bytes = readOrNull(this.taskPath(fileId))
    return bytes ? frontMatterId(bytes.toString('utf8')) : null
  }

  /** `aide/tasks/config.json`; a missing file or key means the default. Throws on an invalid file. */
  config(): TaskConfig {
    const path = join(this.tasksDir(), 'config.json')
    if (!existsSync(path)) return { ...DEFAULT_TASK_CONFIG }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`${TASKS_DIR}/config.json is not valid JSON (${err instanceof Error ? err.message : String(err)}).`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${TASKS_DIR}/config.json must be a JSON object.`)
    const budget = (value as Record<string, unknown>).snapshotLabelBudget
    if (budget === undefined) return { ...DEFAULT_TASK_CONFIG }
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0) throw new Error(`${TASKS_DIR}/config.json: "snapshotLabelBudget" must be a positive whole number of characters.`)
    return { ...DEFAULT_TASK_CONFIG, snapshotLabelBudget: budget }
  }
}
