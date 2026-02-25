import { create } from 'zustand'

interface ToastState {
  message: string | null
  show: (msg: string) => void
  hide: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null

export const useToastStore = create<ToastState>((set) => ({
  message: null,

  show: (msg: string) => {
    if (timer) clearTimeout(timer)
    set({ message: msg })
    timer = setTimeout(() => set({ message: null }), 4000)
  },

  hide: () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    set({ message: null })
  }
}))
