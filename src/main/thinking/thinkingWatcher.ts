import { watch, openSync, fstatSync, readSync, closeSync, existsSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { getSessionsDir } from '../pty/sessionScanner'

interface TabState {
  sessionId: string
  filePath: string
  blocks: string[]    // thinking texts in order
  offset: number      // byte offset read so far
  watcher: FSWatcher | null
}

export class ThinkingWatcher {
  private readonly win: BrowserWindow
  private readonly projectPath: string
  private tabs = new Map<string, TabState>()

  constructor(win: BrowserWindow, projectPath: string) {
    this.win = win
    this.projectPath = projectPath
  }

  startWatching(tabId: string, sessionId: string): void {
    // Stop any existing watcher for this tab first
    this.stopWatching(tabId)

    const filePath = join(getSessionsDir(this.projectPath), `${sessionId}.jsonl`)

    const state: TabState = {
      sessionId,
      filePath,
      blocks: [],
      offset: 0,
      watcher: null
    }
    this.tabs.set(tabId, state)

    // Read whatever already exists in the file
    this.readNew(tabId)

    // Watch for appends
    if (existsSync(filePath)) {
      this.attachWatcher(tabId)
    } else {
      // File may not exist yet (brand new session); poll until it appears
      const interval = setInterval(() => {
        const s = this.tabs.get(tabId)
        if (!s) { clearInterval(interval); return }
        if (existsSync(s.filePath)) {
          clearInterval(interval)
          this.readNew(tabId)
          this.attachWatcher(tabId)
        }
      }, 500)
    }
  }

  stopWatching(tabId: string): void {
    const state = this.tabs.get(tabId)
    if (!state) return
    state.watcher?.close()
    this.tabs.delete(tabId)
  }

  /** Return one block by index (or last if index === -1). Returns null if not available. */
  getBlock(tabId: string, index: number | 'last'): { thinking: string; index: number; total: number } | null {
    const state = this.tabs.get(tabId)
    if (!state || state.blocks.length === 0) return null

    const total = state.blocks.length
    const i = index === 'last' ? total - 1 : index
    if (i < 0 || i >= total) return null

    return { thinking: state.blocks[i], index: i, total }
  }

  disposeAll(): void {
    for (const tabId of this.tabs.keys()) {
      this.stopWatching(tabId)
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private attachWatcher(tabId: string): void {
    const state = this.tabs.get(tabId)
    if (!state) return

    try {
      state.watcher = watch(state.filePath, () => {
        this.readNew(tabId)
      })
    } catch {
      // File gone or permission issue — ignore
    }
  }

  private readNew(tabId: string): void {
    const state = this.tabs.get(tabId)
    if (!state || !existsSync(state.filePath)) return

    let fd: number
    try {
      fd = openSync(state.filePath, 'r')
    } catch {
      return
    }

    try {
      const fileSize = fstatSync(fd).size
      if (fileSize <= state.offset) return

      const len = fileSize - state.offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, state.offset)
      state.offset = fileSize

      const text = buf.toString('utf-8')
      const lines = text.split('\n')

      let foundNew = false
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const blocks = parseThinkingBlocks(trimmed)
        if (blocks.length > 0) {
          state.blocks.push(...blocks)
          foundNew = true
        }
      }

      if (foundNew) {
        this.send('thinking:update', { tabId, total: state.blocks.length })
      }
    } finally {
      closeSync(fd)
    }
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }
}

/** Extract all thinking block texts from a single JSONL line. */
function parseThinkingBlocks(line: string): string[] {
  try {
    const obj = JSON.parse(line)
    if (obj.type !== 'assistant') return []
    const content = obj?.message?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((b: unknown) =>
        typeof b === 'object' && b !== null &&
        (b as { type?: string }).type === 'thinking' &&
        typeof (b as { thinking?: unknown }).thinking === 'string' &&
        (b as { thinking: string }).thinking.length > 0
      )
      .map((b: unknown) => (b as { thinking: string }).thinking)
  } catch {
    return []
  }
}
