import * as nodePty from 'node-pty'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { appendFileSync } from 'fs'
import type { CliTool } from './cliTools/types'
import { getToolById, getDefaultTool } from './cliTools/registry'
import { cliLog } from './cliTools/cliLogger'
import { getHookServer } from '../hooks/hookServer'
import type { HookBinding } from '../hooks/hookServer'
import { defaultShell } from '../platform'
import type { SavedSessionEntry } from '../config/appState'
import { getAppConfig } from '../config/appConfig'


export interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  title?: string
  toolId: string
  toolName: string
}

export interface StartupTerminalOptions {
  noRestore?: boolean
  toolId?: string
}

interface PtyTab extends SessionTabInfo {
  pty: nodePty.IPty
  tool: CliTool
}

interface HealthCheck {
  buf: string
  startTime: number
  resolved: boolean
  silent: boolean
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
  private startupOptions: StartupTerminalOptions
  private readonly globalProjectStateEnabled: boolean
  private activatedTools: string[] = []

  private titleBufs = new Map<string, string>()
  private healthChecks = new Map<string, HealthCheck>()
  private toolWatchers = new Map<string, () => void>()
  private sessionAssignQueue: Promise<void> = Promise.resolve()
  private titleCache = new Map<string, string>()
  private prevTitleCache = new Map<string, string>()
  private outputListeners = new Map<string, Set<(data: string) => void>>()
  /** Last transcript_path a hook bound for a tab — used to rebind only on change. */
  private hookBoundPath = new Map<string, string>()

  onSessionAssigned?: (
    tabId: string,
    sessionId: string,
    tool: CliTool,
    transcriptPath?: string | null
  ) => void
  onTabClosed?: (tabId: string) => void
  rawLogEnabled = false

  constructor(
    win: BrowserWindow,
    projectPath: string,
    startupOptions: StartupTerminalOptions = {},
    globalProjectStateEnabled = true
  ) {
    this.win = win
    this.projectPath = projectPath
    this.startupOptions = startupOptions
    this.globalProjectStateEnabled = globalProjectStateEnabled
  }

  consumeStartupOptions(): StartupTerminalOptions {
    const options = this.startupOptions
    this.startupOptions = {}
    return options
  }

  isGlobalProjectStateEnabled(): boolean {
    return this.globalProjectStateEnabled
  }

  private debugLog(msg: string): void {
    try {
      const dbg = join(this.projectPath, '.aide', 'session-debug.log')
      appendFileSync(dbg, `${new Date().toISOString()} ${msg}\n`)
    } catch {}
  }

  async createInitialTabs(
    saved?: SavedSessionEntry[],
    activeSessionId?: string | null,
    activatedTools: string[] = [],
    options: StartupTerminalOptions = {},
    maxRestore = 5
  ): Promise<{ tabs: SessionTabInfo[]; activeSessionId: string | null }> {
    this.activatedTools = activatedTools
    const selectedTool = this.resolveInitialTool(options.toolId, activatedTools)
    if (options.noRestore) {
      await selectedTool.prepareProject?.(this.projectPath)
      const info = this.spawnNewSessionTab(selectedTool)
      return { tabs: [info], activeSessionId: null }
    }

    if (saved && saved.length > 0) {
      // Only tabs that actually own a session are restorable; a tab without a
      // session (never assigned one) is dropped rather than reopened as blank.
      const restorable = saved.filter((s) => !!s.sessionId)
      // Restore the N most recent restorable tabs (the tail of the list), plus
      // the active tab if it fell outside that window. maxRestore <= 0 means
      // "restore none" → fall through to a default session.
      const keep = new Set(
        (maxRestore > 0 ? restorable.slice(-maxRestore) : []).map((e) => e.sessionId)
      )
      if (maxRestore > 0 && activeSessionId) keep.add(activeSessionId)
      // Filter the full restorable list so surviving tabs keep their original order.
      const limited = restorable.filter((e) => keep.has(e.sessionId))

      this.debugLog(`=== RESTORE: ${saved.length} saved, ${restorable.length} with a session, restoring ${limited.length} (max ${maxRestore}) ===`)
      for (const s of saved) this.debugLog(`  saved: ${s.sessionId} "${s.title}" tool=${s.toolId}`)
      this.debugLog(`  activeSessionId: ${activeSessionId}`)

      if (limited.length > 0) {
        const tabInfos: SessionTabInfo[] = []
        const restoreTabIds: string[] = []

        // Collect unique tools that need prepareProject
        const toolsPrepared = new Set<string>()
        for (const entry of limited) {
          const tool = getToolById(entry.toolId) ?? getDefaultTool(activatedTools)
          if (!toolsPrepared.has(tool.id)) {
            toolsPrepared.add(tool.id)
            await tool.prepareProject?.(this.projectPath)
          }
        }

        for (const entry of limited) {
          const tool = getToolById(entry.toolId) ?? getDefaultTool(activatedTools)
          const info = this.spawnResumeTab(entry.sessionId!, true, tool)
          this.debugLog(`  spawned ${info.tabId} for session ${entry.sessionId}`)
          tabInfos.push({ ...info, title: entry.title })
          restoreTabIds.push(info.tabId)
        }

        this.handleRestoreDeadSessions(restoreTabIds, activatedTools)

        // Keep the saved active session only if it survived the trim; otherwise
        // fall back to the first restored tab.
        const restoredIds = new Set(limited.map((e) => e.sessionId))
        const resolvedActive =
          activeSessionId && restoredIds.has(activeSessionId) ? activeSessionId : limited[0].sessionId
        return { tabs: tabInfos, activeSessionId: resolvedActive }
      }

      // Nothing restorable → fall through to the default session startup below.
    }

    const defaultTool = selectedTool
    await defaultTool.prepareProject?.(this.projectPath)

    const sessions = await defaultTool.scanSessions(this.projectPath)
    if (sessions.length > 0) {
      const info = this.spawnResumeTab(sessions[0].sessionId, false, defaultTool)
      return { tabs: [info], activeSessionId: sessions[0].sessionId }
    }
    const info = this.spawnNewSessionTab(defaultTool)
    return { tabs: [info], activeSessionId: null }
  }

  private resolveInitialTool(toolId: string | undefined, activatedTools: string[]): CliTool {
    if (toolId) {
      const tool = getToolById(toolId)
      if (tool) return tool
      cliLog('startup', `Unknown CLI tool id "${toolId}". Falling back to the default CLI.`)
    }
    return getDefaultTool(activatedTools)
  }

  private handleRestoreDeadSessions(tabIds: string[], activatedTools: string[]): void {
    const pending = new Set(tabIds)
    const dead = new Set<string>()

    const check = (): void => {
      if (pending.size > 0) return

      for (const tabId of dead) {
        this.closeTab(tabId)
        this.send('terminal:tab-closed', { tabId })
      }

      if (dead.size === tabIds.length) {
        const defaultTool = getDefaultTool(activatedTools)
        const info = this.spawnNewSessionTab(defaultTool)
        this.send('terminal:new-tab', { tabId: info.tabId, sessionId: info.sessionId, toolId: info.toolId, toolName: info.toolName })
      }
    }

    for (const tabId of tabIds) {
      const hc = this.healthChecks.get(tabId)
      if (!hc) {
        pending.delete(tabId)
        continue
      }

      const origOnResult = hc.onResult
      hc.onResult = (result) => {
        origOnResult?.(result)
        pending.delete(tabId)
        if (result === 'dead') dead.add(tabId)
        check()
      }
    }

    check()
  }

  async createNewSessionTab(toolId?: string, activatedTools: string[] = []): Promise<SessionTabInfo> {
    const tool = (toolId ? getToolById(toolId) : undefined) ?? getDefaultTool(activatedTools)
    await tool.prepareProject?.(this.projectPath)
    return this.spawnNewSessionTab(tool)
  }

  async resumeSessionTab(sessionId: string, toolId?: string, activatedTools: string[] = []): Promise<SessionTabInfo> {
    const tool = (toolId ? getToolById(toolId) : undefined) ?? getDefaultTool(activatedTools)
    await tool.prepareProject?.(this.projectPath)
    return this.spawnResumeTab(sessionId, false, tool)
  }

  async createNewSessionWithPrompt(prompt: string, toolId?: string, activatedTools: string[] = []): Promise<SessionTabInfo> {
    const tool = (toolId ? getToolById(toolId) : undefined) ?? getDefaultTool(activatedTools)
    await tool.prepareProject?.(this.projectPath)
    const tabInfo = this.spawnNewSessionTab(tool)

    this.waitForReady(tabInfo.tabId).then((result) => {
      if (result === 'ok' && this.tabs.has(tabInfo.tabId)) {
        void this.submitInteractiveInput(tabInfo.tabId, prompt.replace(/\n+/g, ' ').trim(), 'paste')
      }
    })

    return tabInfo
  }

  getTabs(): SessionTabInfo[] {
    return Array.from(this.tabs.values()).map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId,
      toolId: t.toolId,
      toolName: t.toolName
    }))
  }

  write(tabId: string, data: string): void {
    try {
      this.tabs.get(tabId)?.pty.write(data)
    } catch {}
  }

  /** Type and submit text to the active CLI using its terminal keyboard protocol. */
  async submitInteractiveInput(tabId: string, text: string, mode: 'type' | 'paste' = 'type'): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Terminal tab not found')
    if (mode === 'paste') {
      const pasted = `\x1b[200~${text}\x1b[201~`
      tab.pty.write(pasted)
    } else {
      for (const char of Array.from(text)) {
        tab.pty.write(char)
        await new Promise((resolve) => setTimeout(resolve, 35))
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const submit = tab.tool.interactiveSubmitSequence?.() ?? '\r'
    tab.pty.write(submit)
  }

  resize(tabId: string, cols: number, rows: number): void {
    try {
      if (cols > 0 && rows > 0) {
        this.tabs.get(tabId)?.pty.resize(cols, rows)
      }
    } catch {}
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.tool.deregisterTab?.(tabId)
    this.unwireHooks(tabId)
    this.titleBufs.delete(tabId)
    this.titleCache.delete(tabId)
    this.prevTitleCache.delete(tabId)
    this.healthChecks.delete(tabId)
    this.outputListeners.delete(tabId)
    try {
      tab.pty.kill()
    } catch {}
    this.tabs.delete(tabId)
    this.onTabClosed?.(tabId)
  }

  /** Exit the interactive CLI while preserving the PowerShell PTY and renderer tab. */
  async suspendCli(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Terminal tab not found')
    const command = tab.tool.exitCommand?.()
    if (!command || !tab.tool.resolveOwnerPid) {
      throw new Error(`${tab.tool.name} cannot be suspended for Smart Compact`)
    }

    await this.submitInteractiveInput(tabId, command, 'type')
    const deadline = Date.now() + 15_000
    let consecutiveMissing = 0
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const owner = await tab.tool.resolveOwnerPid([tab.pty.pid])
      if (owner === null) {
        consecutiveMissing++
        if (consecutiveMissing >= 2) return
      } else {
        consecutiveMissing = 0
      }
    }
    throw new Error(`${tab.tool.name} did not exit within 15 seconds`)
  }

  /** Resume a session in the existing PowerShell PTY and renderer tab. */
  resumeCli(tabId: string, sessionId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('Terminal tab not found')
    const command = tab.tool.resumeCommand(sessionId)
    if (!command) throw new Error(`${tab.tool.name} cannot resume this session`)
    this.startHealthCheck(tabId)
    tab.pty.write(`${command}${this.wireHooks(tabId, tab.tool)}\r`)
    this.onSessionAssigned?.(tabId, sessionId, tab.tool)
  }

  async resetAllTabs(): Promise<void> {
    const sessions = [...this.tabs.values()].map((t) => ({
      sessionId: t.sessionId,
      tool: t.tool
    }))

    for (const tabId of [...this.tabs.keys()]) {
      this.closeTab(tabId)
    }

    const uniqueToolIds = new Set(sessions.map((s) => s.tool.id))
    for (const toolId of uniqueToolIds) {
      const tool = getToolById(toolId)
      await tool?.prepareProject?.(this.projectPath)
    }

    const newTabs: SessionTabInfo[] = []
    for (const { sessionId, tool } of sessions) {
      const info = sessionId
        ? this.spawnResumeTab(sessionId, false, tool)
        : this.spawnNewSessionTab(tool)
      newTabs.push(info)
    }

    if (newTabs.length === 0) {
      const info = this.spawnNewSessionTab(getDefaultTool(this.activatedTools))
      newTabs.push(info)
    }

    this.send('terminal:reset-tabs', newTabs)
  }

  subscribeToOutput(tabId: string, cb: (data: string) => void): () => void {
    let set = this.outputListeners.get(tabId)
    if (!set) { set = new Set(); this.outputListeners.set(tabId, set) }
    set.add(cb)
    return () => { this.outputListeners.get(tabId)?.delete(cb) }
  }

  /** Returns true if any open tab uses the given tool. */
  hasTool(toolId: string): boolean {
    return [...this.tabs.values()].some((t) => t.tool.id === toolId)
  }

  disposeAll(): void {
    for (const unsub of this.toolWatchers.values()) unsub()
    this.toolWatchers.clear()
    for (const tab of this.tabs.values()) {
      tab.tool.deregisterTab?.(tab.tabId)
      this.unwireHooks(tab.tabId)
      this.titleBufs.delete(tab.tabId)
      this.prevTitleCache.delete(tab.tabId)
      this.healthChecks.delete(tab.tabId)
      try {
        tab.pty.kill()
      } catch {}
    }
    this.tabs.clear()
    this.titleCache.clear()
    this.outputListeners.clear()
  }

  getActiveSessions(): { tabId: string; sessionId: string | null; title: string; toolId: string }[] {
    return Array.from(this.tabs.values()).map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId,
      title: this.titleCache.get(t.tabId) ?? t.tool.name,
      toolId: t.tool.id
    }))
  }

  private ensureToolWatcher(tool: CliTool): void {
    if (this.toolWatchers.has(tool.id)) return
    const unsub = tool.watchForNewSessions(this.projectPath, (session) => {
      this.sessionAssignQueue = this.sessionAssignQueue.then(() =>
        this.assignNewSession(session.sessionId, tool)
      )
    })
    this.toolWatchers.set(tool.id, unsub)
  }

  private async assignNewSession(sessionId: string, tool: CliTool): Promise<void> {
    // Only consider tabs belonging to this specific tool
    const tabsArr = Array.from(this.tabs.values()).filter((t) => t.tool.id === tool.id)
    if (tabsArr.length === 0) return

    // Fast path: if exactly one tab has no session yet, assign to it directly.
    // This avoids relying on WMI process-tree queries which can lag by 1-2 s on
    // Windows, causing the new session to be misassigned to a tab that already
    // has a session but whose claude.exe happens to be the only one visible.
    const waitingTabs = tabsArr.filter((t) => t.sessionId === null)
    if (waitingTabs.length === 1) {
      const tab = waitingTabs[0]
      this.debugLog(`assignNewSession: ${sessionId} → ${tab.tabId} (sole waiting tab)`)
      tab.sessionId = sessionId
      this.send('terminal:tab-session-id', { tabId: tab.tabId, sessionId })
      this.onSessionAssigned?.(tab.tabId, sessionId, tab.tool)
      return
    }

    // Ambiguous case (0 or >1 waiting tabs): deterministic binding is handled by
    // Claude Code hooks (handleHookBinding), which carry the authoritative
    // tabId + transcript_path. We no longer walk the process tree here — that
    // heuristic mis-assigned under concurrency and was Windows-only.
    this.debugLog(`assignNewSession: ${sessionId} — deferring to hook binding (${waitingTabs.length} waiting tabs)`)
  }

  /** Authoritative binding from a Claude Code hook. Rebinds only when the
   *  session or transcript actually changes (so a same-session Stop is a no-op). */
  private handleHookBinding(b: HookBinding): void {
    const tab = this.tabs.get(b.tabId)
    if (!tab || !b.sessionId) return

    const prevPath = this.hookBoundPath.get(b.tabId)
    const changed = tab.sessionId !== b.sessionId || prevPath !== (b.transcriptPath ?? undefined)
    if (!changed) return

    if (tab.sessionId !== b.sessionId) {
      tab.sessionId = b.sessionId
      this.send('terminal:tab-session-id', { tabId: b.tabId, sessionId: b.sessionId })
    }
    if (b.transcriptPath) this.hookBoundPath.set(b.tabId, b.transcriptPath)
    this.debugLog(`hook bind: ${b.event} ${b.tabId} → ${b.sessionId} @ ${b.transcriptPath ?? '?'}`)
    this.onSessionAssigned?.(b.tabId, b.sessionId, tab.tool, b.transcriptPath)
  }

  /** Register a tab with the hook server and return the tool's launch args
   *  (e.g. ` --settings "<file>"`) that wire its hooks back to us. */
  private wireHooks(tabId: string, tool: CliTool): string {
    const hs = getHookServer()
    if (!hs || hs.getPort() === 0 || !tool.hookLaunchArgs) return ''
    hs.register(tabId, (b) => this.handleHookBinding(b))
    return tool.hookLaunchArgs({ tabId, hookPort: hs.getPort(), hookToken: hs.getToken() })
  }

  private unwireHooks(tabId: string): void {
    getHookServer()?.unregister(tabId)
    this.hookBoundPath.delete(tabId)
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private spawnNewSessionTab(tool: CliTool): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId, tool)
    const tab: PtyTab = { tabId, sessionId: null, pty, tool, toolId: tool.id, toolName: tool.name }
    this.tabs.set(tabId, tab)

    this.ensureToolWatcher(tool)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      const cmd = tool.newSessionCommand()
      if (cmd) pty.write(`${cmd}${this.wireHooks(tabId, tool)}\r`)
    }, 500)

    this.startHealthCheck(tabId)

    return { tabId, sessionId: null, toolId: tool.id, toolName: tool.name }
  }

  private spawnResumeTab(sessionId: string, silent = false, tool: CliTool): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId, tool)
    const tab: PtyTab = { tabId, sessionId, pty, tool, toolId: tool.id, toolName: tool.name }
    this.tabs.set(tabId, tab)

    this.ensureToolWatcher(tool)
    this.onSessionAssigned?.(tabId, sessionId, tool)

    setTimeout(() => {
      if (!this.tabs.has(tabId)) return
      const cmd = tool.resumeCommand(sessionId)
      if (cmd) pty.write(`${cmd}${this.wireHooks(tabId, tool)}\r`)
    }, 500)

    this.startHealthCheck(tabId, silent)

    return { tabId, sessionId, toolId: tool.id, toolName: tool.name }
  }

  private extractTitle(tabId: string, data: string): void {
    const buf = (this.titleBufs.get(tabId) ?? '') + data

    const m = /\x1b\](?:0|2);([^\x07\x1b]*)\x07/.exec(buf)
           ?? /\x1b\](?:0|2);([^\x1b]*)\x1b\\/.exec(buf)

    if (m?.[1]) {
      const title = m[1].trim()
      if (title) {
        const tab = this.tabs.get(tabId)
        const prev = this.prevTitleCache.get(tabId) ?? null
        this.prevTitleCache.set(tabId, title)
        this.titleCache.set(tabId, title)
        this.send('terminal:tab-title', { tabId, title })
        tab?.tool.detectTitleEvent?.(tabId, prev, title)
      }
      this.titleBufs.delete(tabId)
    } else {
      const oscStart = buf.lastIndexOf('\x1b]')
      if (oscStart !== -1 && buf.length - oscStart < 512) {
        this.titleBufs.set(tabId, buf.slice(oscStart))
      } else {
        this.titleBufs.delete(tabId)
      }
    }
  }

  private spawnPty(tabId: string, tool?: CliTool): nodePty.IPty {
    const env = { ...process.env } as Record<string, string>
    if (tool?.getEnvOverrides) {
      Object.assign(env, tool.getEnvOverrides())
    }

    // Register per-tab signal handler so the tool can emit events (e.g. 'completeAndWait')
    tool?.registerSignalHandler?.(tabId, (event) =>
      this.send('terminal:tab-event', { tabId, event })
    )

    const { file: shellFile, args: shellArgs } = defaultShell()
    const pty = nodePty.spawn(shellFile, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.projectPath,
      env
    })

    pty.onData((data) => {
      this.feedHealthCheck(tabId, data)
      this.extractTitle(tabId, data)
      tool?.onPtyActivity?.(tabId)
      this.outputListeners.get(tabId)?.forEach((cb) => cb(data))
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
    const tab = this.tabs.get(tabId)
    if (!tab?.tool.checkStartupHealth) return
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
    const tab = this.tabs.get(tabId)
    if (!hc || hc.resolved || !tab?.tool.checkStartupHealth) return

    hc.buf += data
    const elapsed = Date.now() - hc.startTime
    const result = tab.tool.checkStartupHealth(hc.buf, elapsed)

    if (result === 'pending') return

    hc.resolved = true
    this.debugLog(`  healthCheck ${tabId}: ${result} (elapsed=${elapsed}ms, silent=${hc.silent})`)
    if (result === 'dead') {
      this.debugLog(`  DEAD session: tabId=${tabId} sessionId=${tab?.sessionId} buf_start="${hc.buf.slice(0, 200).replace(/\n/g, '\\n')}"`)
    }
    if (result === 'ok') {
      this.send('terminal:tab-ready', { tabId })
    } else if (!hc.silent) {
      this.send('terminal:dead-session', { tabId, sessionId: tab?.sessionId ?? null })
    }
    hc.onResult?.(result)
    this.healthChecks.delete(tabId)
  }

  private waitForReady(tabId: string): Promise<'ok' | 'dead'> {
    const hc = this.healthChecks.get(tabId)
    if (!hc) return Promise.resolve('ok')

    if (hc.resolved) return Promise.resolve('ok')

    return new Promise((resolve) => {
      hc.onResult = resolve

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
