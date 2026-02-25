import { create } from 'zustand'

interface PanelConfig {
  activePanelRatio: number
  collapsedWidthPx: number
  fileTreeWidthPx: number
  logPanelExpandedHeightPx: number
}

interface PanelState extends PanelConfig {
  // Runtime state
  editorVisible: boolean
  terminalCollapsed: boolean
  logPanelExpanded: boolean
  /** Which panel is currently "active" (receives the activePanelRatio width). */
  focusedPanel: 'editor' | 'terminal'

  // Actions
  initFromConfig: (config: PanelConfig) => void
  setEditorVisible: (visible: boolean) => void
  toggleTerminalCollapse: () => void
  focusEditor: () => void
  focusTerminal: () => void
  toggleLogPanel: () => void
}

export const usePanelStore = create<PanelState>((set) => ({
  // Config defaults — overridden by initFromConfig() on mount
  activePanelRatio: 0.75,
  collapsedWidthPx: 20,
  fileTreeWidthPx: 220,
  logPanelExpandedHeightPx: 200,

  // Runtime state
  editorVisible: false,
  terminalCollapsed: false,
  logPanelExpanded: false,
  focusedPanel: 'terminal',

  initFromConfig: (config: PanelConfig) => set(config),

  setEditorVisible: (visible: boolean) =>
    set((state) => ({
      editorVisible: visible,
      // Opening a file: focus switches to editor automatically
      focusedPanel: visible ? 'editor' : state.focusedPanel
    })),

  toggleTerminalCollapse: () =>
    set((state) => ({ terminalCollapsed: !state.terminalCollapsed })),

  focusEditor: () => set({ focusedPanel: 'editor' }),
  focusTerminal: () => set({ focusedPanel: 'terminal' }),

  toggleLogPanel: () => set((state) => ({ logPanelExpanded: !state.logPanelExpanded }))
}))
