import { describe, expect, it } from 'vitest'
import { pipelineTabShown, shownFeatures, useFeatureStore, watchFeature } from './useFeatureStore'
import { ALL_FEATURES_ON } from '../../../shared/features'

describe('feature store', () => {
  it('shows everything until the switches are read', () => {
    expect(shownFeatures({ features: null })).toEqual(ALL_FEATURES_ON)
  })

  it('the pipeline tab: a run with pipelines on, plans with plans on', () => {
    expect(pipelineTabShown(ALL_FEATURES_ON, true, false)).toBe(true)
    expect(pipelineTabShown(ALL_FEATURES_ON, false, true)).toBe(true)
    expect(pipelineTabShown({ ...ALL_FEATURES_ON, pipelines: false }, true, false)).toBe(false)
    expect(pipelineTabShown({ ...ALL_FEATURES_ON, pipelines: false }, true, true)).toBe(true)
    expect(pipelineTabShown({ ...ALL_FEATURES_ON, plans: false }, false, true)).toBe(false)
    expect(pipelineTabShown({ ...ALL_FEATURES_ON, pipelines: false, plans: false }, true, true)).toBe(false)
  })

  it('a watcher hears a switch once it is known and each time it changes', () => {
    useFeatureStore.setState({ features: null })
    const heard: boolean[] = []
    const stop = watchFeature('tracker', (on) => heard.push(on))
    expect(heard).toEqual([])
    useFeatureStore.getState().setFeatures(ALL_FEATURES_ON)
    useFeatureStore.getState().setFeatures({ ...ALL_FEATURES_ON, plans: false })
    useFeatureStore.getState().setFeatures({ ...ALL_FEATURES_ON, tracker: false })
    stop()
    useFeatureStore.getState().setFeatures(ALL_FEATURES_ON)
    expect(heard).toEqual([true, false])
  })
})
