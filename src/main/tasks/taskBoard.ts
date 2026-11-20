import type { TaskBoard, TaskBoardItem, TaskFile, TaskListEntry } from '../../shared/task'
import { byRank, hasClaim, isDecidedAgainst, tagOf, type Workers } from './taskSnapshot'

/**
 * The sections of the Tasks tab (docs/task-tracker-implementation.md §8): Now (problems,
 * active, blocked), Planned and Backlog by rank, Project (claims grouped by tag) and
 * Decided against. Tasks in history are left out; the tab finds them by search.
 * A pure function over what `TaskService.board` gathers.
 */

export interface BoardInput {
  exists: boolean
  entries: TaskListEntry[]
  problems: string[]
  workers: Workers
}

function firstLine(text: string | null): string | null {
  if (text === null) return null
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
}

function item(task: TaskFile, revision: string, workers: Workers): TaskBoardItem {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    rank: task.rank,
    tags: task.tags,
    label: task.label,
    claimFirstLine: firstLine(task.claim),
    reason: task.reason,
    decidedAgainst: task.decidedAgainst,
    reopened: task.reopened,
    unverified: task.claim !== null && task.confirmed === null,
    workers: workers.get(task.id) ?? [],
    revision
  }
}

const byId = (a: TaskFile, b: TaskFile): number => a.id.localeCompare(b.id)
const byName = (a: TaskFile, b: TaskFile): number => (a.label ?? a.title).localeCompare(b.label ?? b.title)

export function taskBoard(input: BoardInput): TaskBoard {
  const revisions = new Map<string, string>()
  const tasks: TaskFile[] = []
  for (const entry of input.entries) {
    if (!entry.task || entry.task.history || entry.revision === null) continue
    tasks.push(entry.task)
    revisions.set(entry.task.id, entry.revision)
  }
  const items = (list: TaskFile[]): TaskBoardItem[] => list.map((task) => item(task, revisions.get(task.id)!, input.workers))
  const withStatus = (status: TaskFile['status']): TaskFile[] => tasks.filter((task) => task.status === status)

  const groups = new Map<string, TaskFile[]>()
  for (const task of tasks.filter(hasClaim)) groups.set(tagOf(task), [...(groups.get(tagOf(task)) ?? []), task])
  const untagged = (tag: string): boolean => tag.startsWith('(')
  const project = [...groups]
    .sort(([a], [b]) => Number(untagged(a)) - Number(untagged(b)) || a.localeCompare(b))
    .map(([tag, list]) => ({ tag, items: items(list.sort(byName)) }))

  return {
    exists: input.exists,
    problems: input.problems,
    active: items(withStatus('active').sort(byId)),
    blocked: items(withStatus('blocked').sort(byId)),
    planned: items(withStatus('planned').sort(byRank)),
    backlog: items(withStatus('backlog').sort(byRank)),
    project,
    decidedAgainst: items(tasks.filter(isDecidedAgainst).sort(byName))
  }
}
