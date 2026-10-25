import * as nodePty from 'node-pty'
import { tabActivity } from './tabActivity'
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
import { logEvent, countPtyData } from '../diagnostics'
import { getProjectUserPath } from '../config/projectUserData'


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
  onResult: ((result: StartupResult) => void) | null
}

/** 'unknown': the CLI gave neither a ready nor a dead signal in time. */
type StartupResult = 'ok' | 'dead' | 'unknown'

/** Safety limits on event waits — never a guess that the event has happened. */
const READY_TIMEOUT_MS = 15000
const ECHO_TIMEOUT_MS = 2000
const EXIT_TIMEOUT_MS = 5000

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
      const dbg = getProjectUserPath(this.projectPath, 'session-debug.log')
      appendFileSync(dbg, `${new Date().toISOString()} ${msg}\n`)
    } catch {}
  }

  async createInitialTabs(
    selectedSessions: SavedSessionEntry[] = [],
    newToolId: string | undefined,
    activatedTools: string[] = [],
  ): Promise<{ tabs: SessionTabInfo[]; activeSessionId: string | null }> {
    this.activatedTools = activatedTools
    const restorable = selectedSessions.filter((entry) => !!entry.sessionId)
    if (restorable.length > 0) {
      this.debugLog(`=== USER RESTORE: ${restorable.length} selected ===`)
      for (const entry of restorable) this.debugLog(`  selected: ${entry.sessionId} "${entry.title}" tool=${entry.toolId}`)

      const valid = restorable.filter((entry) => {
        const tool = getToolById(entry.toolId)
        return !!tool && (tool.id === 'plain-shell' || activatedTools.includes(tool.id))
      })
      if (valid.length > 0) {
        const tabInfos: SessionTabInfo[] = []
        const restoreTabIds: string[] = []

        const toolsPrepared = new Set<string>()
        for (const entry of valid) {
          const tool = getToolById(entry.toolId)!
          if (!toolsPrepared.has(tool.id)) {
            toolsPrepared.add(tool.id)
            await tool.prepareProject?.(this.projectPath)
          }
        }

        for (const entry of valid) {
          const tool = getToolById(entry.toolId)!
          const info = this.spawnResumeTab(entry.sessionId!, true, tool)
          this.debugLog(`  spawned ${info.tabId} for session ${entry.sessionId}`)
          tabInfos.push({ ...info, title: entry.title })
          restoreTabIds.push(info.tabId)
        }

        this.handleRestoreDeadSessions(restoreTabIds, activatedTools)

        return { tabs: tabInfos, activeSessionId: valid[0].sessionId }
      }
    }

    const defaultTool = this.resolveInitialTool(newToolId, activatedTools)
    await defaultTool.prepareProject?.(this.projectPath)
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
      if (!this.tabs.has(tabInfo.tabId)) return
      if (result === 'ok') {
        void this.submitPastedInput(tabInfo.tabId, prompt.replace(/\n+/g, ' ').trim())
      } else if (result === 'unknown') {
        cliLog('startup', `${tool.name} did not report ready within ${READY_TIMEOUT_MS / 1000}s; the prompt was not sent.`)
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

  /** Bracketed-paste text into the CLI and submit it once the CLI has rendered the paste —
   *  an Enter that arrives in the same read as the paste is taken as part of it. */
  private async submitPastedInput(tabId: string, text: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tabActivity.markBusy(tabId)
    const echoed = this.nextOutput(tabId, ECHO_TIMEOUT_MS)
    tab.pty.write(`\x1b[200~${text}\x1b[201~`)
    if (!(await echoed)) {
      cliLog('startup', `${tab.toolName} did not render the pasted prompt within ${ECHO_TIMEOUT_MS / 1000}s; submitting anyway.`)
    }
    if (!this.tabs.has(tabId)) return
    tab.pty.write(tab.tool.interactiveSubmitSequence?.() ?? '\r')
  }

  /** Resolves true on the tab's next output chunk, false if none arrives within timeoutMs. */
  private nextOutput(tabId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { unsubscribe(); resolve(false) }, timeoutMs)
      const unsubscribe = this.subscribeToOutput(tabId, () => {
        clearTimeout(timer)
        unsubscribe()
        resolve(true)
      })
    })
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
    tabActivity.forget(tabId)
    try {
      tab.pty.kill()
    } catch {}
    this.tabs.delete(tabId)
    this.onTabClosed?.(tabId)
  }

  /** Close a tab and resolve once its process has exited — a CLI refuses to resume a session
   *  that is still running. Resolves false if the process outlives the timeout. */
  private closeTabAndWaitExit(tabId: string, timeoutMs = EXIT_TIMEOUT_MS): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (!tab) return Promise.resolve(true)
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      tab.pty.onExit(() => { clearTimeout(timer); resolve(true) })
    })
    this.closeTab(tabId)
    return exited
  }

  /** Restart the tool's tabs the way a user would — close the tab, then open its session again —
   *  leaving other tools' tabs untouched. The renderer is told about the replacement before the
   *  old tab goes, because it never drops its last tab. */
  async restartToolTabs(toolId: string): Promise<Array<{ oldTabId: string; newTabId: string }>> {
    const old = [...this.tabs.values()].filter((t) => t.tool.id === toolId)
    if (old.length === 0) return []

    const tool = old[0].tool
    await tool.prepareProject?.(this.projectPath)

    const replaced: Array<{ oldTabId: string; newTabId: string }> = []
    for (const tab of old) {
      const title = this.titleCache.get(tab.tabId)
      if (!(await this.closeTabAndWaitExit(tab.tabId))) {
        logEvent('pty-restart-exit-timeout', { tabId: tab.tabId, toolId }, 'warn')
      }
      const info = tab.sessionId
        ? this.spawnResumeTab(tab.sessionId, false, tool)
        : this.spawnNewSessionTab(tool)
      this.send('terminal:new-tab', { ...info, title })
      this.send('terminal:tab-closed', { tabId: tab.tabId })
      replaced.push({ oldTabId: tab.tabId, newTabId: info.tabId })
    }
    return replaced
  }

  /** Submit a message to a tab's CLI once it reports ready; false if it never did. */
  async submitWhenReady(tabId: string, text: string): Promise<boolean> {
    if ((await this.waitForReady(tabId)) !== 'ok' || !this.tabs.has(tabId)) return false
    await this.submitPastedInput(tabId, text.replace(/\n+/g, ' ').trim())
    return true
  }

  subscribeToOutput(tabId: string, cb: (data: string) => void): () => void {
    let set = this.outputListeners.get(tabId)
    if (!set) { set = new Set(); this.outputListeners.set(tabId, set) }
    set.add(cb)
    return () => { this.outputListeners.get(tabId)?.delete(cb) }
  }

  /** Number of open tabs that use the given tool. */
  countToolTabs(toolId: string): number {
    return [...this.tabs.values()].filter((t) => t.tool.id === toolId).length
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
    const pty = this.spawnPty(tabId, tool, this.launchCommand(tabId, tool, tool.newSessionCommand()))
    const tab: PtyTab = { tabId, sessionId: null, pty, tool, toolId: tool.id, toolName: tool.name }
    this.tabs.set(tabId, tab)

    this.ensureToolWatcher(tool)
    this.startHealthCheck(tabId)

    return { tabId, sessionId: null, toolId: tool.id, toolName: tool.name }
  }

  private spawnResumeTab(sessionId: string, silent = false, tool: CliTool): SessionTabInfo {
    const tabId = nextTabId()
    const pty = this.spawnPty(tabId, tool, this.launchCommand(tabId, tool, tool.resumeCommand(sessionId)))
    const tab: PtyTab = { tabId, sessionId, pty, tool, toolId: tool.id, toolName: tool.name }
    this.tabs.set(tabId, tab)

    this.ensureToolWatcher(tool)
    this.onSessionAssigned?.(tabId, sessionId, tool)
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

  /** The CLI's command line with its hook wiring, or undefined for a plain shell. */
  private launchCommand(tabId: string, tool: CliTool, cmd: string): string | undefined {
    return cmd ? `${cmd}${this.wireHooks(tabId, tool)}` : undefined
  }

  private spawnPty(tabId: string, tool?: CliTool, command?: string): nodePty.IPty {
    const env = { ...process.env } as Record<string, string>
    // Lets the pipeline MCP shim, started by the agent in this tab, identify the tab.
    env.AIDE_TAB_ID = tabId
    // AIDE's own PWD (inherited from whatever started it) would win over the PTY's cwd
    // for CLIs that read PWD, such as OpenCode; PowerShell does not set it.
    env.PWD = this.projectPath
    if (tool?.getEnvOverrides) {
      Object.assign(env, tool.getEnvOverrides())
    }

    // Register per-tab signal handler so the tool can emit events (e.g. 'completeAndWait')
    tool?.registerSignalHandler?.(tabId, (event) => {
      if (event === 'completeAndWait') tabActivity.markIdle(tabId)
      this.send('terminal:tab-event', { tabId, event })
    })

    const { file: shellFile, args: shellArgs } = defaultShell(command)
    const pty = nodePty.spawn(shellFile, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.projectPath,
      env
    })

    pty.onData((data) => {
      countPtyData(data.length)
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
    logEvent('pty-spawn', { tabId, shell: shellFile, cwd: this.projectPath, pid: pty.pid })
    pty.onExit(({ exitCode, signal }) => {
      // An exit code or signal here is the difference between "the CLI finished"
      // and "the CLI was killed", which the tab-exited event alone cannot tell.
      logEvent(
        'pty-exit',
        { tabId, pid: pty.pid, exitCode, signal: signal ?? null },
        exitCode === 0 ? 'info' : 'warn'
      )
      this.send('terminal:tab-exited', { tabId })
    })

    return pty
  }

  private startHealthCheck(tabId: string, silent = false): void {
    const tab = this.tabs.get(tabId)
    if (!tab?.tool.checkStartupHealth) return
    const hc: HealthCheck = {
      buf: '',
      startTime: Date.now(),
      resolved: false,
      silent,
      onResult: null
    }
    this.healthChecks.set(tabId, hc)
    // No verdict in time is reported as 'unknown' — never as a guessed 'ok'.
    setTimeout(() => {
      if (this.healthChecks.get(tabId) !== hc || hc.resolved) return
      hc.resolved = true
      this.debugLog(`  healthCheck ${tabId}: unknown (no verdict within ${READY_TIMEOUT_MS}ms)`)
      hc.onResult?.('unknown')
      this.healthChecks.delete(tabId)
    }, READY_TIMEOUT_MS)
  }

  private feedHealthCheck(tabId: string, data: string): void {
    const hc = this.healthChecks.get(tabId)
    const tab = this.tabs.get(tabId)
    if (!hc || hc.resolved || !tab?.tool.checkStartupHealth) return

    hc.buf += data
    const elapsed = Date.now() - hc.startTime
    const result = tab.tool.checkStartupHealth(hc.buf)

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

  /** The tab's startup verdict. A tool without a health check has nothing to wait for. */
  private waitForReady(tabId: string): Promise<StartupResult> {
    const hc = this.healthChecks.get(tabId)
    if (!hc) return Promise.resolve('ok')
    return new Promise((resolve) => { hc.onResult = resolve })
  }

  private send(channel: string, data: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }
}
