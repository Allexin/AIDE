import { create } from 'zustand'

interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  title?: string
}

export interface SessionTab {
  tabId: string
  sessionId: string | null
  slug: string
  exited: boolean
  attention: boolean  // true → blink tab (Claude is waiting for input)
}

interface SessionState {
  tabs: SessionTab[]
  activeTabId: string | null
  initialized: boolean

  // Actions
  initWithTab: (tab: SessionTabInfo) => void
  initWithTabs: (tabs: SessionTabInfo[], activeTabId: string | null) => void
  addTab: (tab: SessionTabInfo) => void
  setActiveTab: (tabId: string) => void
  updateSlug: (tabId: string, slug: string) => void
  updateSessionId: (tabId: string, sessionId: string) => void
  markExited: (tabId: string) => void
  closeTab: (tabId: string) => void
  resetTabs: (tabs: SessionTabInfo[]) => void
  setAttention: (tabId: string, attention: boolean) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  tabs: [],
  activeTabId: null,
  initialized: false,

  initWithTab: (tab: SessionTabInfo) =>
    set({
      tabs: [{ tabId: tab.tabId, sessionId: tab.sessionId, slug: tab.title || 'Claude Code', exited: false, attention: false }],
      activeTabId: tab.tabId,
      initialized: true
    }),

  initWithTabs: (tabs: SessionTabInfo[], activeTabId: string | null) =>
    set({
      tabs: tabs.map((t) => ({ tabId: t.tabId, sessionId: t.sessionId, slug: t.title || 'Claude Code', exited: false, attention: false })),
      activeTabId: activeTabId ?? tabs[0]?.tabId ?? null,
      initialized: true
    }),

  addTab: (tab: SessionTabInfo) =>
    set((state) => ({
      tabs: [...state.tabs, { tabId: tab.tabId, sessionId: tab.sessionId, slug: 'Claude Code', exited: false, attention: false }],
      activeTabId: tab.tabId // switch to new tab
    })),

  setActiveTab: (tabId: string) =>
    set((state) => ({
      activeTabId: tabId,
      // Clear attention when user switches to this tab
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, attention: false } : t))
    })),

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
    })),

  closeTab: (tabId: string) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.tabId !== tabId)
      if (remaining.length === 0) return state // can't close the last tab
      const newActive =
        state.activeTabId === tabId
          ? remaining[Math.max(0, state.tabs.findIndex((t) => t.tabId === tabId) - 1)]?.tabId ?? remaining[0].tabId
          : state.activeTabId
      return { tabs: remaining, activeTabId: newActive }
    }),

  resetTabs: (newTabs: SessionTabInfo[]) =>
    set({
      tabs: newTabs.map((t) => ({ tabId: t.tabId, sessionId: t.sessionId, slug: 'Claude Code', exited: false, attention: false })),
      activeTabId: newTabs[0]?.tabId ?? null
    }),

  setAttention: (tabId: string, attention: boolean) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, attention } : t))
    }))
}))
