import { create } from 'zustand'
import { logManager } from './useLogStore'
import { watchFeature } from './useFeatureStore'
import type { PlanSnapshot } from '../../../shared/plan'

/**
 * The project's plans for the pipeline tab, where the plan is the parent of the
 * pipeline, and for the status bar. The main process pushes a snapshot whenever a
 * plan, the autopilot or the run changes.
 */

/** What the pipeline tab shows next to the plan; null follows the current run. */
export type PlanDetail =
  | { kind: 'run'; runId: string }
  | { kind: 'decision'; planId: string; number: number }
  | null

interface PlanStoreState {
  snapshot: PlanSnapshot | null
  detail: PlanDetail
  /** When the attention the user has seen was raised; a newer one blinks the tab. */
  seenAttentionAt: string | null
  setSnapshot: (snapshot: PlanSnapshot | null) => void
  showDetail: (detail: PlanDetail) => void
  markSeen: () => void
}

export const usePlanStore = create<PlanStoreState>((set) => ({
  snapshot: null,
  detail: null,
  seenAttentionAt: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  showDetail: (detail) => set({ detail }),
  markSeen: () => set((state) => ({ seenAttentionAt: state.snapshot?.autopilot?.attention?.at ?? state.seenAttentionAt }))
}))

/** Whether the project has plans, so the pipeline tab is there even with no run. */
export function hasPlans(state: { snapshot: PlanSnapshot | null }): boolean {
  return (state.snapshot?.plans.length ?? 0) > 0
}

/**
 * Subscribe to the main process; call once per editor window. Returns an unsubscribe.
 * With plans turned off in Settings the store holds no plans and reads nothing.
 */
export function connectPlanStore(): () => void {
  let on = false
  const offFeature = watchFeature('plans', (enabled) => {
    on = enabled
    if (!enabled) {
      usePlanStore.setState({ snapshot: null, detail: null })
      return
    }
    window.editorApi.planGet()
      .then((snapshot) => { if (on) usePlanStore.getState().setSnapshot(snapshot) })
      .catch((err: unknown) => logManager.append('Pipeline', `Could not read the plans: ${err instanceof Error ? err.message : String(err)}`))
  })
  const offSnapshot = window.editorApi.onPlanSnapshot((snapshot) => { if (on) usePlanStore.getState().setSnapshot(snapshot) })
  return () => { offFeature(); offSnapshot() }
}
