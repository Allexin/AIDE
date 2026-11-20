/**
 * Feature switches (docs/task-tracker-implementation.md §10): pipelines, plans and the
 * task tracker can each be turned off. The value of a switch for a project is the last
 * layer that sets it, in this order:
 *
 *   1. built-in default: on
 *   2. global: `features` in the user's app config (Settings, all projects)
 *   3. project: `features` in the project's shared `aide/config.json` (no UI; by hand)
 *   4. personal: `features` in `.aide/users/<user>/settings.json` (Settings, this project)
 *
 * A missing file, section or key, or a value that is not a boolean, sets nothing at that
 * layer. Pure functions, shared by the main process and the Settings window.
 */

export type FeatureName = 'pipelines' | 'plans' | 'tracker'

export const FEATURE_NAMES: readonly FeatureName[] = ['pipelines', 'plans', 'tracker']

/** What one layer sets: a key per switch it sets. */
export type FeatureLayer = Partial<Record<FeatureName, boolean>>

/** The effective value of every switch. */
export type FeatureSet = Record<FeatureName, boolean>

export type FeatureSource = 'default' | 'global' | 'project' | 'personal'

/** The raw `features` sections of the layers above the default, as read from their files. */
export interface FeatureLayers {
  global?: unknown
  project?: unknown
  personal?: unknown
}

export interface FeatureValue {
  on: boolean
  source: FeatureSource
}

/** What the Settings window edits: the global layer, and the layers of the project whose window opened it. */
export interface FeatureSettings {
  global: FeatureLayer
  /** `config`: the project layer from aide/config.json (read only); `personal`: this user's layer. */
  project: { path: string; config: FeatureLayer; personal: FeatureLayer } | null
}

export const ALL_FEATURES_ON: FeatureSet = Object.freeze({ pipelines: true, plans: true, tracker: true })

export const FEATURE_LABEL: Record<FeatureName, string> = { pipelines: 'Pipelines', plans: 'Plans', tracker: 'Task tracker' }

const SOURCE_LABEL: Record<FeatureSource, string> = { default: 'built-in default', global: 'global', project: 'project config', personal: 'personal' }

/** The switches a `features` section sets; anything else in it is ignored. */
export function parseFeatureLayer(raw: unknown): FeatureLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const layer: FeatureLayer = {}
  for (const name of FEATURE_NAMES) {
    const value = (raw as Record<string, unknown>)[name]
    if (typeof value === 'boolean') layer[name] = value
  }
  return layer
}

const ORDER: Array<Exclude<FeatureSource, 'default'>> = ['global', 'project', 'personal']

/** The value of one switch: the last layer that sets it, up to and including `upTo`. */
export function resolveFeature(layers: FeatureLayers, name: FeatureName, upTo: Exclude<FeatureSource, 'default'> = 'personal'): FeatureValue {
  let value: FeatureValue = { on: true, source: 'default' }
  for (const source of ORDER) {
    const set = parseFeatureLayer(layers[source])[name]
    if (set !== undefined) value = { on: set, source }
    if (source === upTo) break
  }
  return value
}

export function resolveFeatures(layers: FeatureLayers): FeatureSet {
  return { pipelines: resolveFeature(layers, 'pipelines').on, plans: resolveFeature(layers, 'plans').on, tracker: resolveFeature(layers, 'tracker').on }
}

/** "on — built-in default", "off — project config": a value and the layer it comes from. */
export function describeFeatureValue(value: FeatureValue): string {
  return `${value.on ? 'on' : 'off'} — ${SOURCE_LABEL[value.source]}`
}

/** `layer` with `name` set to `choice`; 'default' removes the key, so the layer sets nothing for it. */
export function withFeatureChoice(layer: FeatureLayer, name: FeatureName, choice: 'default' | 'on' | 'off'): FeatureLayer {
  const next: FeatureLayer = { ...parseFeatureLayer(layer) }
  if (choice === 'default') delete next[name]
  else next[name] = choice === 'on'
  return next
}

/** What a handler of a switched-off feature answers instead of acting. */
export function featureOffText(name: FeatureName): string {
  return name === 'tracker' ? 'The task tracker is turned off in Settings.' : `${FEATURE_LABEL[name]} are turned off in Settings.`
}

/** Why plan_run (and "Run plan") is unavailable while pipelines are off. */
export const PLAN_RUN_OFF_TEXT = 'The plan autopilot is unavailable: plans run through pipelines, which are turned off in Settings. The other plan tools work.'

/** MCP tools that belong to a switch, by name prefix; other tools (toolbar_guide) have none. */
export function toolFeature(toolName: string): FeatureName | null {
  if (toolName.startsWith('pipeline_')) return 'pipelines'
  if (toolName.startsWith('plan_')) return 'plans'
  if (toolName.startsWith('task_')) return 'tracker'
  return null
}
