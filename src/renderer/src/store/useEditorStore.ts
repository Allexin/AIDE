import { create } from 'zustand'
import { usePanelStore } from './usePanelStore'

interface EditorState {
  openFile: string | null // absolute OS path
  openRelativePath: string | null // forward-slash relative path (for display)

  openFileInEditor: (absolutePath: string, relativePath: string) => void
  closeEditor: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  openFile: null,
  openRelativePath: null,

  openFileInEditor: (absolutePath: string, relativePath: string) => {
    set({ openFile: absolutePath, openRelativePath: relativePath })
    usePanelStore.getState().setEditorVisible(true)
  },

  closeEditor: () => {
    set({ openFile: null, openRelativePath: null })
    usePanelStore.getState().setEditorVisible(false)
  }
}))
