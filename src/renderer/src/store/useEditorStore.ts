import { create } from 'zustand'
import { usePanelStore } from './usePanelStore'

interface EditorState {
  openFile: string | null // absolute OS path
  openRelativePath: string | null // forward-slash relative path (for display)
  editorConfig: EditorConfig | null // Monaco editor options from app config
  openDiffOnLoad: boolean // if true, switch to diff mode after next file load
  triggerDiffNow: boolean // if true, trigger diff on the already-open file
  cursorPosition: { line: number; column: number } | null // for status bar
  currentLanguage: string | null // Monaco language ID of the open file

  openFileInEditor: (absolutePath: string, relativePath: string) => void
  closeEditor: () => void
  setEditorConfig: (config: EditorConfig) => void
  setOpenDiffOnLoad: (val: boolean) => void
  setTriggerDiffNow: (val: boolean) => void
  viewDiff: (absolutePath: string, relativePath: string) => void
  setCursorPosition: (pos: { line: number; column: number } | null) => void
  setCurrentLanguage: (lang: string | null) => void
}

export const useEditorStore = create<EditorState>((set, get) => ({
  openFile: null,
  openRelativePath: null,
  editorConfig: null,
  openDiffOnLoad: false,
  triggerDiffNow: false,
  cursorPosition: null,
  currentLanguage: null,

  openFileInEditor: (absolutePath: string, relativePath: string) => {
    set({ openFile: absolutePath, openRelativePath: relativePath })
    usePanelStore.getState().setEditorVisible(true)
  },

  closeEditor: () => {
    set({
      openFile: null,
      openRelativePath: null,
      openDiffOnLoad: false,
      triggerDiffNow: false,
      cursorPosition: null,
      currentLanguage: null
    })
    usePanelStore.getState().setEditorVisible(false)
  },

  setEditorConfig: (config: EditorConfig) => set({ editorConfig: config }),

  setOpenDiffOnLoad: (val: boolean) => set({ openDiffOnLoad: val }),

  setTriggerDiffNow: (val: boolean) => set({ triggerDiffNow: val }),

  viewDiff: (absolutePath: string, relativePath: string) => {
    const { openFile } = get()
    if (openFile === absolutePath) {
      // File is already open in the editor — signal EditorPanel to load diff immediately
      set({ triggerDiffNow: true })
    } else {
      // Open the file first, then switch to diff after it loads
      set({ openDiffOnLoad: true })
      get().openFileInEditor(absolutePath, relativePath)
    }
  },

  setCursorPosition: (pos) => set({ cursorPosition: pos }),

  setCurrentLanguage: (lang) => set({ currentLanguage: lang })
}))
