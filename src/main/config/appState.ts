import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface RecentProject {
  path: string
  lastOpened: string // ISO 8601
}

export interface AppState {
  recentProjects: RecentProject[]
}

const DEFAULTS: AppState = {
  recentProjects: []
}

let state: AppState = structuredClone(DEFAULTS)
let statePath = ''

export function initAppState(): void {
  statePath = join(app.getPath('userData'), 'aide-state.json')

  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppState>
      state = { ...DEFAULTS, ...parsed }
    } catch {
      state = structuredClone(DEFAULTS)
    }
  }
}

export function getAppState(): AppState {
  return state
}

function saveAppState(): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

export function addRecentProject(projectPath: string, maxRecent: number): void {
  state.recentProjects = [
    { path: projectPath, lastOpened: new Date().toISOString() },
    ...state.recentProjects.filter(p => p.path !== projectPath)
  ].slice(0, maxRecent)

  saveAppState()
}

export function removeRecentProject(projectPath: string): void {
  state.recentProjects = state.recentProjects.filter(p => p.path !== projectPath)
  saveAppState()
}
