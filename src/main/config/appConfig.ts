import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface EditorConfig {
  fontFamily: string
  fontSize: number
  minimap: boolean
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded'
  lineNumbers: 'on' | 'off' | 'relative' | 'interval'
  tabSize: number
}

export interface AppConfig {
  recentProjects: string[]
  maxRecentProjects: number
  maxSessionsInPicker: number
  editor: EditorConfig
  maxFileSizeMb: number
}

const DEFAULTS: AppConfig = {
  recentProjects: [],
  maxRecentProjects: 10,
  maxSessionsInPicker: 20,
  editor: {
    fontFamily: 'Consolas, monospace',
    fontSize: 14,
    minimap: false,
    wordWrap: 'off',
    lineNumbers: 'on',
    tabSize: 2
  },
  maxFileSizeMb: 5
}

let config: AppConfig = structuredClone(DEFAULTS)
let configPath = ''

export function initAppConfig(): void {
  configPath = join(app.getPath('userData'), 'aide-config.json')

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      config = {
        ...DEFAULTS,
        ...parsed,
        editor: { ...DEFAULTS.editor, ...(parsed.editor ?? {}) }
      }
    } catch {
      config = structuredClone(DEFAULTS)
    }
  }
}

export function getAppConfig(): AppConfig {
  return config
}

export function updateAppConfig(partial: Partial<AppConfig>): void {
  config = { ...config, ...partial }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

export function addRecentProject(projectPath: string): void {
  const recentProjects = [
    projectPath,
    ...config.recentProjects.filter(p => p !== projectPath)
  ].slice(0, config.maxRecentProjects)

  updateAppConfig({ recentProjects })
}
