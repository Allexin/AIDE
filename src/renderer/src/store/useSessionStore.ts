import { create } from 'zustand'

export interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  title?: string
  toolId: string
  toolName: string
}

export interface SessionTab {
  tabId: string
  sessionId: string | null
  toolId: string
  toolName: string
  slug: string
  exited: boolean
  attention: boolean
}

interface SessionState {
  tabs: SessionTab[]
  activeTabId: string | null
  initialized: boolean

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

function tabFromInfo(t: SessionTabInfo, slug?: string): SessionTab {
  return {
    tabId: t.tabId,
    sessionId: t.sessionId,
    toolId: t.toolId,
    toolName: t.toolName,
    slug: slug ?? t.title ?? t.toolName ?? t.toolId,
    exited: false,
    attention: false
  }
}

export const useSessionStore = create<SessionState>((set) => ({
  tabs: [],
  activeTabId: null,
  initialized: false,

  initWithTab: (tab: SessionTabInfo) =>
    set({
      tabs: [tabFromInfo(tab)],
      activeTabId: tab.tabId,
      initialized: true
    }),

  initWithTabs: (tabs: SessionTabInfo[], activeTabId: string | null) =>
    set({
      tabs: tabs.map((t) => tabFromInfo(t)),
      activeTabId: activeTabId ?? tabs[0]?.tabId ?? null,
      initialized: true
    }),

  addTab: (tab: SessionTabInfo) =>
    set((state) => ({
      tabs: [...state.tabs, tabFromInfo(tab)],
      activeTabId: tab.tabId
    })),

  setActiveTab: (tabId: string) =>
    set((state) => ({
      activeTabId: tabId,
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
      if (remaining.length === 0) return state
      const newActive =
        state.activeTabId === tabId
          ? remaining[Math.max(0, state.tabs.findIndex((t) => t.tabId === tabId) - 1)]?.tabId ?? remaining[0].tabId
          : state.activeTabId
      return { tabs: remaining, activeTabId: newActive }
    }),

  resetTabs: (newTabs: SessionTabInfo[]) =>
    set({
      tabs: newTabs.map((t) => tabFromInfo(t)),
      activeTabId: newTabs[0]?.tabId ?? null
    }),

  setAttention: (tabId: string, attention: boolean) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.tabId === tabId ? { ...t, attention } : t))
    }))
}))
