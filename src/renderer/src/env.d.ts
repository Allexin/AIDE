/// <reference types="vite/client" />

interface RecentProject {
  path: string
  lastOpened: string // ISO 8601
}

interface PickerAPI {
  selectFolder: () => Promise<string | null>
  openProject: (path: string) => Promise<{ success: true } | { success: false; error: string }>
  getState: () => Promise<{ recentProjects: RecentProject[] }>
  validatePath: (path: string) => Promise<boolean>
  removeRecentProject: (path: string) => Promise<void>
}

interface ProjectSettings {
  activePanelRatio: number
  collapsedWidthPx: number
}

interface EditorAPI {
  getProjectPath: () => Promise<string | null>
  getProjectSettings: () => Promise<ProjectSettings>
  getConfig: () => Promise<{
    ui: { fileTreeWidthPx: number; logPanelExpandedHeightPx: number }
  }>
}

declare interface Window {
  pickerApi: PickerAPI
  editorApi: EditorAPI
}
