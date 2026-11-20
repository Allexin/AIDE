import { create } from 'zustand'
import { logManager } from './useLogStore'
import { ALL_FEATURES_ON, type FeatureName, type FeatureSet } from '../../../shared/features'

/**
 * The feature switches of this window's project (docs/task-tracker-implementation.md §10):
 * pipelines, plans and the task tracker. A switch that is off hides its UI; the pipeline,
 * plan and task stores read nothing for it and drop what they hold. The main process sends
 * 'features:changed' when Settings saves the switches or aide/config.json changes.
 */

interface FeatureStoreState {
  /** Null until read; nothing of a feature is loaded before its switch is known. */
  features: FeatureSet | null
  setFeatures: (features: FeatureSet) => void
}

export const useFeatureStore = create<FeatureStoreState>((set) => ({
  features: null,
  setFeatures: (features) => set({ features })
}))

/** The switches as the UI shows them: all on until read, as before there were switches. */
export function shownFeatures(state: { features: FeatureSet | null }): FeatureSet {
  return state.features ?? ALL_FEATURES_ON
}

/**
 * Whether the pipeline tab is shown: for a run when pipelines are on, for the project's
 * plans when plans are on (with pipelines off it shows the plans only).
 */
export function pipelineTabShown(features: FeatureSet, hasRunTab: boolean, hasPlans: boolean): boolean {
  return (features.pipelines && hasRunTab) || (features.plans && hasPlans)
}

/**
 * Calls `onChange` with the value of `name` once it is known and again whenever it changes.
 * Returns an unsubscribe.
 */
export function watchFeature(name: FeatureName, onChange: (on: boolean) => void): () => void {
  let last: boolean | null = null
  const check = (features: FeatureSet | null): void => {
    if (!features || features[name] === last) return
    last = features[name]
    onChange(last)
  }
  check(useFeatureStore.getState().features)
  return useFeatureStore.subscribe((state) => check(state.features))
}

/** Subscribe to the main process; call once per editor window. Returns an unsubscribe. */
export function connectFeatureStore(): () => void {
  // A change can arrive while a read is in flight: only the latest read is applied.
  let latest = 0
  const load = (): void => {
    const request = ++latest
    window.editorApi.featuresGet()
      .then((features) => { if (request === latest) useFeatureStore.getState().setFeatures(features) })
      .catch((err: unknown) => {
        logManager.append('AIDE', `Could not read the feature switches: ${err instanceof Error ? err.message : String(err)}`)
        // The built-in default, so the views do not wait for ever.
        if (request === latest && !useFeatureStore.getState().features) useFeatureStore.getState().setFeatures(ALL_FEATURES_ON)
      })
  }
  load()
  return window.editorApi.onFeaturesChanged(load)
}
