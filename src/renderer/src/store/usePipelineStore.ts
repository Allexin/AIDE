import { create } from 'zustand'

/**
 * State of the project's active pipeline run for the overlay and the banner.
 * The main process pushes snapshots on every run state change and transcript
 * entries as agents stream them.
 */

export interface VisitRef { node: string; visit: number }

interface PipelineState {
  run: PipelineRunSnapshot | null
  expanded: boolean
  /** A finished run the user closed; the overlay stays hidden for it. */
  dismissedRunId: string | null
  /** Explicitly selected visit; null follows the current node. */
  selected: VisitRef | null
  /** Live transcript entries per `runId:node:visit`. */
  live: Record<string, HistoryEntry[]>
  setRun: (run: PipelineRunSnapshot | null) => void
  appendLive: (runId: string, node: string, visit: number, entry: HistoryEntry) => void
  setExpanded: (expanded: boolean) => void
  select: (ref: VisitRef | null) => void
  dismiss: () => void
}

export const liveKey = (runId: string, node: string, visit: number): string => `${runId}:${node}:${visit}`

export function isRunActive(status: PipelineRunStatus): boolean {
  return status !== 'finished' && status !== 'failed'
}

export const usePipelineStore = create<PipelineState>((set) => ({
  run: null,
  expanded: true,
  dismissedRunId: null,
  selected: null,
  live: {},
  setRun: (run) => set((state) => {
    const newRun = run !== null && run.runId !== state.run?.runId
    return {
      run,
      // A new run opens expanded and follows the current node.
      ...(newRun ? { expanded: true, selected: null, live: {} } : {})
    }
  }),
  appendLive: (runId, node, visit, entry) => set((state) => {
    const key = liveKey(runId, node, visit)
    return { live: { ...state.live, [key]: [...(state.live[key] ?? []), entry] } }
  }),
  setExpanded: (expanded) => set({ expanded }),
  select: (selected) => set({ selected }),
  dismiss: () => set((state) => ({ dismissedRunId: state.run?.runId ?? null }))
}))

/** Subscribe to the main process; call once per editor window. Returns an unsubscribe. */
export function connectPipelineStore(): () => void {
  void window.editorApi.pipelineGetRun().then((run) => usePipelineStore.getState().setRun(run))
  const offState = window.editorApi.onPipelineRunState((run) => usePipelineStore.getState().setRun(run))
  const offTranscript = window.editorApi.onPipelineTranscript(({ runId, node, visit, entry }) => usePipelineStore.getState().appendLive(runId, node, visit, entry))
  return () => { offState(); offTranscript() }
}
