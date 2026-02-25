import { create } from 'zustand'

interface ToolbarState {
  buttons: ToolbarButton[]
  runningButtonIds: Set<string>
  projectType: string
  suggestedType: string | null
  showAutoDetectDialog: boolean
  showPresetDialog: boolean

  setButtons: (buttons: ToolbarButton[]) => void
  markRunning: (id: string) => void
  markStopped: (id: string) => void
  setProjectType: (type: string) => void
  setSuggestedType: (type: string | null) => void
  setShowAutoDetectDialog: (show: boolean) => void
  setShowPresetDialog: (show: boolean) => void
}

export const useToolbarStore = create<ToolbarState>((set) => ({
  buttons: [],
  runningButtonIds: new Set(),
  projectType: '',
  suggestedType: null,
  showAutoDetectDialog: false,
  showPresetDialog: false,

  setButtons: (buttons) => set({ buttons }),

  markRunning: (id) =>
    set((state) => ({ runningButtonIds: new Set([...state.runningButtonIds, id]) })),

  markStopped: (id) =>
    set((state) => {
      const next = new Set(state.runningButtonIds)
      next.delete(id)
      return { runningButtonIds: next }
    }),

  setProjectType: (type) => set({ projectType: type }),
  setSuggestedType: (type) => set({ suggestedType: type }),
  setShowAutoDetectDialog: (show) => set({ showAutoDetectDialog: show }),
  setShowPresetDialog: (show) => set({ showPresetDialog: show })
}))
