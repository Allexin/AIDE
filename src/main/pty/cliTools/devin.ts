/**
 * Devin CLI tool integration.
 *
 * Devin (https://devin.ai) is Cognition's terminal coding agent (`devin` binary).
 *
 * Devin stores its data under the user data dir (%APPDATA%\devin on Windows):
 * a global SQLite session store (sessions.db — sessions, live message nodes,
 * prompt history), ATIF transcripts materialised at session end, and
 * file-based auth in credentials.toml. All session data is read straight from
 * SQLite (see devinScanner.ts); no `devin` subprocess is spawned for scans.
 */

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { CliTool, CliSession, SettingsField, HistoryEntry, HookLaunchContext } from './types'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import { findExecutable, listProcesses } from '../../platform'
import { resolveOwnerPidFromSnapshot } from '../../platform/processTree'
import {
  getDevinCliDir,
  getDevinDataDir,
  getDevinFirstPrompt,
  getDevinTranscriptPath,
  listDevinSessions,
  readDevinSessionHistory,
  readDevinSessionPreview,
  scanDevinSessionIdsSync,
  subscribeDevinSessionHistory,
  watchDevinSessionLabel,
  watchDevinSessions
} from './devinScanner'
import { cleanupTabHookConfig, writeTabHookConfig } from './devinHooks'
import { cliLog } from './cliLogger'

const LOG_CH = 'Devin'
const TOOL_NAME = 'Devin'
const TOOL_ID = 'devin'

const CREDENTIALS_TOML = join(getDevinDataDir(), 'credentials.toml')
const TRUSTED_WORKSPACES_JSON = join(getDevinCliDir(), 'trusted_workspaces.json')

const INACTIVITY_THRESHOLD = 5 // seconds of no PTY data before signaling "waiting for input"

/** Per-tab inactivity tracking state. */
interface InactivityState {
  counter: number
  interval: ReturnType<typeof setInterval>
}
const inactivityByTab = new Map<string, InactivityState>()

/** Per-tab signal callbacks, set by PtyManager at spawn time. */
const signalByTab = new Map<string, (event: string) => void>()

/** Start or restart the inactivity timer for a tab. Called on PTY data. */
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
      // Counter continues into negative; no repeated signals
    }, 1000)
  }
  inactivityByTab.set(tabId, state)
}

/** Stop and clean up the inactivity timer + signal callback for a closed tab. */
function cleanupInactivity(tabId: string): void {
  const state = inactivityByTab.get(tabId)
  if (state) {
    clearInterval(state.interval)
    inactivityByTab.delete(tabId)
  }
  signalByTab.delete(tabId)
}

/**
 * Devin canonicalises trusted paths the way Rust's fs::canonicalize does —
 * on Windows that means the \\?\ extended-length prefix
 * (e.g. "\\\\?\\E:\\Projects\\X"). Match that form when pre-trusting.
 */
function canonicalTrustPath(projectPath: string): string {
  let resolved: string
  try {
    resolved = realpathSync(projectPath)
  } catch {
    resolved = resolve(projectPath)
  }
  if (process.platform !== 'win32') return resolved
  const win = resolved.replace(/\//g, '\\')
  if (win.startsWith('\\\\?\\')) return win
  // UNC paths need the \\?\UNC\server\share form, not \\?\\server\share.
  if (win.startsWith('\\\\')) return `\\\\?\\UNC\\${win.slice(2)}`
  return `\\\\?\\${win}`
}

/** Pre-trust the project so `devin` doesn't show the workspace-trust prompt. */
async function ensureWorkspaceTrusted(projectPath: string): Promise<void> {
  const canonical = canonicalTrustPath(projectPath)

  let root: { trusted_paths?: unknown } = {}
  if (existsSync(TRUSTED_WORKSPACES_JSON)) {
    try {
      root = JSON.parse(readFileSync(TRUSTED_WORKSPACES_JSON, 'utf-8'))
    } catch {
      root = {}
    }
  }

  const paths = Array.isArray(root.trusted_paths) ? (root.trusted_paths as string[]) : []
  if (paths.includes(canonical)) return

  root.trusted_paths = [...paths, canonical]
  mkdirSync(dirname(TRUSTED_WORKSPACES_JSON), { recursive: true })
  // Atomic write: Devin may touch this file itself — write to a temp sibling
  // and rename so a concurrent reader never sees a truncated JSON.
  const tmp = `${TRUSTED_WORKSPACES_JSON}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(root, null, 2), 'utf-8')
  renameSync(tmp, TRUSTED_WORKSPACES_JSON)
}

/** Whether credentials.toml holds a non-empty session token. */
function hasUsableCredentials(): boolean {
  if (!existsSync(CREDENTIALS_TOML)) return false
  try {
    const content = readFileSync(CREDENTIALS_TOML, 'utf-8')
    return /^\s*windsurf_api_key\s*=\s*"[^"]+"/m.test(content)
  } catch {
    return false
  }
}

/** Cached login identifier — `devin auth status` is a subprocess call. */
let loginIdentifierCache: { value: string | null; at: number } | null = null
const LOGIN_ID_CACHE_MS = 60_000

function fetchLoginIdentifier(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('devin', ['auth', 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const match = /^\s*Email:\s*(\S+)\s*$/m.exec(stdout)
      resolve(match ? match[1] : null)
    })
  })
}

export const devinTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,

  installUrl: 'https://docs.devin.ai/cli',

  async isInstalled(): Promise<boolean> {
    return findExecutable('devin')
  },

  // ── Commands ──────────────────────────────────────────────────────────────

  newSessionCommand(): string {
    // Model/permission flags go on the new-session command only — with
    // -r/--resume they silently switch the resumed session's settings.
    const config = getToolConfig(TOOL_ID)
    const args: string[] = ['devin']

    const model = ((config.model as string) ?? '').trim()
    if (model) args.push('--model', model)

    const permissionMode = ((config.permissionMode as string) ?? '').trim()
    if (permissionMode) args.push('--permission-mode', permissionMode)

    return args.join(' ')
  },

  resumeCommand(sessionId: string): string {
    return `devin --resume ${sessionId}`
  },

  exitCommand(): string {
    return '/exit'
  },

  interactiveSubmitSequence(): string {
    return '\r'
  },

  // ── Startup health ────────────────────────────────────────────────────────

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (
      accumulated.includes('command not found') ||
      accumulated.includes('is not recognized') ||
      accumulated.includes('Cannot find module')
    ) return 'dead'

    // The Devin TUI enters the alternate screen and prints ANSI immediately.
    if (accumulated.includes('\x1b[?1049h') || accumulated.includes('Devin')) return 'ok'

    if (elapsedMs > 15000) return 'ok'
    return 'pending'
  },

  onPtyActivity(tabId: string): void {
    ensureInactivityTimer(tabId)
  },

  registerSignalHandler(tabId: string, handler: (event: string) => void): void {
    signalByTab.set(tabId, handler)
  },

  deregisterTab(tabId: string): void {
    cleanupInactivity(tabId)
    cleanupTabHookConfig(tabId)
  },

  // ── Hooks ────────────────────────────────────────────────────────────────

  hookLaunchArgs(ctx: HookLaunchContext): string {
    // Per-tab merged user config wiring SessionStart/Stop hooks back to AIDE's
    // hook server — deterministic tab -> sessionId binding, even when several
    // Devin tabs are spawned at once (lock-file scanning can't order those).
    try {
      const path = writeTabHookConfig(ctx.tabId, ctx.hookPort, ctx.hookToken)
      if (!path) return ''
      return ` --config "${path}"`
    } catch (err) {
      cliLog(LOG_CH, `[hooks] failed to write hook config for ${ctx.tabId}: ${err}`)
      return ''
    }
  },

  // ── Project setup ─────────────────────────────────────────────────────────

  async prepareProject(projectPath: string): Promise<void> {
    try {
      await ensureWorkspaceTrusted(projectPath)
    } catch (e) {
      cliLog(LOG_CH, `[prepareProject] failed to trust workspace: ${e}`)
    }
  },

  // ── Sessions ──────────────────────────────────────────────────────────────

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const sessions = listDevinSessions(projectPath)
    return sessions.map((s) => ({
      sessionId: s.id,
      slug: s.title || TOOL_NAME,
      summary: s.title || undefined,
      firstMessage: getDevinFirstPrompt(s.id) || undefined,
      lastModified: s.lastModified
    }))
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    // Synchronous SQLite baseline so a session created before the first
    // watch fire is still reported to PtyManager.
    const knownIds = scanDevinSessionIdsSync(projectPath)

    return watchDevinSessions(projectPath, knownIds, (session) => {
      onNew({
        sessionId: session.id,
        slug: session.title || TOOL_NAME,
        lastModified: session.lastModified
      })
    })
  },

  /** Session titles are generated asynchronously inside sessions.db — the
   *  scanner watches the db files and re-reads the row on change. */
  watchSessionLabel(_projectPath: string, sessionId: string, onLabel: (label: string) => void): () => void {
    return watchDevinSessionLabel(sessionId, onLabel)
  },

  async getSessionPreview(_projectPath: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    return readDevinSessionPreview(sessionId)
  },

  async getSessionHistory(_projectPath: string, sessionId: string): Promise<HistoryEntry[]> {
    return readDevinSessionHistory(sessionId)
  },

  subscribeToSessionHistory(
    _projectPath: string,
    sessionId: string,
    onEntry: (entry: HistoryEntry) => void
  ): () => void {
    return subscribeDevinSessionHistory(sessionId, onEntry)
  },

  getSessionFilePath(_projectPath: string, sessionId: string): string | null {
    return getDevinTranscriptPath(sessionId)
  },

  // ── Context insert ──────────────────────────────────────────────────────────

  contextInsert(relPath: string): string {
    // Devin CLI uses "@" file mentions (opens file autocomplete).
    return `@${relPath}`
  },

  // ── Process attribution ───────────────────────────────────────────────────

  async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
    if (candidatePids.length === 0) return null
    try {
      const procs = await listProcesses()
      return resolveOwnerPidFromSnapshot(procs, candidatePids, (name) => name.startsWith('devin'))
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
      },
      {
        key: 'model',
        label: 'Model',
        description: 'Model id or alias (see `devin models list`). Leave empty for the account default.',
        type: 'string',
        default: ''
      },
      {
        key: 'permissionMode',
        label: 'Permission mode',
        description: 'Startup permission mode; you can cycle modes inside the session with Shift+Tab.',
        type: 'select',
        options: [
          { value: '', label: 'CLI default' },
          { value: 'auto', label: 'auto' },
          { value: 'accept-edits', label: 'accept-edits' },
          { value: 'smart', label: 'smart' },
          { value: 'dangerous', label: 'dangerous' }
        ],
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
    const config = getToolConfig(TOOL_ID)
    const env: Record<string, string> = {}

    const proxy = (config.proxy as string) ?? ''
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
      env.http_proxy = proxy
      env.https_proxy = proxy
      // reqwest's system proxy resolution routes loopback traffic through the
      // proxy unless NO_PROXY explicitly excludes it, breaking local MCP servers.
      env.NO_PROXY = 'localhost,127.0.0.1,::1'
      env.no_proxy = 'localhost,127.0.0.1,::1'
    }

    // Model/permission settings are passed as flags on new-session launch only
    // (see newSessionCommand) — DEVIN_MODEL on --resume would switch the
    // resumed session's saved model.

    return env
  },

  // ── Accounts ──────────────────────────────────────────────────────────────

  hasAccountSystem(): boolean {
    return true
  },

  async isLoggedIn(): Promise<boolean> {
    return hasUsableCredentials()
  },

  async getLoginIdentifier(): Promise<string | null> {
    if (!hasUsableCredentials()) return null
    if (loginIdentifierCache && Date.now() - loginIdentifierCache.at < LOGIN_ID_CACHE_MS) {
      return loginIdentifierCache.value
    }
    const value = await fetchLoginIdentifier()
    loginIdentifierCache = { value, at: Date.now() }
    return value
  },

  async exportCredentials(): Promise<Record<string, unknown> | null> {
    if (!hasUsableCredentials()) return null
    try {
      return { credentialsToml: readFileSync(CREDENTIALS_TOML, 'utf-8') }
    } catch {
      return null
    }
  },

  async importCredentials(credentials: Record<string, unknown>): Promise<void> {
    const toml = credentials.credentialsToml
    if (typeof toml !== 'string' || !toml.trim()) return
    try {
      mkdirSync(dirname(CREDENTIALS_TOML), { recursive: true })
      writeFileSync(CREDENTIALS_TOML, toml, 'utf-8')
      loginIdentifierCache = null
    } catch (e) {
      cliLog(LOG_CH, `[credentials] failed to import: ${e}`)
      throw e
    }
  },

  async clearCredentials(): Promise<void> {
    loginIdentifierCache = null
    if (!existsSync(CREDENTIALS_TOML)) return
    try {
      unlinkSync(CREDENTIALS_TOML)
    } catch (e) {
      cliLog(LOG_CH, `[credentials] failed to clear: ${e}`)
    }
  }
}
