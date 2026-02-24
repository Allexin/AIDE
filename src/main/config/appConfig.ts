import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface EditorConfig {
  maxFileSizeMb: number
  fontFamily: string
  fontSize: number
  minimap: boolean
  wordWrap: 'off' | 'on' | 'wordWrapColumn' | 'bounded'
  lineNumbers: 'on' | 'off' | 'relative' | 'interval'
  tabSize: number
}

export interface UiConfig {
  fileTreeWidthPx: number
  logPanelExpandedHeightPx: number
}

export interface SessionsConfig {
  maxSessionsInPicker: number
  maxRecentProjects: number
}

export interface AppConfig {
  editor: EditorConfig
  ui: UiConfig
  sessions: SessionsConfig
}

const DEFAULTS: AppConfig = {
  editor: {
    maxFileSizeMb: 5,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 14,
    minimap: false,
    wordWrap: 'off',
    lineNumbers: 'on',
    tabSize: 2
  },
  ui: {
    fileTreeWidthPx: 220,
    logPanelExpandedHeightPx: 200
  },
  sessions: {
    maxSessionsInPicker: 20,
    maxRecentProjects: 20
  }
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
        editor: { ...DEFAULTS.editor, ...(parsed.editor ?? {}) },
        ui: { ...DEFAULTS.ui, ...(parsed.ui ?? {}) },
        sessions: { ...DEFAULTS.sessions, ...(parsed.sessions ?? {}) }
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

