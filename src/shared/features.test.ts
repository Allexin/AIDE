import { describe, expect, it } from 'vitest'
import { ALL_FEATURES_ON, FEATURE_NAMES, describeFeatureValue, featureOffText, parseFeatureLayer, resolveFeature, resolveFeatures, toolFeature, withFeatureChoice, type FeatureLayers, type FeatureName } from './features'

describe('feature switches: layers', () => {
  it('with no features anywhere every switch is on, from the built-in default', () => {
    expect(resolveFeatures({})).toEqual(ALL_FEATURES_ON)
    expect(resolveFeatures({ global: undefined, project: {}, personal: null })).toEqual(ALL_FEATURES_ON)
    for (const name of FEATURE_NAMES) expect(resolveFeature({}, name)).toEqual({ on: true, source: 'default' })
  })

  it('the last layer that sets a switch wins: default -> global -> project -> personal', () => {
    const values = [undefined, true, false] as const
    for (const name of FEATURE_NAMES) {
      for (const global of values) for (const project of values) for (const personal of values) {
        const layers: FeatureLayers = {
          global: global === undefined ? {} : { [name]: global },
          project: project === undefined ? {} : { [name]: project },
          personal: personal === undefined ? {} : { [name]: personal }
        }
        const expected = personal ?? project ?? global ?? true
        const source = personal !== undefined ? 'personal' : project !== undefined ? 'project' : global !== undefined ? 'global' : 'default'
        expect(resolveFeature(layers, name), `${name} ${String(global)}/${String(project)}/${String(personal)}`).toEqual({ on: expected, source })
        expect(resolveFeatures(layers)[name]).toBe(expected)
        // Other switches are not touched by this one.
        for (const other of FEATURE_NAMES.filter((n) => n !== name)) expect(resolveFeatures(layers)[other]).toBe(true)
      }
    }
  })

  it('switches of different layers combine', () => {
    const layers = { global: { pipelines: false, tracker: false }, project: { plans: false, tracker: true }, personal: { pipelines: true } }
    expect(resolveFeatures(layers)).toEqual({ pipelines: true, plans: false, tracker: true })
    expect(resolveFeature(layers, 'tracker')).toEqual({ on: true, source: 'project' })
  })

  it('the inherited value stops at a layer', () => {
    const layers = { global: { plans: false }, project: { plans: true }, personal: { plans: false } }
    expect(resolveFeature(layers, 'plans', 'global')).toEqual({ on: false, source: 'global' })
    expect(resolveFeature(layers, 'plans', 'project')).toEqual({ on: true, source: 'project' })
    expect(describeFeatureValue(resolveFeature(layers, 'plans', 'project'))).toBe('on — project config')
    expect(describeFeatureValue(resolveFeature({}, 'plans'))).toBe('on — built-in default')
    expect(describeFeatureValue(resolveFeature(layers, 'plans', 'global'))).toBe('off — global')
  })

  it('a missing section, an unknown key or a value that is not a boolean sets nothing', () => {
    expect(parseFeatureLayer(undefined)).toEqual({})
    expect(parseFeatureLayer('off')).toEqual({})
    expect(parseFeatureLayer([false])).toEqual({})
    expect(parseFeatureLayer({ pipelines: 'false', plans: 0, tracker: null, other: false })).toEqual({})
    expect(parseFeatureLayer({ pipelines: false, tracker: true })).toEqual({ pipelines: false, tracker: true })
    expect(resolveFeatures({ global: { pipelines: 'off' } })).toEqual(ALL_FEATURES_ON)
  })
})

describe('feature switches: helpers', () => {
  it('a choice of Default removes the key; On and Off set it', () => {
    expect(withFeatureChoice({ plans: false }, 'plans', 'default')).toEqual({})
    expect(withFeatureChoice({}, 'tracker', 'off')).toEqual({ tracker: false })
    expect(withFeatureChoice({ tracker: false }, 'tracker', 'on')).toEqual({ tracker: true })
  })

  it('tools belong to a switch by name prefix; other tools to none', () => {
    const expected: Array<[string, FeatureName | null]> = [['pipeline_hello', 'pipelines'], ['plan_run', 'plans'], ['task_snapshot', 'tracker'], ['toolbar_guide', null]]
    for (const [tool, feature] of expected) expect(toolFeature(tool)).toBe(feature)
  })

  it('says a feature is turned off in Settings', () => {
    for (const name of FEATURE_NAMES) expect(featureOffText(name)).toContain('turned off in Settings')
    expect(featureOffText('tracker')).toBe('The task tracker is turned off in Settings.')
  })
})
