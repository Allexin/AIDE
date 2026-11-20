import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Tab bindings (docs/task-tracker-implementation.md §6): which task each terminal tab
 * works on. One file per user, `.aide/users/<user>/tasks/bindings.json`:
 * `{ "<tabId>": { "task": "<id>", "since": "<ISO>", "user", "host", "pid" } }`.
 *
 * Each binding names the user, host and AIDE process that wrote it, so a reader never
 * derives the user from the directory name and tells its own tabs from the tabs of
 * another AIDE: tab ids restart at tab-1 with every AIDE process, so a binding of an
 * earlier process (a crash, a closed window) is not mistaken for a tab open now.
 */

export interface TabBinding {
  task: string
  /** ISO time. */
  since: string
  /** The user name recorded in `activeBy` and journal lines. */
  user?: string
  host?: string
  /** The AIDE process whose tab this is. */
  pid?: number
}

export type Bindings = Record<string, TabBinding>

/** Who writes a binding: this user in this AIDE process. */
export interface BindingOwner {
  user: string
  host: string
  pid: number
}

const FILE = 'bindings.json'

function isBinding(value: unknown): value is TabBinding {
  if (!value || typeof value !== 'object') return false
  const b = value as TabBinding
  return typeof b.task === 'string' && typeof b.since === 'string' &&
    (b.user === undefined || typeof b.user === 'string') && (b.host === undefined || typeof b.host === 'string') && (b.pid === undefined || typeof b.pid === 'number')
}

/** The bindings in `userDir`; a missing or unreadable file means none. */
export function readBindings(userDir: string): Bindings {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(userDir, FILE), 'utf8'))
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, TabBinding] => isBinding(entry[1])))
}

function writeBindings(userDir: string, bindings: Bindings): void {
  mkdirSync(userDir, { recursive: true })
  const path = join(userDir, FILE)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(bindings, null, 2), 'utf8')
  renameSync(temp, path)
}

/**
 * Bind `tabId` to `taskId`; the tab's earlier task, if any, is no longer its current one.
 * The bindings an earlier AIDE process of this user left on this host go with the write.
 * Returns whether the file changed.
 */
export function bindTab(userDir: string, tabId: string, taskId: string, owner: BindingOwner, now: Date = new Date()): boolean {
  const all = readBindings(userDir)
  const current = all[tabId]
  if (current && current.task === taskId && isOwn(current, owner)) return false
  const bindings = Object.fromEntries(Object.entries(all).filter(([, binding]) => !isThisUserHere(binding, owner) || isOwn(binding, owner)))
  bindings[tabId] = { task: taskId, since: now.toISOString(), user: owner.user, host: owner.host, pid: owner.pid }
  writeBindings(userDir, bindings)
  return true
}

/** Drop the bindings of these tabs (they closed). Returns whether the file changed. */
export function unbindTabs(userDir: string, tabIds: string[], owner: BindingOwner): boolean {
  return dropWhere(userDir, (tabId, binding) => tabIds.includes(tabId) && isOwn(binding, owner))
}

/** Drop every binding to `taskId` (it left `active`). Returns whether the file changed. */
export function unbindTask(userDir: string, taskId: string): boolean {
  return dropWhere(userDir, (_tabId, binding) => binding.task === taskId)
}

/** Drop the bindings `drop` selects. Returns whether the file changed. */
function dropWhere(userDir: string, drop: (tabId: string, binding: TabBinding) => boolean): boolean {
  const bindings = readBindings(userDir)
  const kept = Object.fromEntries(Object.entries(bindings).filter(([tabId, binding]) => !drop(tabId, binding)))
  if (Object.keys(kept).length === Object.keys(bindings).length) return false
  writeBindings(userDir, kept)
  return true
}

/**
 * Whether `binding` was written by `owner`'s process. A binding without a host or pid
 * (written before they were recorded) counts as this user's on this host, from an
 * earlier process.
 */
export function isOwn(binding: TabBinding, owner: BindingOwner): boolean {
  return (binding.user ?? owner.user) === owner.user && (binding.host ?? owner.host) === owner.host && binding.pid === owner.pid
}

/** Whether `binding` was written on this host by this user, by any AIDE process. */
export function isThisUserHere(binding: TabBinding, owner: BindingOwner): boolean {
  return (binding.user ?? owner.user) === owner.user && (binding.host ?? owner.host) === owner.host
}

/** One binding read from a user's file, with the directory it was read from. */
export interface BindingEntry extends TabBinding {
  tabId: string
  /** The `tasks` directory of the user the file belongs to. */
  userDir: string
}

/**
 * The bindings of every user of the project: `.aide/users/<each user>/tasks/bindings.json`, where
 * `ownUserDir` is this user's `.aide/users/<user>/tasks`. On a shared folder this shows
 * which tasks the others work on.
 */
export function readAllBindings(ownUserDir: string): BindingEntry[] {
  const usersRoot = dirname(dirname(ownUserDir))
  const taskDirName = ownUserDir.slice(dirname(ownUserDir).length + 1)
  let users: string[]
  try {
    users = readdirSync(usersRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    users = []
  }
  const dirs = new Set([ownUserDir, ...users.map((user) => join(usersRoot, user, taskDirName))])
  const entries: BindingEntry[] = []
  for (const userDir of dirs) {
    for (const [tabId, binding] of Object.entries(readBindings(userDir))) entries.push({ ...binding, tabId, userDir })
  }
  return entries
}
