import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Tab bindings of one user (docs/task-tracker-implementation.md §6):
 * `.aide/users/<user>/tasks/bindings.json`, `{ "<tabId>": { "task": "<id>", "since": "<ISO>" } }`.
 *
 * The minimal part `task_start` needs: bind a tab, drop the bindings of a task that
 * left `active`, read them. Removing a binding when its tab closes, and reading the
 * bindings of the other users of a shared folder, come with the binding task.
 */

export interface TabBinding {
  task: string
  /** ISO time. */
  since: string
}

export type Bindings = Record<string, TabBinding>

const FILE = 'bindings.json'

function isBinding(value: unknown): value is TabBinding {
  return !!value && typeof value === 'object' && typeof (value as TabBinding).task === 'string' && typeof (value as TabBinding).since === 'string'
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

/** Bind `tabId` to `taskId`; the tab's earlier task, if any, is no longer its current one. */
export function bindTab(userDir: string, tabId: string, taskId: string, now: Date = new Date()): void {
  const bindings = readBindings(userDir)
  if (bindings[tabId]?.task === taskId) return
  bindings[tabId] = { task: taskId, since: now.toISOString() }
  writeBindings(userDir, bindings)
}

/** Drop every binding to `taskId` (it left `active`). */
export function unbindTask(userDir: string, taskId: string): void {
  const bindings = readBindings(userDir)
  const kept = Object.fromEntries(Object.entries(bindings).filter(([, binding]) => binding.task !== taskId))
  if (Object.keys(kept).length !== Object.keys(bindings).length) writeBindings(userDir, kept)
}

/** Tabs bound to `taskId`. */
export function tabsOf(bindings: Bindings, taskId: string): string[] {
  return Object.entries(bindings).filter(([, binding]) => binding.task === taskId).map(([tabId]) => tabId)
}
