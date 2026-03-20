import { create } from 'zustand'

interface ThinkingState {
  thinking: string | null
  index: number   // 0-based, current displayed block
  total: number
  isExpanded: boolean

  setBlock: (thinking: string, index: number, total: number) => void
  setTotal: (total: number) => void
  reset: () => void
  setExpanded: (v: boolean) => void
  toggleExpanded: () => void
}

export const useThinkingStore = create<ThinkingState>((set) => ({
  thinking: null,
  index: 0,
  total: 0,
  isExpanded: false,

  setBlock: (thinking, index, total) => set({ thinking, index, total }),
  setTotal: (total) => set({ total }),
  reset: () => set({ thinking: null, index: 0, total: 0 }),
  setExpanded: (v) => set({ isExpanded: v }),
  toggleExpanded: () => set((s) => ({ isExpanded: !s.isExpanded }))
}))
