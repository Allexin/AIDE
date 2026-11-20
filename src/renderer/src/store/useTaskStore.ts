import { create } from 'zustand'
import { logManager } from './useLogStore'
import { usePipelineStore } from './usePipelineStore'
import { watchFeature } from './useFeatureStore'
import type { TaskBoard } from '../../../shared/task'

/**
 * The task tracker as the editor window shows it: the current task of each terminal tab
 * (docs/task-tracker-implementation.md §6) and the sections of the Tasks tab (§8). The
 * main process sends 'tasks:changed' when what a view shows changed (a write, a change
 * made through MCP, a hand edit in aide/tasks/), and the store reads again.
 */

export interface TabTask {
  id: string
  title: string
}

interface TaskStoreState {
  /** The current task of each terminal tab of this window, by tab id. */
  tabTasks: Record<string, TabTask>
  /** The sections of the Tasks tab; null until read. */
  board: TaskBoard | null
  /** Why the last reading of the sections failed; null after one that worked. */
  boardError: string | null
  /** Counts the changes heard of, so an open card or search reads again. */
  version: number
  /** The Tasks tab is the selected tab of the terminal panel (the session tabs keep their own selection). */
  viewActive: boolean
  /** The task shown in the card. */
  selectedId: string | null
  setTabTasks: (tabTasks: Record<string, TabTask>) => void
  setBoard: (board: TaskBoard | null) => void
  changed: () => void
  setViewActive: (active: boolean) => void
  select: (id: string | null) => void
}

export const useTaskStore = create<TaskStoreState>((set) => ({
  tabTasks: {},
  board: null,
  boardError: null,
  version: 0,
  viewActive: false,
  selectedId: null,
  setTabTasks: (tabTasks) => set({ tabTasks }),
  setBoard: (board) => set({ board }),
  changed: () => set((state) => ({ version: state.version + 1 })),
  setViewActive: (viewActive) => {
    // One tab of the strip is selected: the Tasks tab leaves the pipeline tab.
    if (viewActive) usePipelineStore.getState().setViewActive(false)
    set({ viewActive })
  },
  select: (selectedId) => set({ selectedId })
}))

/** Whether the Tasks tab is shown: the project has `aide/tasks/`, as the pipeline tab shows with a plan or a run. */
export function hasTasksTab(state: { board: TaskBoard | null }): boolean {
  return state.board?.exists ?? false
}

/** The label after a tab title: "· <task title>", cut to 30 characters. */
export function tabTaskLabel(task: TabTask | undefined): string | null {
  if (!task) return null
  const title = task.title.length > 30 ? `${task.title.slice(0, 29)}…` : task.title
  return `· ${title}`
}

function failed(what: string, err: unknown): string {
  const text = `Could not read ${what}: ${err instanceof Error ? err.message : String(err)}`
  logManager.append('Tasks', text)
  return text
}

/**
 * Subscribe to the main process; call once per editor window. Returns an unsubscribe.
 * With the tracker turned off in Settings the store holds nothing (no Tasks tab, no task
 * labels on terminal tabs) and reads nothing; aide/tasks/ stays as it is.
 */
export function connectTaskStore(): () => void {
  // Changes can arrive while a read is in flight: only the latest read is applied.
  let latest = 0
  let on = false
  const load = (): void => {
    if (!on) return
    const request = ++latest
    window.editorApi.tasksTabTasks()
      .then((tabTasks) => { if (request === latest) useTaskStore.getState().setTabTasks(tabTasks) })
      .catch((err: unknown) => failed('the tasks of the terminal tabs', err))
    window.editorApi.tasksList()
      .then((board) => { if (request === latest) useTaskStore.setState({ board, boardError: null }) })
      .catch((err: unknown) => {
        const text = failed('the task tracker', err)
        if (request === latest) useTaskStore.setState({ boardError: text })
      })
  }
  const offFeature = watchFeature('tracker', (enabled) => {
    on = enabled
    if (enabled) {
      load()
      return
    }
    latest++
    useTaskStore.setState({ tabTasks: {}, board: null, boardError: null, viewActive: false, selectedId: null })
  })
  const offChanged = window.editorApi.onTasksChanged(() => {
    if (!on) return
    useTaskStore.getState().changed()
    load()
  })
  return () => { offFeature(); offChanged() }
}
