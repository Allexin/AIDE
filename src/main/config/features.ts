import { getAppConfig, updateAppConfig } from './appConfig'
import { readProjectSettings, readSharedConfig, writeProjectSettings } from './projectConfig'
import { featureOffText, parseFeatureLayer, resolveFeatures, type FeatureLayer, type FeatureLayers, type FeatureName, type FeatureSet } from '../../shared/features'

/**
 * The feature switches of a project as the main process reads them (layer order in
 * src/shared/features.ts). Every layer is read from its file on each call, as the `git`
 * section of aide/config.json is: a `features` section put into that file by hand takes
 * effect without a restart, and a change of the global layer reaches every open project.
 */

export function readFeatureLayers(projectPath: string): FeatureLayers {
  return {
    global: getAppConfig().features,
    // aide/config.json may hold any JSON, `null` included.
    project: (readSharedConfig(projectPath) as Record<string, unknown> | null)?.features,
    personal: readProjectSettings(projectPath).features
  }
}

export function projectFeatures(projectPath: string): FeatureSet {
  return resolveFeatures(readFeatureLayers(projectPath))
}

export function featureEnabled(projectPath: string, name: FeatureName): boolean {
  return projectFeatures(projectPath)[name]
}

/** Null when the feature is on, else the text a handler answers instead of acting. */
export function featureRefusal(projectPath: string, name: FeatureName): string | null {
  return featureEnabled(projectPath, name) ? null : featureOffText(name)
}

/** Throws the "turned off in Settings" error when the feature is off. */
export function requireFeature(projectPath: string, name: FeatureName): void {
  const refusal = featureRefusal(projectPath, name)
  if (refusal) throw new Error(refusal)
}

export function writeGlobalFeatures(layer: FeatureLayer): void {
  updateAppConfig({ features: parseFeatureLayer(layer) })
}

/** The personal layer; a layer that sets nothing removes the `features` key from the file. */
export function writePersonalFeatures(projectPath: string, layer: FeatureLayer): void {
  const settings = readProjectSettings(projectPath)
  const features = parseFeatureLayer(layer)
  if (Object.keys(features).length) settings.features = features
  else delete settings.features
  writeProjectSettings(projectPath, settings)
}

/** The switches a change of layers turns off: on before, off after. */
export function switchedOff(before: FeatureSet, after: FeatureSet): FeatureName[] {
  return (Object.keys(before) as FeatureName[]).filter((name) => before[name] && !after[name])
}

/**
 * Why saving the global layer (and the personal layer of `personal.projectPath`) is refused,
 * or null: a switch it turns off in an open project is busy there (`busy`, e.g. a run working
 * while pipelines go off). The global layer reaches every open project that does not set the
 * switch itself, so each is checked with its own layers.
 */
export function featureSaveRefusal(
  projects: string[],
  global: FeatureLayer,
  personal: { projectPath: string; layer: FeatureLayer } | null,
  readLayers: (projectPath: string) => FeatureLayers,
  busy: (projectPath: string, feature: FeatureName) => string | null
): string | null {
  for (const projectPath of projects) {
    const layers = readLayers(projectPath)
    const after: FeatureLayers = { ...layers, global, ...(personal && personal.projectPath === projectPath ? { personal: personal.layer } : {}) }
    for (const feature of switchedOff(resolveFeatures(layers), resolveFeatures(after))) {
      const reason = busy(projectPath, feature)
      if (reason) return reason
    }
  }
  return null
}
