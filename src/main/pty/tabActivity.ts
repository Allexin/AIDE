import { EventEmitter } from 'events'

/**
 * Whether a terminal tab's CLI is idle — waiting for the user's input — as far
 * as AIDE can tell. Idle after startup health check succeeds or after the CLI's
 * `completeAndWait` signal (a Stop hook, a title change or PTY silence, depending
 * on the CLI); busy again when input is submitted to it or it calls AIDE's
 * pipeline server (an agent inside a tool call is working, even when its PTY is
 * silent).
 *
 * Also tracks whether the user appears to have unsent text in the tab's input
 * box (by inspecting keystrokes sent to the PTY), so inter-agent messaging can
 * refuse delivery instead of colliding with a draft the user is typing.
 *
 * Emits:
 *   'idle' (tabId)   — when a tab becomes idle
 *   'forget' (tabId) — when a tab is closed / forgotten
 */

interface DraftState {
  text: string
  /** True when the user pressed a single character while the tab was busy (e.g. a
   *  permission prompt hotkey like "1" or "y"), cleared automatically once the turn ends. */
  singleBusyKey: boolean
}

const MAX_DRAFT_TRACKED = 512

/** Update a tab's tracked draft buffer from one chunk of terminal input. Returns true if the input submitted a prompt. */
export function applyInputToDraft(state: DraftState, data: string, isIdle: boolean): boolean {
  if (!data) return false

  // Bracketed paste: text between \x1b[200~ and \x1b[201~ is never a submit.
  if (data.startsWith('\x1b[200~')) {
    const pasted = data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')
    if (pasted.length > 0) {
      state.text = (state.text + pasted).slice(-MAX_DRAFT_TRACKED)
      state.singleBusyKey = false
    }
    return false
  }

  let submitted = false
  let i = 0
  while (i < data.length) {
    const ch = data[i]

    // Escape sequences (CSI, SS3, OSC, Alt+key)
    if (ch === '\x1b') {
      const next = data[i + 1]
      if (next === '[') {
        // CSI sequence: \x1b[ <params> <intermediates> <final>
        let j = i + 2
        while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
        if (j < data.length) {
          const seq = data.slice(i, j + 1)
          if (seq === '\x1b[13u') {
            // Plain Enter in Kitty keyboard protocol
            state.text = ''
            state.singleBusyKey = false
            submitted = true
          } else if (/^\x1b\[(?:13;\d+u|27;\d+;13~)$/.test(seq)) {
            // Modified Enter (Shift+Enter, Ctrl+Enter, Alt+Enter): inserts newline
            state.text = (state.text + '\n').slice(-MAX_DRAFT_TRACKED)
            state.singleBusyKey = false
          } else if (seq === '\x1b[3~') {
            // Delete key
            state.text = state.text.slice(0, -1)
            if (!state.text) state.singleBusyKey = false
          }
          // All other CSI sequences (arrows, focus in/out \x1b[I / \x1b[O, mouse \x1b[<...) are ignored.
          i = j + 1
          continue
        }
        break
      }
      if (next === 'O') {
        i += Math.min(3, data.length - i)
        continue
      }
      if (next === ']') {
        // OSC sequence terminated by BEL (\x07) or ST (\x1b\\)
        const bel = data.indexOf('\x07', i + 2)
        const st = data.indexOf('\x1b\\', i + 2)
        const end = bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st !== -1 ? st + 2 : data.length
        i = end
        continue
      }
      if (next === '\r' || next === '\n') {
        // Alt+Enter inserts a newline in CLI prompt boxes
        state.text = (state.text + '\n').slice(-MAX_DRAFT_TRACKED)
        state.singleBusyKey = false
        i += 2
        continue
      }
      if (next === '\x7f' || next === '\x08') {
        // Alt+Backspace deletes previous word
        deleteLastWord(state)
        i += 2
        continue
      }
      // Bare Escape or other 2-byte Alt sequence — ignore
      i += next !== undefined ? 2 : 1
      continue
    }

    // Enter (submit)
    if (ch === '\r') {
      state.text = ''
      state.singleBusyKey = false
      submitted = true
      i++
      continue
    }

    // Bare LF (e.g. Ctrl+J newline)
    if (ch === '\n') {
      state.text = (state.text + '\n').slice(-MAX_DRAFT_TRACKED)
      state.singleBusyKey = false
      i++
      continue
    }

    // Ctrl+C, Ctrl+U, Ctrl+D: clear/cancel current prompt
    if (ch === '\x03' || ch === '\x15' || ch === '\x04') {
      state.text = ''
      state.singleBusyKey = false
      i++
      continue
    }

    // Backspace (\x7f DEL or \x08 BS)
    if (ch === '\x7f' || ch === '\x08') {
      state.text = state.text.slice(0, -1)
      if (!state.text) state.singleBusyKey = false
      i++
      continue
    }

    // Ctrl+W: delete previous word
    if (ch === '\x17') {
      deleteLastWord(state)
      i++
      continue
    }

    // Printable character or Tab
    const code = ch.charCodeAt(0)
    if (code >= 0x20 || ch === '\t') {
      const wasEmpty = state.text.length === 0
      state.text = (state.text + ch).slice(-MAX_DRAFT_TRACKED)
      state.singleBusyKey = !isIdle && wasEmpty && data.length === 1
    }
    i++
  }

  return submitted
}

function deleteLastWord(state: DraftState): void {
  if (!state.text) return
  const next = state.text.replace(/\s*\S+\s*$/, '')
  state.text = next === state.text ? state.text.slice(0, -1) : next
  if (!state.text) state.singleBusyKey = false
}

class TabActivity extends EventEmitter {
  private readonly idle = new Set<string>()
  private readonly drafts = new Map<string, DraftState>()

  markIdle(tabId: string): void {
    const draft = this.drafts.get(tabId)
    if (draft?.singleBusyKey) {
      draft.text = ''
      draft.singleBusyKey = false
    }
    if (this.idle.has(tabId)) return
    this.idle.add(tabId)
    this.emit('idle', tabId)
  }

  markBusy(tabId: string): void {
    this.idle.delete(tabId)
  }

  /** Data written to a tab by the user; a submit makes it busy, typing tracks unsent draft text. */
  input(tabId: string, data: string): void {
    let state = this.drafts.get(tabId)
    if (!state) {
      state = { text: '', singleBusyKey: false }
      this.drafts.set(tabId, state)
    }
    const submitted = applyInputToDraft(state, data, this.idle.has(tabId))
    if (submitted) this.markBusy(tabId)
  }

  isIdle(tabId: string): boolean {
    return this.idle.has(tabId)
  }

  /** Whether the user appears to have unsent text in this tab's CLI input box. */
  hasUserDraft(tabId: string): boolean {
    const state = this.drafts.get(tabId)
    return !!state && state.text.length > 0
  }

  forget(tabId: string): void {
    this.idle.delete(tabId)
    this.drafts.delete(tabId)
    this.emit('forget', tabId)
  }
}

export const tabActivity = new TabActivity()
