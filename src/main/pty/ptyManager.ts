import * as nodePty from 'node-pty'
import { BrowserWindow } from 'electron'
import type { CliTool } from './cliTools/types'
import { claudeCodeTool } from './cliTools/claudeCode'


export interface SessionTabInfo {
  tabId: string
  sessionId: string | null // null until first session file appears (new sessions)
}

interface PtyTab extends SessionTabInfo {
  pty: nodePty.IPty
  stopDirWatch?: () => void
}

let tabIdCounter = 0
function nextTabId(): string {
  return `tab-${++tabIdCounter}`
}

export class PtyManager {
  private tabs = new Map<string, PtyTab>()
  private readonly win: BrowserWindow
  private readonly projectPath: string
  private readonly tool: CliTool

  // Per-tab buffer for incomplete OSC sequences split across PTY data chunks
  private titleBufs = new Map<string, string>()

  constructor(win: BrowserWindow, projectPath: string, tool: CliTool = claudeCodeTool) {
    this.win = win
    this.projectPath = projectPath
    this.tool = tool
  }

  /** Called on project open: resume most recent session or start fresh. */
  async createInitialTab(): Promise<SessionTabInfo> {
    await this.tool.prepareProject?.(this.projectPath)
    const sessions = await this.tool.scanSessions(this.projectPath)
    if (sessions.length > 0) {
      return this.spawnResumeTab(sessions[0].sessionId)
    }
    return this.spawnNewSessionTab()
  }

  /** Open a brand-new session tab. */
  async createNewSessionTab(): Promise<SessionTabInfo> {
    await this.tool.prepareProject?.(this.projectPath)
    return this.spawnNewSessionTab()
  }

  /** Resume an existing session by ID. */
  async resumeSessionTab(sessionId: string): Promise<SessionTabInfo> {
    await this.tool.prepareProject?.(this.projectPath)
    return this.spawnResumeTab(sessionId)
  }

  /** Open a new session and write a prompt to it after init. */
  async createNewSessionWithPrompt(prompt: string): Promise<SessionTabInfo> {
    await this.tool.prepareProject?.(this.projectPath)
    const tabInfo = this.spawnNewSessionTab()

    // Write prompt after the tool has had time to start (1.5s after the 0.5s newSessionCommand delay)
    setTimeout(() => {
      if (!this.tabs.has(tabInfo.tabId)) return
      this.write(tabInfo.tabId, prompt + '\r')
    }, 2000)

    return tabInfo
  }

  /** Get snapshot of all open tabs (safe to serialize). */
  getTabs(): SessionTabInfo[] {
    return Array.from(this.tabs.values()).map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId
    }))
  }

  write(tabId: string, data: string): void {
    try {
      this.tabs.get(tabId)?.pty.write(data)
    } catch {}
  }

  resize(tabId: string, cols: number, rows: number): void {
    try {
      if (cols > 0 && rows > 0) {
        this.tabs.get(tabId)?.pty.resize(cols, rows)
      }
    } catch {}
  }

  /** Close a single tab: kill PTY, clean up watchers. */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.stopDirWatch?.()
    this.titleBufs.delete(tabId)
    try {
      tab.pty.kill()
    } catch {}
    this.tabs.delete(tabId)
  }

  disposeAll(): void {
    for (const tab of this.tabs.values()) {
      tab.stopDirWatch?.()
      this.titleBufs.delete(tab.tabId)
      try {
        tab.pty.kill()
      } catch {}
    }
    this.tabs.clear()
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private spawnNewSessionTab(): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId)
    const tab: PtyTab = { tabId, sessionId: null, pty }
    this.tabs.set(tabId, tab)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      pty.write(`${this.tool.newSessionCommand()}\r`)

      // Watch for the new session file (gives us the session ID)
      tab.stopDirWatch = this.tool.watchForNewSessions(this.projectPath, (session) => {
        const t = this.tabs.get(tabId)
        if (!t || t.sessionId) return // already registered

        t.sessionId = session.sessionId
        this.send('terminal:tab-session-id', { tabId, sessionId: session.sessionId })

        // Stop watching — we got our session
        t.stopDirWatch?.()
        t.stopDirWatch = undefined
      })
    }, 500)

    return { tabId, sessionId: null }
  }

  private spawnResumeTab(sessionId: string): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId)
    const tab: PtyTab = { tabId, sessionId, pty }
    this.tabs.set(tabId, tab)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      pty.write(`${this.tool.resumeCommand(sessionId)}\r`)
    }, 500)

    return { tabId, sessionId }
  }

  /** Parse OSC 0/2 title sequences from raw PTY data and notify renderer.
   *  Buffers partial sequences across chunks since node-pty can split them arbitrarily.
   */
  private extractTitle(tabId: string, data: string): void {
    // Prepend any buffered partial sequence from the previous chunk
    const buf = (this.titleBufs.get(tabId) ?? '') + data

    // Match OSC 0 or 2 with BEL (\x07) or ST (\x1b\) terminator
    const m = /\x1b\](?:0|2);([^\x07\x1b]*)\x07/.exec(buf)
           ?? /\x1b\](?:0|2);([^\x1b]*)\x1b\\/.exec(buf)

    if (m?.[1]) {
      const title = m[1].trim()
      if (title) {
        this.send('terminal:tab-title', { tabId, title })
      }
      this.titleBufs.delete(tabId)
    } else {
      // No complete sequence yet — check if there's a partial OSC at the end
      const oscStart = buf.lastIndexOf('\x1b]')
      if (oscStart !== -1 && buf.length - oscStart < 512) {
        // Buffer the partial sequence (512-char limit to avoid memory bloat)
        this.titleBufs.set(tabId, buf.slice(oscStart))
      } else {
        this.titleBufs.delete(tabId)
      }
    }
  }

  private spawnPty(tabId: string): nodePty.IPty {
    const pty = nodePty.spawn('powershell.exe', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.projectPath,
      env: process.env as Record<string, string>
    })

    pty.onData((data) => {
      this.extractTitle(tabId, data)
      this.send('terminal:data', { tabId, data })
    })
    pty.onExit(() => this.send('terminal:tab-exited', { tabId }))

    return pty
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }
}
