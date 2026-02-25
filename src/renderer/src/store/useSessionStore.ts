import { create } from 'zustand'

export interface SessionTab {
  tabId: string
  sessionId: string | null
  slug: string
  exited: boolean
}

interface SessionState {
  tabs: SessionTab[]
  activeTabId: string | null
  initialized: boolean

  // Actions
  initWithTab: (tab: SessionTabInfo) => void
  addTab: (tab: SessionTabInfo) => void
  setActiveTab: (tabId: string) => void
  updateSlug: (tabId: string, slug: string) => void
  updateSessionId: (tabId: string, sessionId: string) => void
  markExited: (tabId: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  tabs: [],
  activeTabId: null,
  initialized: false,

  initWithTab: (tab: SessionTabInfo) =>
    set({
      tabs: [{ ...tab, exited: false }],
      activeTabId: tab.tabId,
      initialized: true
    }),

  addTab: (tab: SessionTabInfo) =>
    set((state) => ({
      tabs: [...state.tabs, { ...tab, exited: false }],
      activeTabId: tab.tabId // switch to new tab
    })),

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateSlug: (tabId: string, slug: string) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, slug } : t))
    })),

  updateSessionId: (tabId: string, sessionId: string) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, sessionId } : t))
    })),

  markExited: (tabId: string) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, exited: true } : t))
    }))
}))
