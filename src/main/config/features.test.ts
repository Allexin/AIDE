import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ALL_FEATURES_ON, type FeatureLayer } from '../../shared/features'
import { featureRefusal, featureSaveRefusal, projectFeatures, readFeatureLayers, requireFeature, switchedOff, writeGlobalFeatures, writePersonalFeatures } from './features'
import { ensureAideDirectory } from './projectConfig'
import { getProjectUserPath } from './projectUserData'

const app = vi.hoisted(() => ({ features: {} as FeatureLayer }))
vi.mock('./appConfig', () => ({
  getAppConfig: () => ({ features: app.features }),
  updateAppConfig: (partial: { features?: FeatureLayer }) => { if (partial.features) app.features = partial.features }
}))


const root = mkdtempSync(join(tmpdir(), 'aide-features-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let counter = 0

function project(): string {
  const dir = join(root, `p${++counter}`)
  mkdirSync(join(dir, 'aide'), { recursive: true })
  ensureAideDirectory(dir)
  return dir
}

const setProjectConfig = (dir: string, config: unknown): void => writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify(config))
const settingsFile = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(getProjectUserPath(dir, 'settings.json'), 'utf8')) as Record<string, unknown>

beforeEach(() => { app.features = {} })

describe('feature switches of a project', () => {
  it('with no features anywhere (no config files at all) everything is on and nothing is refused', () => {
    const dir = project()
    expect(projectFeatures(dir)).toEqual(ALL_FEATURES_ON)
    expect(featureRefusal(dir, 'tracker')).toBeNull()
    expect(() => requireFeature(dir, 'pipelines')).not.toThrow()
    // A config.json with other sections (git) sets no switch either.
    setProjectConfig(dir, { git: { commits: false } })
    expect(projectFeatures(dir)).toEqual(ALL_FEATURES_ON)
  })

  it('reads global -> project -> personal, the last that sets a switch wins', () => {
    const dir = project()
    app.features = { pipelines: false, plans: false, tracker: false, agents: false }
    expect(projectFeatures(dir)).toEqual({ pipelines: false, plans: false, tracker: false, agents: false })
    setProjectConfig(dir, { git: {}, features: { plans: true, tracker: true } })
    expect(projectFeatures(dir)).toEqual({ pipelines: false, plans: true, tracker: true, agents: false })
    writePersonalFeatures(dir, { tracker: false, pipelines: true, agents: true })
    expect(projectFeatures(dir)).toEqual({ pipelines: true, plans: true, tracker: false, agents: true })
  })

  it('a features section put into aide/config.json by hand takes effect at the next reading', () => {
    const dir = project()
    expect(projectFeatures(dir).tracker).toBe(true)
    setProjectConfig(dir, { features: { tracker: false } })
    expect(projectFeatures(dir).tracker).toBe(false)
    expect(featureRefusal(dir, 'tracker')).toBe('The task tracker is turned off in Settings.')
    expect(() => requireFeature(dir, 'tracker')).toThrow('turned off in Settings')
  })

  it('two projects resolve independently; the global layer reaches both', () => {
    const a = project()
    const b = project()
    writePersonalFeatures(a, { pipelines: false })
    setProjectConfig(a, { features: { plans: false } })
    expect(projectFeatures(a)).toEqual({ pipelines: false, plans: false, tracker: true, agents: true })
    expect(projectFeatures(b)).toEqual(ALL_FEATURES_ON)
    writeGlobalFeatures({ tracker: false })
    expect(projectFeatures(a).tracker).toBe(false)
    expect(projectFeatures(b).tracker).toBe(false)
  })

  it('the personal layer keeps the other settings, and a layer that sets nothing removes the key', () => {
    const dir = project()
    writePersonalFeatures(dir, { plans: false })
    expect(settingsFile(dir).features).toEqual({ plans: false })
    expect(settingsFile(dir).activePanelRatio).toBe(0.75)
    writePersonalFeatures(dir, {})
    expect('features' in settingsFile(dir)).toBe(false)
    expect(readFeatureLayers(dir).personal).toBeUndefined()
  })

  it('turning a switch off writes nothing on disk of its feature', () => {
    const dir = project()
    mkdirSync(join(dir, 'aide', 'tasks'), { recursive: true })
    writeFileSync(join(dir, 'aide', 'tasks', 'x.md'), 'task')
    writePersonalFeatures(dir, { tracker: false, plans: false, pipelines: false })
    expect(existsSync(join(dir, 'aide', 'tasks', 'x.md'))).toBe(true)
  })
})

describe('saving the switches', () => {
  it('lists the switches a change turns off', () => {
    expect(switchedOff(ALL_FEATURES_ON, { pipelines: false, plans: true, tracker: false, agents: true })).toEqual(['pipelines', 'tracker'])
    expect(switchedOff({ pipelines: false, plans: true, tracker: true, agents: true }, ALL_FEATURES_ON)).toEqual([])
  })

  it('refuses turning a switch off where it is busy, in any open project the change reaches', () => {
    const a = project()
    const b = project()
    const busy = (dir: string, feature: string): string | null => dir === b && feature === 'pipelines' ? 'run r1 is running' : null
    // Global off reaches b, where a run works.
    expect(featureSaveRefusal([a, b], { pipelines: false }, null, readFeatureLayers, busy)).toBe('run r1 is running')
    // b keeps pipelines on by its own config: the global change does not reach it.
    setProjectConfig(b, { features: { pipelines: true } })
    expect(featureSaveRefusal([a, b], { pipelines: false }, null, readFeatureLayers, busy)).toBeNull()
    // The personal layer of b turns them off there.
    expect(featureSaveRefusal([a, b], {}, { projectPath: b, layer: { pipelines: false } }, readFeatureLayers, busy)).toBe('run r1 is running')
    // A personal change in a reaches only a.
    expect(featureSaveRefusal([a, b], {}, { projectPath: a, layer: { pipelines: false } }, readFeatureLayers, busy)).toBeNull()
    // Turning other switches off is not refused.
    expect(featureSaveRefusal([a, b], { tracker: false }, null, readFeatureLayers, busy)).toBeNull()
  })
})
