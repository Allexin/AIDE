import { watch, openSync, fstatSync, readSync, closeSync, existsSync } from 'fs'
import type { FSWatcher } from 'fs'
import type { BrowserWindow } from 'electron'
import type { CliTool } from '../pty/cliTools/types'
import type { HistoryBlock } from '../pty/cliTools/types'

interface TabState {
  sessionId: string
  filePath: string
  tool: CliTool
  blocks: string[]    // thinking texts in order
  offset: number      // byte offset read so far
  watcher: FSWatcher | null
  unsubscribeHistory: (() => void) | null
}

export class ThinkingWatcher {
  private readonly win: BrowserWindow
  private tabs = new Map<string, TabState>()

  constructor(win: BrowserWindow) {
    this.win = win
  }

  /** Start watching a session file. filePath comes from tool.getSessionFilePath().
   *  If filePath is null the tool does not support file-based thinking blocks — no-op.
   */
  startWatching(
    tabId: string,
    sessionId: string,
    projectPath: string,
    filePath: string | null,
    tool: CliTool
  ): void {
    // Stop any existing watcher for this tab first
    this.stopWatching(tabId)

    if (!filePath) return

    const state: TabState = {
      sessionId,
      filePath,
      tool,
      blocks: [],
      offset: 0,
      watcher: null,
      unsubscribeHistory: null
    }
    this.tabs.set(tabId, state)

    // Tools without appendable JSONL session files (Cursor Agent stores reasoning
    // in store.db; Devin rewrites the whole ATIF transcript) stream thinking via
    // history entries instead of line-based parsing.
    if (
      (tool.id === 'cursor-agent' || tool.id === 'devin') &&
      (tool.getSessionHistory || tool.subscribeToSessionHistory)
    ) {
      void this.bootstrapFromHistory(tabId, projectPath, sessionId)
      state.unsubscribeHistory = tool.subscribeToSessionHistory?.(projectPath, sessionId, (entry) => {
        const s = this.tabs.get(tabId)
        if (!s) return
        const thinkingBlocks = entry.blocks
          .filter((b): b is Extract<HistoryBlock, { type: 'thinking' }> => b.type === 'thinking')
          .map((b) => b.thinking)
          .filter((t) => t.trim().length > 0)
        if (thinkingBlocks.length === 0) return
        this.pushThinkingBlocks(tabId, thinkingBlocks)
      }) ?? null
      return
    }

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
    state.unsubscribeHistory?.()
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
        const blocks = state.tool.parseThinkingBlocks?.(trimmed) ?? []
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

  private async bootstrapFromHistory(tabId: string, projectPath: string, sessionId: string): Promise<void> {
    const state = this.tabs.get(tabId)
    if (!state) return
    const history = await state.tool.getSessionHistory?.(projectPath, sessionId)
    if (!history || history.length === 0) return
    const thinkingBlocks = history
      .flatMap((entry) => entry.blocks)
      .filter((b): b is Extract<HistoryBlock, { type: 'thinking' }> => b.type === 'thinking')
      .map((b) => b.thinking)
      .filter((t) => t.trim().length > 0)
    if (thinkingBlocks.length === 0) return
    this.pushThinkingBlocks(tabId, thinkingBlocks)
  }

  private pushThinkingBlocks(tabId: string, blocks: string[]): void {
    const state = this.tabs.get(tabId)
    if (!state) return
    let changed = false
    for (const text of blocks) {
      const prev = state.blocks[state.blocks.length - 1]
      // Cursor can duplicate the same reasoning chunk in adjacent updates.
      if (prev === text) continue
      state.blocks.push(text)
      changed = true
    }
    if (changed) {
      this.send('thinking:update', { tabId, total: state.blocks.length })
    }
  }
}
