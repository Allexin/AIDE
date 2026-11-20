import type { TaskFile } from '../../shared/task'

/**
 * What the tracker tells an agent (docs/task-tracker-implementation.md §7): the
 * orientation in the MCP server's instructions and the text of `task_snapshot`.
 * Pure functions over the tasks; `TaskService` gathers the inputs.
 */

/** The tracker's rule, the first part of the orientation, so a cut never removes it. */
export const TRACKER_RULE = "Task tracker (task_* tools): the project's state — what is in it, what we do, what we decided not to do. Call task_snapshot before you start work. A work item goes to task_create, never into a TODO in a file; a task is what the user would ask about a week later, anything needed only for the current work belongs in a plan."

/** Characters of the tracker part of the server instructions, the rule included. */
export const ORIENTATION_LIMIT = 2500

const PLANNED_IN_ORIENTATION = 5
const TITLE_IN_ORIENTATION = 80
const SNAPSHOT_PLANNED_TAGS = 5
const DESCRIPTION_CHARS = 600
const JOURNAL_LINES = 5
const RECENT_DAYS = 7
const STALE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const NO_TAG = '(no tag)'

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** A claim of the project's state: a task not in history that has one (a reopened task keeps its claim). */
export function hasClaim(task: TaskFile): boolean {
  return !task.history && task.claim !== null
}

function isDecidedAgainst(task: TaskFile): boolean {
  return !task.history && task.claim === null && task.decidedAgainst !== null
}

/** The tag a task is listed under: its first. */
function tagOf(task: TaskFile): string {
  return task.tags[0] ?? NO_TAG
}

function byRank(a: TaskFile, b: TaskFile): number {
  if (a.rank !== b.rank) return a.rank === null ? 1 : b.rank === null ? -1 : a.rank - b.rank
  return a.created.localeCompare(b.created)
}

/** Planned tasks, by rank. */
function plannedTasks(tasks: TaskFile[]): TaskFile[] {
  return tasks.filter((task) => !task.history && task.status === 'planned').sort(byRank)
}

/**
 * The tracker part of the server instructions, at most `limit` characters: the rule,
 * then the claims per tag and the planned tasks as they are when the session starts.
 * `tasks` is null for a project without `aide/tasks/`: it gets the rule only.
 */
export function trackerOrientation(tasks: TaskFile[] | null, limit: number = ORIENTATION_LIMIT): string {
  if (tasks === null) return TRACKER_RULE.slice(0, limit)
  const head = `${TRACKER_RULE} Rules: task_guide.`
  const counts = new Map<string, number>()
  for (const task of tasks) if (hasClaim(task)) counts.set(tagOf(task), (counts.get(tagOf(task)) ?? 0) + 1)
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) => `${tag} ${n}`)
  const planned = plannedTasks(tasks).slice(0, PLANNED_IN_ORIENTATION).map((task) => clipText(task.title, TITLE_IN_ORIENTATION))
  const suffix = ' (as of session start)'
  const plannedText = planned.length ? ` Planned next: ${planned.join('; ')}${plannedTasks(tasks).length > planned.length ? '; …' : ''}` : ' Planned next: none.'

  // The tags take what the planned titles leave; tags that do not fit become "…".
  const room = limit - head.length - 1 - plannedText.length - suffix.length
  const lead = 'Tags (claims): '
  let tagText = tags.length ? '' : 'none yet.'
  for (let i = 0; i < tags.length; i++) {
    const next = `${tagText}${i ? ', ' : ''}${tags[i]}`
    const more = i < tags.length - 1 ? ', …' : ''
    if (lead.length + next.length + more.length > room) {
      tagText = `${tagText}${i ? ', ' : ''}…`
      break
    }
    tagText = next
  }
  const text = `${head}\n${lead}${tagText}${plannedText}${suffix}`
  return text.length <= limit ? text : text.slice(0, limit)
}

// ── task_snapshot ────────────────────────────────────────────────────────────

/** Who works on an active task: "alice/tab 3" for a tab of this AIDE, "bob" for another user. */
export type Workers = Map<string, string[]>

export interface SnapshotInput {
  tasks: TaskFile[]
  /** Characters of section 0 (`snapshotLabelBudget`). */
  labelBudget: number
  /** The calling tab, null for a session outside an AIDE tab. */
  tabId: string | null
  /** The tab's current task, if it has one. */
  current: TaskFile | null
  /** Load-check problems and stale active tasks, one message each. */
  problems: string[]
  workers: Workers
  now: Date
}

interface ClaimEntry {
  tag: string
  text: string
  /** ISO time the task was closed, for the order of tags. */
  closed: string
}

function claimEntries(tasks: TaskFile[]): ClaimEntry[] {
  const entries: ClaimEntry[] = []
  for (const task of tasks) {
    const name = task.label ?? task.title
    if (hasClaim(task)) {
      const marks = `${task.reopened ? ' (reopened)' : ''}${task.confirmed === null ? ' (unverified)' : ''}`
      entries.push({ tag: tagOf(task), text: `${name}${marks}`, closed: task.closed ?? task.created })
    } else if (isDecidedAgainst(task)) {
      entries.push({ tag: tagOf(task), text: `${name} (decided against)`, closed: task.closed ?? task.created })
    }
  }
  return entries
}

/**
 * The order in which tags are kept when the claims do not fit: tags of active tasks,
 * tags of the first 5 planned tasks, then the rest by their most recent close.
 */
export function tagPriority(tasks: TaskFile[], entries: ClaimEntry[]): string[] {
  const order: string[] = []
  const add = (tag: string): void => { if (!order.includes(tag)) order.push(tag) }
  const withClaims = new Set(entries.map((entry) => entry.tag))
  const active = tasks.filter((task) => !task.history && task.status === 'active').sort((a, b) => a.id.localeCompare(b.id))
  for (const task of active) for (const tag of task.tags) if (withClaims.has(tag)) add(tag)
  for (const task of plannedTasks(tasks).slice(0, SNAPSHOT_PLANNED_TAGS)) for (const tag of task.tags) if (withClaims.has(tag)) add(tag)
  const latest = new Map<string, string>()
  for (const entry of entries) if ((latest.get(entry.tag) ?? '') < entry.closed) latest.set(entry.tag, entry.closed)
  for (const [tag] of [...latest].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))) add(tag)
  return order
}

const claimsCount = (n: number): string => `${n} claim${n === 1 ? '' : 's'}`

/**
 * Section 0: claims as labels grouped by tag, within `budget` characters. Over budget,
 * whole tags are kept in the order of `tagPriority` up to the first that does not fit;
 * the others are listed as "tag (N claims)" and the section ends with the count left out.
 */
export function claimsSection(tasks: TaskFile[], budget: number): string {
  const entries = claimEntries(tasks)
  const title = '## Project: claims by tag'
  if (!entries.length) return `${title}\nNo claims yet.`
  const byTag = new Map<string, ClaimEntry[]>()
  for (const entry of entries) byTag.set(entry.tag, [...(byTag.get(entry.tag) ?? []), entry])
  const order = tagPriority(tasks, entries)
  const line = (tag: string): string => `${tag}: ${byTag.get(tag)!.map((entry) => entry.text).sort((a, b) => a.localeCompare(b)).join('; ')}`

  const full = [title, ...order.map(line)].join('\n')
  if (full.length <= budget) return full

  // What the left-out part takes at most: every tag in the "Other tags" line and the count.
  const otherLine = (tags: string[]): string => `Other tags: ${tags.map((tag) => `${tag} (${claimsCount(byTag.get(tag)!.length)})`).join(', ')}`
  const leftOutLine = (n: number): string => `${claimsCount(n)} left out — task_search`
  const reserve = otherLine(order).length + leftOutLine(entries.length).length + 2
  const kept: string[] = []
  let length = title.length
  for (const tag of order) {
    const next = line(tag)
    if (length + 1 + next.length + reserve > budget) break
    kept.push(tag)
    length += 1 + next.length
  }
  const rest = order.filter((tag) => !kept.includes(tag))
  const leftOut = rest.reduce((n, tag) => n + byTag.get(tag)!.length, 0)
  return [title, ...kept.map(line), otherLine(rest), leftOutLine(leftOut)].join('\n')
}

function currentSection(input: SnapshotInput): string {
  const title = "## This tab's task"
  if (!input.tabId) return `${title}\nThis session runs outside an AIDE terminal tab: it has no current task.`
  const task = input.current
  if (!task) return `${title}\nNone. task_start the task before you work on it.`
  const lines = [title, `${task.title} (${task.id}), ${task.status}${task.reopened ? ', reopened' : ''}`]
  const description = task.description.trim()
  if (description) lines.push(clipText(description, DESCRIPTION_CHARS))
  const journal = task.journal.slice(-JOURNAL_LINES)
  if (journal.length) lines.push('Journal:', ...journal.map((entry) => `- ${entry}`))
  if (task.docs.length) lines.push(`Docs: ${task.docs.join(', ')}`)
  return lines.join('\n')
}

function problemsSection(problems: string[]): string {
  return ['## Problems', ...(problems.length ? problems.map((problem) => `- ${problem}`) : ['None.'])].join('\n')
}

function workSection(input: SnapshotInput): string {
  const active = input.tasks.filter((task) => !task.history && task.status === 'active').sort((a, b) => a.id.localeCompare(b.id))
  const blocked = input.tasks.filter((task) => !task.history && task.status === 'blocked').sort((a, b) => a.id.localeCompare(b.id))
  const lines = ['## Active and blocked']
  if (!active.length && !blocked.length) lines.push('No active or blocked tasks.')
  for (const task of active) {
    const who = input.workers.get(task.id) ?? []
    lines.push(`- active ${task.id}: ${task.title} — ${who.length ? who.join(', ') : 'nobody'}`)
  }
  for (const task of blocked) lines.push(`- blocked ${task.id}: ${task.title} — ${task.reason ?? 'no reason given'}`)
  return lines.join('\n')
}

function recentSection(input: SnapshotInput): string {
  const since = new Date(input.now.getTime() - RECENT_DAYS * DAY_MS).toISOString()
  const recent: { at: string; line: string }[] = []
  for (const task of input.tasks) {
    if (task.history && task.history.at >= since) {
      recent.push({ at: task.history.at, line: `- ${task.id}: ${task.title} — to history ${task.history.at.slice(0, 10)} (${task.history.reason})` })
    } else if (task.closed && task.closed >= since) {
      recent.push({ at: task.closed, line: `- ${task.id}: ${task.title} — ${task.status} ${task.closed.slice(0, 10)}${task.label ? `, claim "${task.label}"` : ''}` })
    }
  }
  recent.sort((a, b) => b.at.localeCompare(a.at))
  return [`## Closed or moved to history in the last ${RECENT_DAYS} days`, ...(recent.length ? recent.map((entry) => entry.line) : ['None.'])].join('\n')
}

/** The text of `task_snapshot`: sections 0–4 in the order of the spec's §Context delivery. */
export function renderSnapshot(input: SnapshotInput): string {
  return [
    claimsSection(input.tasks, input.labelBudget),
    currentSection(input),
    problemsSection(input.problems),
    workSection(input),
    recentSection(input)
  ].join('\n\n')
}

/** The day of a task's last change: its last journal line, or its creation. */
function lastChange(task: TaskFile): string {
  for (let i = task.journal.length - 1; i >= 0; i--) {
    const day = /^(\d{4}-\d{2}-\d{2}) /.exec(task.journal[i])?.[1]
    if (day) return day
  }
  return task.created.slice(0, 10)
}

/**
 * Active tasks nobody seems to work on: bound to no tab anywhere while no pipeline run
 * is going, or not changed for 7 days. One message each.
 */
export function staleActives(tasks: TaskFile[], bound: Set<string>, runActive: boolean, now: Date): { id: string; message: string }[] {
  const limit = new Date(now.getTime() - STALE_DAYS * DAY_MS).toISOString().slice(0, 10)
  const stale: { id: string; message: string }[] = []
  for (const task of tasks) {
    if (task.history || task.status !== 'active') continue
    const changed = lastChange(task)
    if (changed < limit) stale.push({ id: task.id, message: `Task "${task.id}" is active but has not changed since ${changed}: pause it (task_update status "planned") or close it.` })
    else if (!bound.has(task.id) && !runActive) stale.push({ id: task.id, message: `Task "${task.id}" is active but no tab works on it: pause it (task_update status "planned"), close it, or task_start it.` })
  }
  return stale
}
