import * as nodePty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { getAppConfig } from '../config/appConfig'
import type { CliTool } from './cliTools/types'
import { claudeCodeTool } from './cliTools/claudeCode'
import { cliLog } from './cliTools/cliLogger'
import type { SavedSessionEntry } from '../config/appState'


export interface SessionTabInfo {
  tabId: string
  sessionId: string | null // null until first session file appears (new sessions)
  title?: string // saved title for restore; renderer uses as initial slug
}

interface PtyTab extends SessionTabInfo {
  pty: nodePty.IPty
}

interface HealthCheck {
  buf: string
  startTime: number
  resolved: boolean
  silent: boolean // if true, dead sessions are handled silently (no IPC to renderer)
  onResult: ((result: 'ok' | 'dead') => void) | null
}

let tabIdCounter = 0
function nextTabId(): string {
  return `tab-${++tabIdCounter}`
}

export class PtyManager {
  private tabs = new Map<string, PtyTab>()
  private readonly win: BrowserWindow
  private readonly projectPath: string
  readonly tool: CliTool

  // Per-tab buffer for incomplete OSC sequences split across PTY data chunks
  private titleBufs = new Map<string, string>()
  private healthChecks = new Map<string, HealthCheck>()
  // Shared watcher for new session files (lives for the lifetime of PtyManager)
  private sharedWatcher: (() => void) | null = null
  // Cache of titles extracted from OSC sequences (main process source of truth)
  private titleCache = new Map<string, string>()
  // Previous title per tab — used to detect notable transitions via tool.detectTitleEvent
  private prevTitleCache = new Map<string, string>()

  /** Called when a tab receives a sessionId (either on resume or when a new session file appears). */
  onSessionAssigned?: (tabId: string, sessionId: string) => void
  /** Called when a tab is closed (PTY killed, tab removed from registry). */
  onTabClosed?: (tabId: string) => void
  /** When true, raw PTY data is logged to cli:log under pty-raw[tabId] channels. */
  rawLogEnabled = false

  constructor(win: BrowserWindow, projectPath: string, tool: CliTool = claudeCodeTool) {
    this.win = win
    this.projectPath = projectPath
    this.tool = tool
  }

  private debugLog(msg: string): void {
    try {
      const dbg = join(this.projectPath, '.aide', 'session-debug.log')
      appendFileSync(dbg, `${new Date().toISOString()} ${msg}\n`)
    } catch {}
  }

  /** Called on project open: restore saved sessions, or resume most recent, or start fresh. */
  async createInitialTabs(saved?: SavedSessionEntry[], activeSessionId?: string | null): Promise<{ tabs: SessionTabInfo[]; activeSessionId: string | null }> {
    await this.tool.prepareProject?.(this.projectPath)

    // If we have saved sessions from last run, restore them
    if (saved && saved.length > 0) {
      this.debugLog(`=== RESTORE: ${saved.length} saved sessions ===`)
      for (const s of saved) this.debugLog(`  saved: ${s.sessionId} "${s.title}"`)
      this.debugLog(`  activeSessionId: ${activeSessionId}`)

      const tabInfos: SessionTabInfo[] = []
      const restoreTabIds: string[] = []

      for (const entry of saved) {
        const info = this.spawnResumeTab(entry.sessionId, true) // silent = true for restore
        this.debugLog(`  spawned ${info.tabId} for session ${entry.sessionId}`)
        tabInfos.push({ ...info, title: entry.title })
        restoreTabIds.push(info.tabId)
      }

      // Wait for all health checks, then silently close dead tabs
      this.handleRestoreDeadSessions(restoreTabIds)

      return { tabs: tabInfos, activeSessionId: activeSessionId ?? saved[0].sessionId }
    }

    // Fallback: resume most recent session or start fresh
    const sessions = await this.tool.scanSessions(this.projectPath)
    if (sessions.length > 0) {
      const info = this.spawnResumeTab(sessions[0].sessionId)
      return { tabs: [info], activeSessionId: sessions[0].sessionId }
    }
    const info = this.spawnNewSessionTab()
    return { tabs: [info], activeSessionId: null }
  }

  /** After restore: wait for health checks, silently close dead tabs, spawn new if all dead. */
  private handleRestoreDeadSessions(tabIds: string[]): void {
    const pending = new Set(tabIds)
    const dead = new Set<string>()

    const check = (): void => {
      if (pending.size > 0) return // still waiting

      // Close dead tabs silently
      for (const tabId of dead) {
        this.closeTab(tabId)
        this.send('terminal:tab-closed', { tabId })
      }

      // If all tabs died, spawn a new session
      if (dead.size === tabIds.length) {
        const info = this.spawnNewSessionTab()
        this.send('terminal:new-tab', { tabId: info.tabId, sessionId: info.sessionId })
      }
    }

    for (const tabId of tabIds) {
      const hc = this.healthChecks.get(tabId)
      if (!hc) {
        pending.delete(tabId)
        continue
      }

      // Intercept the health check result
      const origOnResult = hc.onResult
      hc.onResult = (result) => {
        origOnResult?.(result)
        pending.delete(tabId)
        if (result === 'dead') dead.add(tabId)
        check()
      }
    }

    // If no health checks were pending at all
    check()
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

  /** Open a new session and write a prompt to it after init (non-blocking). */
  async createNewSessionWithPrompt(prompt: string): Promise<SessionTabInfo> {
    await this.tool.prepareProject?.(this.projectPath)
    const tabInfo = this.spawnNewSessionTab()

    // Write prompt in background after CLI is ready — don't block IPC
    this.waitForReady(tabInfo.tabId).then((result) => {
      if (result === 'ok' && this.tabs.has(tabInfo.tabId)) {
        this.write(tabInfo.tabId, prompt + '\r')
      }
    })

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

  /** Close a single tab: kill PTY, clean up caches. */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.titleBufs.delete(tabId)
    this.titleCache.delete(tabId)
    this.prevTitleCache.delete(tabId)
    this.healthChecks.delete(tabId)
    try {
      tab.pty.kill()
    } catch {}
    this.tabs.delete(tabId)
    this.onTabClosed?.(tabId)
  }

  /** Close all tabs and reopen the same sessions. Used after credential/account changes. */
  async resetAllTabs(): Promise<void> {
    // Snapshot sessions before killing
    const sessions = [...this.tabs.values()].map((t) => t.sessionId)

    // Kill every existing tab
    for (const tabId of [...this.tabs.keys()]) {
      this.closeTab(tabId)
    }

    await this.tool.prepareProject?.(this.projectPath)

    // Reopen: resume each saved session, or new if it had no sessionId
    const newTabs: { tabId: string; sessionId: string | null }[] = []
    for (const sessionId of sessions) {
      const info = sessionId
        ? this.spawnResumeTab(sessionId)
        : this.spawnNewSessionTab()
      newTabs.push({ tabId: info.tabId, sessionId: info.sessionId })
    }

    // Fallback: if there were no tabs at all, start a fresh one
    if (newTabs.length === 0) {
      const info = this.spawnNewSessionTab()
      newTabs.push({ tabId: info.tabId, sessionId: info.sessionId })
    }

    this.send('terminal:reset-tabs', newTabs)
  }

  disposeAll(): void {
    this.sharedWatcher?.()
    this.sharedWatcher = null
    for (const tab of this.tabs.values()) {
      this.titleBufs.delete(tab.tabId)
      this.prevTitleCache.delete(tab.tabId)
      this.healthChecks.delete(tab.tabId)
      try {
        tab.pty.kill()
      } catch {}
    }
    this.tabs.clear()
    this.titleCache.clear()
  }

  /** Return ordered list of active sessions (for save-on-close and reset). */
  getActiveSessions(): { tabId: string; sessionId: string | null; title: string }[] {
    return Array.from(this.tabs.values()).map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId,
      title: this.titleCache.get(t.tabId) ?? 'Claude Code'
    }))
  }

  /** Ensure the shared session-file watcher is running. */
  private ensureSharedWatcher(): void {
    if (this.sharedWatcher) return
    this.sharedWatcher = this.tool.watchForNewSessions(this.projectPath, (session) => {
      this.assignNewSession(session.sessionId)
    })
  }

  /** Assign a newly appeared sessionId to the correct tab.
   *  Always uses PID verification to avoid capturing sessions from external claude processes.
   */
  private async assignNewSession(sessionId: string): Promise<void> {
    const tabsArr = Array.from(this.tabs.values())
    if (tabsArr.length === 0) return

    if (this.tool.resolveOwnerPid) {
      const candidatePids = tabsArr.map((t) => t.pty.pid)
      const ownerPid = await this.tool.resolveOwnerPid(candidatePids)
      if (ownerPid !== null) {
        const tab = tabsArr.find((t) => t.pty.pid === ownerPid)
        if (tab) {
          this.debugLog(`assignNewSession: ${sessionId} → ${tab.tabId} (pid ${ownerPid})`)
          tab.sessionId = sessionId
          this.send('terminal:tab-session-id', { tabId: tab.tabId, sessionId })
          this.onSessionAssigned?.(tab.tabId, sessionId)
        }
      } else {
        this.debugLog(`assignNewSession: ${sessionId} — no owner found among our PIDs, ignoring (external claude?)`)
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private spawnNewSessionTab(): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId)
    const tab: PtyTab = { tabId, sessionId: null, pty }
    this.tabs.set(tabId, tab)

    this.ensureSharedWatcher()

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      pty.write(`${this.tool.newSessionCommand()}\r`)
    }, 500)

    this.startHealthCheck(tabId)

    return { tabId, sessionId: null }
  }

  private spawnResumeTab(sessionId: string, silent = false): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId)
    const tab: PtyTab = { tabId, sessionId, pty }
    this.tabs.set(tabId, tab)

    this.ensureSharedWatcher()
    this.onSessionAssigned?.(tabId, sessionId)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      pty.write(`${this.tool.resumeCommand(sessionId)}\r`)
    }, 500)

    this.startHealthCheck(tabId, silent)

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
        const prev = this.prevTitleCache.get(tabId) ?? null
        this.prevTitleCache.set(tabId, title)
        this.titleCache.set(tabId, title)
        this.send('terminal:tab-title', { tabId, title })
        const event = this.tool.detectTitleEvent?.(prev, title)
        if (event) this.send('terminal:tab-event', { tabId, event })
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
    const env = { ...process.env } as Record<string, string>
    const proxy = getAppConfig().proxy
    if (proxy.enabled && proxy.useForCliTools && proxy.address) {
      env.HTTP_PROXY = proxy.address
      env.http_proxy = proxy.address
      env.HTTPS_PROXY = proxy.address
      env.https_proxy = proxy.address
    }

    const pty = nodePty.spawn('powershell.exe', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.projectPath,
      env
    })

    pty.onData((data) => {
      this.feedHealthCheck(tabId, data)
      this.extractTitle(tabId, data)
      this.send('terminal:data', { tabId, data })
      if (this.rawLogEnabled) {
        const escaped = data.replace(/[^\x20-\x7e\t\n]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        this.send('cli:log', { channel: `pty-raw[${tabId}]`, message: escaped })
      }
    })
    pty.onExit(() => this.send('terminal:tab-exited', { tabId }))

    return pty
  }

  private startHealthCheck(tabId: string, silent = false): void {
    if (!this.tool.checkStartupHealth) return
    this.healthChecks.set(tabId, {
      buf: '',
      startTime: Date.now(),
      resolved: false,
      silent,
      onResult: null
    })
  }

  private feedHealthCheck(tabId: string, data: string): void {
    const hc = this.healthChecks.get(tabId)
    if (!hc || hc.resolved || !this.tool.checkStartupHealth) return

    hc.buf += data
    const elapsed = Date.now() - hc.startTime
const result = this.tool.checkStartupHealth(hc.buf, elapsed)

    if (result === 'pending') return

    hc.resolved = true
    this.debugLog(`  healthCheck ${tabId}: ${result} (elapsed=${elapsed}ms, silent=${hc.silent})`)
    if (result === 'dead') {
      const tab = this.tabs.get(tabId)
      this.debugLog(`  DEAD session: tabId=${tabId} sessionId=${tab?.sessionId} buf_start="${hc.buf.slice(0, 200).replace(/\n/g, '\\n')}"`)
    }
    if (result === 'ok') {
      this.send('terminal:tab-ready', { tabId })
    } else if (!hc.silent) {
      // Only notify renderer for non-silent (user-initiated) dead sessions
      const tab = this.tabs.get(tabId)
      this.send('terminal:dead-session', { tabId, sessionId: tab?.sessionId ?? null })
    }
    hc.onResult?.(result)
    this.healthChecks.delete(tabId)
  }

  private waitForReady(tabId: string): Promise<'ok' | 'dead'> {
    const hc = this.healthChecks.get(tabId)
    if (!hc) return Promise.resolve('ok') // no health check → assume ok

    if (hc.resolved) return Promise.resolve('ok')

    return new Promise((resolve) => {
      hc.onResult = resolve

      // Hard timeout — assume ok
      setTimeout(() => {
        if (!hc.resolved) {
          hc.resolved = true
          this.send('terminal:tab-ready', { tabId })
          resolve('ok')
          this.healthChecks.delete(tabId)
        }
      }, 15000)
    })
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }
}
