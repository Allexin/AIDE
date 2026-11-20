import { create } from 'zustand'
import { logManager } from './useLogStore'

/**
 * The task tracker as the editor window shows it. For now the current task of each
 * terminal tab (docs/task-tracker-implementation.md §6); the main process sends
 * 'tasks:changed' after every tracker or binding change and the store reads again.
 */

export interface TabTask {
  id: string
  title: string
}

interface TaskStoreState {
  /** The current task of each terminal tab of this window, by tab id. */
  tabTasks: Record<string, TabTask>
  setTabTasks: (tabTasks: Record<string, TabTask>) => void
}

export const useTaskStore = create<TaskStoreState>((set) => ({
  tabTasks: {},
  setTabTasks: (tabTasks) => set({ tabTasks })
}))

/** The label after a tab title: "· <task title>", cut to 30 characters. */
export function tabTaskLabel(task: TabTask | undefined): string | null {
  if (!task) return null
  const title = task.title.length > 30 ? `${task.title.slice(0, 29)}…` : task.title
  return `· ${title}`
}

/** Subscribe to the main process; call once per editor window. Returns an unsubscribe. */
export function connectTaskStore(): () => void {
  // Changes can arrive while a read is in flight: only the latest read is applied.
  let latest = 0
  const load = (): void => {
    const request = ++latest
    window.editorApi.tasksTabTasks()
      .then((tabTasks) => { if (request === latest) useTaskStore.getState().setTabTasks(tabTasks) })
      .catch((err: unknown) => logManager.append('Tasks', `Could not read the tasks of the terminal tabs: ${err instanceof Error ? err.message : String(err)}`))
  }
  load()
  return window.editorApi.onTasksChanged(load)
}
