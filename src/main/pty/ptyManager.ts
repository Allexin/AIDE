import * as nodePty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import {
  scanSessions,
  getSessionsDir,
  watchSessionsDir,
  watchJsonlFile,
  readSlugFromJsonl
} from './sessionScanner'

export interface SessionTabInfo {
  tabId: string
  sessionId: string | null // null until first .jsonl appears (new sessions)
  slug: string // 'Claude Code' until slug appears in JSONL
}

interface PtyTab extends SessionTabInfo {
  pty: nodePty.IPty
  stopDirWatch?: () => void
  stopJsonlWatch?: () => void
}

let tabIdCounter = 0
function nextTabId(): string {
  return `tab-${++tabIdCounter}`
}

export class PtyManager {
  private tabs = new Map<string, PtyTab>()
  private readonly win: BrowserWindow
  private readonly projectPath: string
  private readonly sessionsDir: string

  constructor(win: BrowserWindow, projectPath: string) {
    this.win = win
    this.projectPath = projectPath
    this.sessionsDir = getSessionsDir(projectPath)
  }

  /** Called on project open: resume most recent session or start fresh. */
  async createInitialTab(): Promise<SessionTabInfo> {
    const sessions = await scanSessions(this.projectPath)
    if (sessions.length > 0) {
      const newest = sessions[0]
      return this.spawnResumeTab(newest.sessionId, newest.slug)
    }
    return this.spawnNewSessionTab()
  }

  /** Open a brand-new claude session tab. */
  async createNewSessionTab(): Promise<SessionTabInfo> {
    return this.spawnNewSessionTab()
  }

  /** Resume an existing session by ID. */
  async resumeSessionTab(sessionId: string): Promise<SessionTabInfo> {
    const sessions = await scanSessions(this.projectPath)
    const existing = sessions.find((s) => s.sessionId === sessionId)
    return this.spawnResumeTab(sessionId, existing?.slug || null)
  }

  /** Get snapshot of all open tabs (safe to serialize). */
  getTabs(): SessionTabInfo[] {
    return Array.from(this.tabs.values()).map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId,
      slug: t.slug
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

  disposeAll(): void {
    for (const tab of this.tabs.values()) {
      tab.stopDirWatch?.()
      tab.stopJsonlWatch?.()
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
    const tab: PtyTab = { tabId, sessionId: null, slug: 'Claude Code', pty }
    this.tabs.set(tabId, tab)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      pty.write('claude\r')

      // Watch for the new .jsonl file (gives us the session ID)
      tab.stopDirWatch = watchSessionsDir(this.sessionsDir, (newSessionId, slugFromDir) => {
        const t = this.tabs.get(tabId)
        if (!t || t.sessionId) return // already registered

        t.sessionId = newSessionId
        this.send('terminal:tab-session-id', { tabId, sessionId: newSessionId })

        const resolvedSlug = slugFromDir || readSlugFromJsonl(join(this.sessionsDir, `${newSessionId}.jsonl`))
        if (resolvedSlug) {
          t.slug = resolvedSlug
          this.send('terminal:tab-slug-updated', { tabId, slug: resolvedSlug })
        } else {
          // Watch the specific JSONL file for the slug
          t.stopJsonlWatch = watchJsonlFile(
            join(this.sessionsDir, `${newSessionId}.jsonl`),
            (slug) => {
              const tt = this.tabs.get(tabId)
              if (!tt) return
              tt.slug = slug
              this.send('terminal:tab-slug-updated', { tabId, slug })
            }
          )
        }

        // Stop watching the directory — we got our session
        t.stopDirWatch?.()
        t.stopDirWatch = undefined
      })
    }, 500)

    return { tabId, sessionId: null, slug: 'Claude Code' }
  }

  private spawnResumeTab(sessionId: string, slug: string | null): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId)
    const resolvedSlug = slug || 'Claude Code'
    const tab: PtyTab = { tabId, sessionId, slug: resolvedSlug, pty }
    this.tabs.set(tabId, tab)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      pty.write(`claude --resume ${sessionId}\r`)

      // Watch for slug if we don't have it yet
      if (!slug) {
        tab.stopJsonlWatch = watchJsonlFile(
          join(this.sessionsDir, `${sessionId}.jsonl`),
          (foundSlug) => {
            const t = this.tabs.get(tabId)
            if (!t) return
            t.slug = foundSlug
            this.send('terminal:tab-slug-updated', { tabId, slug: foundSlug })
          }
        )
      }
    }, 500)

    return { tabId, sessionId, slug: resolvedSlug }
  }

  private spawnPty(tabId: string): nodePty.IPty {
    const pty = nodePty.spawn('powershell.exe', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.projectPath,
      env: process.env as Record<string, string>
    })

    pty.onData((data) => this.send('terminal:data', { tabId, data }))
    pty.onExit(() => this.send('terminal:tab-exited', { tabId }))

    return pty
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }
}
