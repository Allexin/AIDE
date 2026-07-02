/**
 * OpenCode CLI tool integration.
 *
 * OpenCode (https://opencode.ai) is a TUI-based AI coding assistant.
 *
 * Session storage: SQLite database at ~/.local/share/opencode/opencode.db
 * ProjectID: first git root-commit hash, cached in <project>/.git/opencode.
 * Active model: read from ~/.config/opencode/opencode.json and shown in status bar.
 */

import { existsSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { join } from 'path'
import type { CliTool, CliSession, UsageInfo, SettingsField, HistoryEntry } from './types'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import { cliLog } from './cliLogger'
import {
  getOpenCodeDataDir,
  scanOpenCodeSessions,
  readOpenCodeSessionHistory,
  readOpenCodeSessionPreview,
  watchOpenCodeSessions,
  watchOpenCodeMessages
} from './openCodeScanner'

const TOOL_ID = 'open-code'
const TOOL_NAME = 'OpenCode'
const LOG_CH = 'OpenCode'

const INACTIVITY_THRESHOLD = 5 // seconds of silence → signal "waiting for input"

// ── Inactivity-based completion signal ───────────────────────────────────────
// OpenCode's TUI does not emit OSC title events when it finishes responding.
// We use an inactivity timer: if the PTY produces no output for
// INACTIVITY_THRESHOLD seconds we emit 'completeAndWait' (same as Qwen Code).

interface InactivityState {
  counter: number
  interval: ReturnType<typeof setInterval>
}
const inactivityByTab = new Map<string, InactivityState>()
const signalByTab = new Map<string, (event: string) => void>()

function ensureInactivityTimer(tabId: string): void {
  const existing = inactivityByTab.get(tabId)
  if (existing) {
    existing.counter = INACTIVITY_THRESHOLD
    return
  }
  const state: InactivityState = {
    counter: INACTIVITY_THRESHOLD,
    interval: setInterval(() => {
      state.counter--
      if (state.counter === 0) {
        signalByTab.get(tabId)?.('completeAndWait')
      }
    }, 1000)
  }
  inactivityByTab.set(tabId, state)
}

function cleanupTab(tabId: string): void {
  const state = inactivityByTab.get(tabId)
  if (state) {
    clearInterval(state.interval)
    inactivityByTab.delete(tabId)
  }
  signalByTab.delete(tabId)
}

// ── Config helpers ────────────────────────────────────────────────────────────

interface OpenCodeConfig {
  model?: string
  provider?: Record<string, unknown>
  [key: string]: unknown
}

function configPath(): string {
  const { homedir } = require('os') as typeof import('os')
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'opencode')
    : join(homedir(), '.config', 'opencode')
  return join(configDir, 'opencode.json')
}

function readConfig(): OpenCodeConfig | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as OpenCodeConfig
  } catch {
    return null
  }
}

// ── Tool implementation ───────────────────────────────────────────────────────

export const openCodeTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,
  installUrl: 'https://opencode.ai',

  // ── Install check ─────────────────────────────────────────────────────────

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('where', ['opencode'], { timeout: 3000 }, (err) => resolve(!err))
    })
  },

  // ── Commands ──────────────────────────────────────────────────────────────

  newSessionCommand(): string {
    return 'opencode'
  },

  resumeCommand(sessionId: string): string {
    return `opencode --session ${sessionId}`
  },

  // ── Startup health ────────────────────────────────────────────────────────

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (
      accumulated.includes('command not found') ||
      accumulated.includes('is not recognized') ||
      accumulated.includes('Cannot find module')
    ) return 'dead'

    // OpenCode renders its TUI with ANSI escape sequences immediately on start.
    // Detecting CSI (ESC + "[") or the product name confirms the TUI is live.
    if (
      accumulated.includes('\x1b[') ||
      accumulated.includes('opencode') ||
      accumulated.includes('OpenCode')
    ) return 'ok'

    if (elapsedMs > 15000) return 'ok'
    return 'pending'
  },

  // ── Sessions (SQLite) ─────────────────────────────────────────────────────

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const rows = scanOpenCodeSessions(projectPath)
    return rows.map((r) => ({
      sessionId: r.sessionId,
      slug: r.title || r.slug || TOOL_NAME,
      firstMessage: r.title || undefined,
      lastModified: new Date(r.timeUpdated)
    }))
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    const knownIds = new Set<string>()

    // Seed known IDs from current scan so we only emit genuinely NEW sessions
    const existing = scanOpenCodeSessions(projectPath)
    for (const s of existing) knownIds.add(s.sessionId)

    return watchOpenCodeSessions(projectPath, knownIds, (s) => {
      onNew({
        sessionId: s.sessionId,
        slug: s.title || s.slug || TOOL_NAME,
        firstMessage: s.title || undefined,
        lastModified: new Date(s.timeUpdated)
      })
    })
  },

  // ── Session history ───────────────────────────────────────────────────────

  async getSessionPreview(
    _projectPath: string,
    sessionId: string
  ): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    return readOpenCodeSessionPreview(sessionId)
  },

  async getSessionHistory(_projectPath: string, sessionId: string): Promise<HistoryEntry[]> {
    return readOpenCodeSessionHistory(sessionId)
  },

  subscribeToSessionHistory(
    _projectPath: string,
    sessionId: string,
    onEntry: (entry: HistoryEntry) => void
  ): () => void {
    return watchOpenCodeMessages(sessionId, onEntry)
  },

  // getSessionFilePath — not applicable; OpenCode uses SQLite, not a single file.

  // ── Context insert ────────────────────────────────────────────────────────

  contextInsert(relPath: string): string {
    // OpenCode uses "@" prefix for fuzzy file references, same as Claude Code
    return `@${relPath}`
  },

  // ── PTY activity / completion signal ─────────────────────────────────────

  onPtyActivity(tabId: string): void {
    ensureInactivityTimer(tabId)
  },

  registerSignalHandler(tabId: string, handler: (event: string) => void): void {
    signalByTab.set(tabId, handler)
  },

  deregisterTab(tabId: string): void {
    cleanupTab(tabId)
  },

  // ── Owner PID resolution ──────────────────────────────────────────────────

  async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
    if (candidatePids.length === 0) return null
    try {
      const json = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
          ],
          { timeout: 5000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
        )
      })
      if (!json) return null

      const parsed = JSON.parse(json)
      const allProcs: Array<{ ProcessId: number; ParentProcessId: number; Name: string }> =
        Array.isArray(parsed) ? parsed : [parsed]

      const parentMap = new Map<number, number>()
      for (const proc of allProcs) parentMap.set(proc.ProcessId, proc.ParentProcessId)
      const pidSet = new Set(candidatePids)

      const findAncestor = (startPid: number): number | null => {
        let pid = startPid
        const visited = new Set<number>()
        while (pid && pid !== 0 && !visited.has(pid)) {
          if (pidSet.has(pid)) return pid
          visited.add(pid)
          pid = parentMap.get(pid) ?? 0
        }
        return null
      }

      const matches: Array<{ pid: number; ancestor: number }> = []
      for (const proc of allProcs) {
        if (!(proc.Name ?? '').toLowerCase().startsWith('opencode')) continue
        const ancestor = findAncestor(proc.ParentProcessId)
        if (ancestor !== null) matches.push({ pid: proc.ProcessId, ancestor })
      }

      if (matches.length === 0) return null
      matches.sort((a, b) => b.pid - a.pid)
      return matches[0].ancestor
    } catch (e) {
      cliLog(LOG_CH, `[resolveOwnerPid] failed: ${e}`)
      return null
    }
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  settingsFields(): SettingsField[] {
    return [
      {
        key: 'proxy',
        label: 'Proxy address',
        description: 'Leave empty to use no proxy (e.g. http://127.0.0.1:1080)',
        type: 'string',
        default: ''
      }
    ]
  },

  async getSettings(): Promise<Record<string, unknown>> {
    return getToolConfig(TOOL_ID)
  },

  async updateSettings(values: Record<string, unknown>): Promise<void> {
    updateToolConfig(TOOL_ID, values)
  },

  getEnvOverrides(): Record<string, string> {
    const proxy = (getToolConfig(TOOL_ID).proxy as string) ?? ''
    if (!proxy) return {}
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1'
    }
  },

  // ── Login identifier ─────────────────────────────────────────────────────
  //
  // OpenCode has a built-in /auth menu for account switching — no AIDE-level management needed.

  async getLoginIdentifier(): Promise<string | null> {
    return 'OpenCode CLI'
  },

  hasAccountSystem(): boolean {
    return false
  },

  // ── Usage info ───────────────────────────────────────────────────────────
  //
  // OpenCode has no usage limits — returns null.

  async getUsageInfo(): Promise<UsageInfo | null> {
    return null
  }
}
