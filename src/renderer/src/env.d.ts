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

interface EditorAPI {
  getProjectPath: () => Promise<string | null>
}

declare interface Window {
  pickerApi: PickerAPI
  editorApi: EditorAPI
}
