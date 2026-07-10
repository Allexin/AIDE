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
  maxRestoredSessions: number
}

export interface GitConfig {
  addBatchSize: number // files per `git add` call in commit dialog
}

export interface SoundNote {
  freq: number   // Hz, e.g. 523 = C5
  dur: number    // note duration, ms
  delay: number  // offset from playback start, ms
}

export interface ToolbarSoundsConfig {
  complete: SoundNote[]
  error: SoundNote[]
  completeAndWait: SoundNote[]
}

export interface ToolbarAppConfig {
  sounds: ToolbarSoundsConfig
}

export interface ReasoningConfig {
  showPanel: boolean
}

export interface UpdatesConfig {
  notifyFrequency: 'never' | 'daily' | 'weekly' | 'monthly'
}

export interface RemoteCustomButton {
  label: string
  send: string  // escape-sequence notation: \r, \n, \t, \x03, \x1b, etc.
}

export interface RemoteButtonRow {
  buttons: RemoteCustomButton[]
}

export interface RemoteConfig {
  enabled: boolean
  remoteHost: string // external host:port or hostname shown in connect QR dialog
  buttonSize: 'small' | 'medium' | 'large'
  buttonRows: RemoteButtonRow[]
}

export interface AppConfig {
  editor: EditorConfig
  ui: UiConfig
  sessions: SessionsConfig
  git: GitConfig
  toolbar: ToolbarAppConfig
  reasoning: ReasoningConfig
  updates: UpdatesConfig
  remote: RemoteConfig
  toolConfigs: Record<string, Record<string, unknown>>
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
    maxRecentProjects: 20,
    maxRestoredSessions: 5
  },
  git: {
    addBatchSize: 10
  },
  reasoning: {
    showPanel: false
  },
  updates: {
    notifyFrequency: 'daily'
  },
  remote: {
    enabled: false,
    remoteHost: '',
    buttonSize: 'medium',
    buttonRows: [
      {
        buttons: [
          { label: 'Ctrl+C', send: '\\x03' },
          { label: 'Esc',    send: '\\x1b' },
          { label: '↑',      send: '\\x1b[A' },
          { label: '↓',      send: '\\x1b[B' },
          { label: 'Tab',    send: '\\t' },
          { label: 'Del',    send: '\\x1b[3~' },
          { label: '⌫',      send: '\\x7f' },
          { label: '↵',      send: '\\r' }
        ]
      }
    ]
  },
  toolConfigs: {},
  toolbar: {
    sounds: {
      complete: [
        { freq: 1047, dur: 120, delay: 0   },
        { freq: 1319, dur: 120, delay: 150 },
        { freq: 1568, dur: 220, delay: 300 }
      ],
      error: [
        { freq: 880, dur: 180, delay: 0   },
        { freq: 698, dur: 300, delay: 200 }
      ],
      completeAndWait: [
        { freq: 988,  dur: 80,  delay: 0   },
        { freq: 1319, dur: 150, delay: 110 }
      ]
    }
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
        sessions: { ...DEFAULTS.sessions, ...(parsed.sessions ?? {}) },
        git: { ...DEFAULTS.git, ...(parsed.git ?? {}) },
        reasoning: { ...DEFAULTS.reasoning, ...(parsed.reasoning ?? {}) },
        updates: { ...DEFAULTS.updates, ...(parsed.updates ?? {}) },
        remote: { ...DEFAULTS.remote, ...(parsed.remote ?? {}) },
        toolConfigs: { ...DEFAULTS.toolConfigs, ...(parsed.toolConfigs ?? {}) },
        toolbar: {
          sounds: {
            complete: parsed.toolbar?.sounds?.complete ?? DEFAULTS.toolbar.sounds.complete,
            error: parsed.toolbar?.sounds?.error ?? DEFAULTS.toolbar.sounds.error,
            completeAndWait: parsed.toolbar?.sounds?.completeAndWait ?? DEFAULTS.toolbar.sounds.completeAndWait
          }
        }
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

export function getToolConfig(toolId: string): Record<string, unknown> {
  return config.toolConfigs[toolId] ?? {}
}

export function updateToolConfig(toolId: string, values: Record<string, unknown>): void {
  config.toolConfigs = { ...config.toolConfigs, [toolId]: values }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

