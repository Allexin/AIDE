import type { RunStatus } from './engine/types'
import type { FeatureName } from '../../shared/features'

/**
 * Why a feature switch cannot be turned off in a project now (docs/task-tracker-implementation.md §10),
 * or null. Only work in progress refuses it: a run that is running or pausing (its step is still
 * going), and the plan autopilot while the Orchestrator decides or its step's run works. A run that
 * is paused, stopped or waiting for an answer is kept on disk and comes back with pipelines.
 */

/** Run statuses in which a step is still being carried out. */
export const WORKING_RUN_STATUSES: readonly RunStatus[] = ['running', 'pausing']

export function runIsWorking(status: RunStatus): boolean {
  return WORKING_RUN_STATUSES.includes(status)
}

export interface BusyState {
  /** The project's current run, if any. */
  run: { runId: string; status: RunStatus } | null
  /** The plan whose autopilot is working, if any. */
  autopilotPlan: string | null
}

export function featureBusyReason(projectPath: string, feature: FeatureName, state: BusyState): string | null {
  if (feature === 'pipelines' && state.run && runIsWorking(state.run.status)) {
    return `Pipelines cannot be turned off while run ${state.run.runId} of ${projectPath} is ${state.run.status}. Pause or stop it first (a paused or stopped run is kept), or wait until it ends.`
  }
  if ((feature === 'pipelines' || feature === 'plans') && state.autopilotPlan) {
    return `${feature === 'pipelines' ? 'Pipelines' : 'Plans'} cannot be turned off while the autopilot of plan ${state.autopilotPlan} in ${projectPath} is working. Pause the plan or its run first.`
  }
  return null
}
