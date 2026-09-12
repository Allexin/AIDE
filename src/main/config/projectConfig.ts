import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { ensureProjectUserDirectory, getProjectUserPath } from './projectUserData'

export interface ProjectSettings {
  activePanelRatio: number
  collapsedWidthPx: number
  fileTreeWidth: number
  defaultToolId?: string
}

const DEFAULTS: ProjectSettings = {
  activePanelRatio: 0.75,
  collapsedWidthPx: 20,
  fileTreeWidth: 250
}

export function ensureAideDirectory(projectDir: string): void {
  mkdirSync(join(projectDir, '.aide'), { recursive: true })
  ensureProjectUserDirectory(projectDir)
}

export function readProjectSettings(projectDir: string): ProjectSettings {
  const settingsPath = getProjectUserPath(projectDir, 'settings.json')

  if (!existsSync(settingsPath)) {
    return { ...DEFAULTS }
  }

  try {
    const raw = readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ProjectSettings>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeProjectSettings(projectDir: string, settings: ProjectSettings): void {
  const settingsPath = getProjectUserPath(projectDir, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
}

export function readSharedConfig(projectDir: string): Record<string, unknown> {
  const configPath = join(projectDir, 'aide', 'config.json')

  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const raw = readFileSync(configPath, 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
