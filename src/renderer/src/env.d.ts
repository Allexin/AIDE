/// <reference types="vite/client" />

interface PickerAPI {
  selectFolder: () => Promise<string | null>
  openProject: (path: string) => Promise<{ success: true } | { success: false; error: string }>
}

interface EditorAPI {
  getProjectPath: () => Promise<string | null>
}

declare interface Window {
  pickerApi: PickerAPI
  editorApi: EditorAPI
}
