import { EventEmitter } from 'events'

/**
 * Whether a terminal tab's CLI is idle — waiting for the user's input — as far
 * as AIDE can tell. Idle after the CLI's `completeAndWait` signal (a Stop hook,
 * a title change or PTY silence, depending on the CLI); busy again when input is
 * submitted to it or it calls AIDE's pipeline server (an agent inside a tool
 * call is working, even when its PTY is silent). A new tab is not idle until it
 * says so.
 *
 * Emits 'idle' (tabId) when a tab becomes idle.
 */
class TabActivity extends EventEmitter {
  private readonly idle = new Set<string>()

  markIdle(tabId: string): void {
    if (this.idle.has(tabId)) return
    this.idle.add(tabId)
    this.emit('idle', tabId)
  }

  markBusy(tabId: string): void {
    this.idle.delete(tabId)
  }

  /** Data written to a tab by the user; a submit (Enter, not part of a paste) makes it busy. */
  input(tabId: string, data: string): void {
    if (data.includes('\r') && !data.startsWith('\x1b[200~')) this.markBusy(tabId)
  }

  isIdle(tabId: string): boolean {
    return this.idle.has(tabId)
  }

  forget(tabId: string): void {
    this.idle.delete(tabId)
  }
}

export const tabActivity = new TabActivity()
