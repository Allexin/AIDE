import { create } from 'zustand'
import { logManager } from './useLogStore'
import { shownFeatures, useFeatureStore, watchFeature } from './useFeatureStore'

/**
 * State of the project's active pipeline run for the pipeline tab and the banner.
 * The main process pushes snapshots on every run state change and transcript
 * entries as agents stream them.
 */

export interface VisitRef { node: string; visit: number }

interface PipelineState {
  run: PipelineRunSnapshot | null
  /** The pipeline tab is the selected tab of the terminal panel (the session tabs keep their own selection). */
  viewActive: boolean
  /** The run whose tab the user has opened; a new run's tab blinks until then. */
  seenRunId: string | null
  /** A finished run the user closed; its tab stays hidden. */
  dismissedRunId: string | null
  /** Explicitly selected visit; null follows the current node. */
  selected: VisitRef | null
  /** Live transcript entries per `runId:node:visit`. */
  live: Record<string, HistoryEntry[]>
  setRun: (run: PipelineRunSnapshot | null) => void
  appendLive: (runId: string, node: string, visit: number, entry: HistoryEntry) => void
  setViewActive: (active: boolean) => void
  select: (ref: VisitRef | null) => void
  dismiss: () => void
}

export const liveKey = (runId: string, node: string, visit: number): string => `${runId}:${node}:${visit}`

export function isRunActive(status: PipelineRunStatus): boolean {
  return status !== 'finished' && status !== 'failed'
}

/** Whether the pipeline tab is shown at all. */
export function hasPipelineTab(state: { run: PipelineRunSnapshot | null; dismissedRunId: string | null }): boolean {
  return state.run !== null && state.run.runId !== state.dismissedRunId
}

export const usePipelineStore = create<PipelineState>((set) => ({
  run: null,
  viewActive: false,
  seenRunId: null,
  dismissedRunId: null,
  selected: null,
  live: {},
  setRun: (run) => set((state) => {
    const newRun = run !== null && run.runId !== state.run?.runId
    return {
      run,
      // A new run follows the current step; its tab appears (blinking) without taking over the terminal.
      ...(newRun ? { selected: null, live: {} } : {})
    }
  }),
  appendLive: (runId, node, visit, entry) => set((state) => {
    const key = liveKey(runId, node, visit)
    return { live: { ...state.live, [key]: [...(state.live[key] ?? []), entry] } }
  }),
  setViewActive: (viewActive) => set((state) => ({ viewActive, ...(viewActive && state.run ? { seenRunId: state.run.runId } : {}) })),
  select: (selected) => set({ selected }),
  dismiss: () => set((state) => ({ dismissedRunId: state.run?.runId ?? null, viewActive: false }))
}))

/**
 * Subscribe to the main process; call once per editor window. Returns an unsubscribe.
 * With pipelines turned off in Settings the store holds no run and reads nothing.
 */
export function connectPipelineStore(): () => void {
  let on = false
  const offFeature = watchFeature('pipelines', (enabled) => {
    on = enabled
    if (!enabled) {
      // With plans on the tab stays, showing the plans: the user is not moved off it.
      usePipelineStore.setState((state) => ({ run: null, viewActive: state.viewActive && shownFeatures(useFeatureStore.getState()).plans, selected: null, live: {} }))
      return
    }
    window.editorApi.pipelineGetRun()
      .then((run) => { if (on) usePipelineStore.getState().setRun(run) })
      .catch((err: unknown) => logManager.append('Pipeline', `Could not read the pipeline run: ${err instanceof Error ? err.message : String(err)}`))
  })
  const offState = window.editorApi.onPipelineRunState((run) => { if (on) usePipelineStore.getState().setRun(run) })
  const offTranscript = window.editorApi.onPipelineTranscript(({ runId, node, visit, entry }) => { if (on) usePipelineStore.getState().appendLive(runId, node, visit, entry) })
  return () => { offFeature(); offState(); offTranscript() }
}
