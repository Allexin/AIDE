import { create } from 'zustand'
import { stripAnsi } from '../utils/stripAnsi'

const MAX_LINES = 10_000
const TRUNCATION_NOTICE = '[Older output truncated]'

export interface LogChannel {
  id: string      // also used as display label
  lines: string[]
  attention: boolean  // true → blink tab when new content arrives
  blinking: boolean   // currently blinking (stops when user clicks the tab)
}

interface LogState {
  channels: LogChannel[]
  activeChannelId: string | null

  append: (channelId: string, line: string, attention?: boolean) => void
  clear: (channelId: string) => void
  close: (channelId: string) => void
  setActive: (channelId: string) => void
  stopBlink: (channelId: string) => void
}

export const useLogStore = create<LogState>((set) => ({
  channels: [],
  activeChannelId: null,

  append: (channelId: string, line: string, attention = false) => {
    const stripped = stripAnsi(line)
    set((state) => {
      const idx = state.channels.findIndex((c) => c.id === channelId)

      if (idx >= 0) {
        // Existing channel — append line, enforce buffer cap
        const ch = state.channels[idx]
        let newLines = [...ch.lines, stripped]

        if (newLines.length > MAX_LINES) {
          // Drop oldest entries to stay at limit
          newLines = newLines.slice(newLines.length - MAX_LINES)
          // Ensure truncation notice is at index 0
          if (newLines[0] !== TRUNCATION_NOTICE) {
            newLines[0] = TRUNCATION_NOTICE
          }
        }

        const updated: LogChannel = {
          ...ch,
          lines: newLines,
          // Trigger blink only if this channel has attention:true
          blinking: ch.attention ? true : ch.blinking
        }
        return { channels: state.channels.map((c, i) => (i === idx ? updated : c)) }
      } else {
        // New channel — auto-create on first append
        const newChannel: LogChannel = {
          id: channelId,
          lines: [stripped],
          attention,
          blinking: attention // blink immediately if attention channel
        }
        return { channels: [...state.channels, newChannel] }
      }
    })
  },

  clear: (channelId: string) => {
    set((state) => ({
      channels: state.channels.map((c) =>
        c.id === channelId ? { ...c, lines: [], blinking: false } : c
      )
    }))
  },

  close: (channelId: string) => {
    set((state) => {
      const newChannels = state.channels.filter((c) => c.id !== channelId)
      const newActive =
        state.activeChannelId === channelId
          ? (newChannels[0]?.id ?? null)
          : state.activeChannelId
      return { channels: newChannels, activeChannelId: newActive }
    })
  },

  setActive: (channelId: string) => set({ activeChannelId: channelId }),

  stopBlink: (channelId: string) => {
    set((state) => ({
      channels: state.channels.map((c) =>
        c.id === channelId ? { ...c, blinking: false } : c
      )
    }))
  }
}))

// Convenience singleton for non-component code (stores, IPC handlers, etc.)
export const logManager = {
  append: (channelId: string, line: string, attention = false): void => {
    useLogStore.getState().append(channelId, line, attention)
  },
  clear: (channelId: string): void => {
    useLogStore.getState().clear(channelId)
  }
}
