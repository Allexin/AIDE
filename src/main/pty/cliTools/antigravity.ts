/**
 * Google Antigravity CLI (`agy`) integration.
 *
 * Antigravity stores session metadata in `~/.gemini/antigravity-cli/conversation_summaries.db`
 * (SQLite WAL) and transcripts at `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`.
 * Authentication uses a unified OS secure keyring shared across Antigravity App, CLI, and IDE
 * (`hasAccountSystem() → false`); active email and quota are captured live from the per-tab
 * `title.command` hook payload when tabs run.
 */

import { existsSync } from 'fs'
import { basename } from 'path'
import { AIDE_MCP_KEY, AIDE_MCP_SERVER_NAME } from '../../aideMcp/launch'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import type { HookBinding } from '../../hooks/hookServer'
import { antigravityHeadless, resolveAntigravityExecutable } from '../../pipeline/headless/antigravityHeadless'
import { findExecutable } from '../../platform'
import { cleanupAntigravityTabSettings, writeAntigravityTabSettings } from './antigravityHooks'
import { ANTIGRAVITY_MCP_CONFIG, syncAntigravityMcpConfig } from './antigravityMcp'
import {
  getAntigravityTranscriptPath,
  listAntigravitySessions,
  parseAntigravityThinkingBlocks,
  readAntigravityFirstMessage,
  readAntigravitySessionHistory,
  readAntigravitySessionPreview,
  scanAntigravitySessionIdsSync,
  subscribeAntigravitySessionHistory,
  watchAntigravitySessions
} from './antigravityScanner'
import { cliLog } from './cliLogger'
import {
  getAntigravityUsageInfo,
  getCachedAntigravityEmail,
  recordAntigravityEmail,
  recordAntigravityHookQuota
} from './antigravityUsage'
import { tuiReadyForInput } from './startupHealth'
import { tabActivity } from '../tabActivity'
import type { CliSession, CliTool, HistoryEntry, LaunchAdditions, LaunchContext, SettingsField, TabReadyContext, UsageInfo } from './types'

const TOOL_ID = 'antigravity'
const TOOL_NAME = 'Google Antigravity'
const LOG_CH = 'Antigravity'

export const PRELOAD_MCP_KEY = 'preloadMcpOnStart'

const INACTIVITY_THRESHOLD = 5 // fallback seconds of PTY silence if title hook is not active

/** Safety bounds & settle windows for the temporary `/mcp` + `Esc` startup preload workaround (docs/timers.md). */
const PRELOAD_SETTLE_MS = 600
const PRELOAD_MAX_STARTUP_WAIT_MS = 4000
const PRELOAD_ECHO_WAIT_MS = 1000
const PRELOAD_OVERLAY_SETTLE_MS = 500
const PRELOAD_OVERLAY_MAX_WAIT_MS = 4000
const PRELOAD_CLOSE_WAIT_MS = 500

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

function waitForOutputQuiet(ctx: TabReadyContext, quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.isClosed()) { resolve(); return }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(maxTimer)
      clearTimeout(quietTimer)
      unsub()
      resolve()
    }
    let quietTimer = setTimeout(finish, quietMs)
    const maxTimer = setTimeout(finish, maxMs)
    const unsub = ctx.subscribeOutput(() => {
      if (ctx.isClosed()) { finish(); return }
      clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, quietMs)
    })
  })
}

function waitForOutputMatch(ctx: TabReadyContext, predicate: (plain: string) => boolean, settleMs: number, maxMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (ctx.isClosed()) { resolve(false); return }
    let done = false
    let buf = ''
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (matched: boolean): void => {
      if (done) return
      done = true
      clearTimeout(maxTimer)
      if (settleTimer) clearTimeout(settleTimer)
      unsub()
      resolve(matched)
    }
    const maxTimer = setTimeout(() => finish(false), maxMs)
    const unsub = ctx.subscribeOutput((chunk) => {
      if (ctx.isClosed()) { finish(false); return }
      buf += stripAnsi(chunk)
      if (predicate(buf)) {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => finish(true), settleMs)
      }
    })
  })
}

function waitForNextChunk(ctx: TabReadyContext, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.isClosed()) { resolve(); return }
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    const unsub = ctx.subscribeOutput(() => finish())
  })
}

/**
 * Temporary workaround for a known Antigravity CLI 1.5.x issue: interactive TUI tabs
 * do not attach workspace MCP servers until the first turn or `/mcp` opens. Opening
 * and immediately closing `/mcp` triggers MCP initialization at zero token cost.
 */
export async function preloadAntigravityMcp(
  ctx: TabReadyContext,
  timings: {
    settleMs?: number
    maxStartupWaitMs?: number
    echoWaitMs?: number
    overlaySettleMs?: number
    overlayMaxWaitMs?: number
    closeWaitMs?: number
  } = {}
): Promise<boolean> {
  const settleMs = timings.settleMs ?? PRELOAD_SETTLE_MS
  const maxStartupWaitMs = timings.maxStartupWaitMs ?? PRELOAD_MAX_STARTUP_WAIT_MS
  const echoWaitMs = timings.echoWaitMs ?? PRELOAD_ECHO_WAIT_MS
  const overlaySettleMs = timings.overlaySettleMs ?? PRELOAD_OVERLAY_SETTLE_MS
  const overlayMaxWaitMs = timings.overlayMaxWaitMs ?? PRELOAD_OVERLAY_MAX_WAIT_MS
  const closeWaitMs = timings.closeWaitMs ?? PRELOAD_CLOSE_WAIT_MS

  await waitForOutputQuiet(ctx, settleMs, maxStartupWaitMs)
  if (ctx.isClosed() || ctx.hasUserDraft()) return false

  const echoed = waitForNextChunk(ctx, echoWaitMs)
  ctx.write('/mcp')
  await echoed
  if (ctx.isClosed() || ctx.hasUserDraft()) return false

  const overlayReady = waitForOutputMatch(
    ctx,
    (plain) => /\baide\b/i.test(plain) || /Tools:/i.test(plain) || /No MCP/i.test(plain),
    overlaySettleMs,
    overlayMaxWaitMs
  )
  ctx.write('\r')
  await overlayReady
  if (ctx.isClosed()) return false

  const closed = waitForNextChunk(ctx, closeWaitMs)
  ctx.write('\x1b')
  await closed
  return true
}

interface InactivityState {
  counter: number
  interval: ReturnType<typeof setInterval>
}

const signalByTab = new Map<string, (event: string) => void>()
const inactivityByTab = new Map<string, InactivityState>()
const hookDrivenTabs = new Set<string>()
const lastAgentStateByTab = new Map<string, string>()
const lastConfirmPendingByTab = new Map<string, boolean>()

/** Live login metadata observed from Antigravity's `title` JSON state payloads. */
let cachedEmail: string | null = null
let cachedPlanTier: string | null = null

function clearFallbackInactivity(tabId: string): void {
  const state = inactivityByTab.get(tabId)
  if (state) {
    clearInterval(state.interval)
    inactivityByTab.delete(tabId)
  }
}

function ensureFallbackInactivityTimer(tabId: string): void {
  if (hookDrivenTabs.has(tabId)) return
  const existing = inactivityByTab.get(tabId)
  if (existing) {
    existing.counter = INACTIVITY_THRESHOLD
    return
  }
  const state: InactivityState = {
    counter: INACTIVITY_THRESHOLD,
    interval: setInterval(() => {
      if (hookDrivenTabs.has(tabId)) {
        clearFallbackInactivity(tabId)
        return
      }
      state.counter--
      if (state.counter === 0) {
        signalByTab.get(tabId)?.('completeAndWait')
      }
    }, 1000)
  }
  inactivityByTab.set(tabId, state)
}

const BUSY_STATES = new Set(['working', 'tool_use'])
const WAIT_STATES = new Set(['idle', 'reviewing'])

/** Format the terminal window title returned to `agy`'s `title.command` hook. */
export function formatAntigravityTitle(payload: Record<string, unknown>): string {
  const title = typeof payload.conversation_title === 'string' && payload.conversation_title.trim()
    ? payload.conversation_title.trim()
    : (typeof payload.cwd === 'string' && payload.cwd.trim() ? basename(payload.cwd.trim()) : TOOL_NAME)
  const state = typeof payload.agent_state === 'string' ? payload.agent_state : ''
  const confirm = payload.tool_confirmation_pending === true
  if (confirm || state === 'reviewing') return `? ${title}`
  if (BUSY_STATES.has(state)) return `● ${title}`
  if (state === 'idle') return `✳ ${title}`
  return title
}

function launchBinaryCommand(): string {
  // A running AIDE may still have the PATH from before the Windows installation.
  const exe = process.platform === 'win32' ? resolveAntigravityExecutable() : null
  return exe ? `& '${exe.replace(/'/g, "''")}'` : 'agy'
}

export const antigravityTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,
  installUrl: 'https://antigravity.google/docs/getting-started?tab=cli',

  headless: antigravityHeadless,

  async isInstalled(): Promise<boolean> {
    return !!resolveAntigravityExecutable() || findExecutable('agy')
  },

  // ── Commands ──────────────────────────────────────────────────────────────

  newSessionCommand(): string {
    // Model and effort flags go on new-session launch only so resuming keeps
    // the resumed conversation's saved settings.
    const config = getToolConfig(TOOL_ID)
    const args = [launchBinaryCommand()]

    const model = typeof config.model === 'string' ? config.model.trim() : ''
    if (model && !/[\s"'`$]/.test(model)) args.push('--model', model)

    const effort = typeof config.effort === 'string' ? config.effort.trim() : ''
    if (effort) args.push('--effort', effort)

    return args.join(' ')
  },

  resumeCommand(sessionId: string): string {
    if (!sessionId || /[^a-zA-Z0-9_-]/.test(sessionId)) {
      throw new Error('Invalid Antigravity conversation ID')
    }
    return `${launchBinaryCommand()} --conversation=${sessionId}`
  },

  exitCommand(): string {
    return '/exit'
  },

  interactiveSubmitSequence(): string {
    return '\r'
  },

  // ── AIDE MCP & Per-Tab Launch Wiring ──────────────────────────────────────

  aideMcp: {
    supported: true,
    note: "Antigravity reads workspace MCP servers from .agents/mcp_config.json: before each launch AIDE creates or updates .agents/mcp_config.json in the project (keeping your own servers there and excluding it in .git/info/exclude) and allows AIDE's MCP tools for that session; turning this off removes AIDE's entry"
  },

  prepareLaunch(ctx: LaunchContext): LaunchAdditions {
    try {
      if (syncAntigravityMcpConfig(ctx.projectPath, ctx.mcpServers, [AIDE_MCP_SERVER_NAME])) {
        cliLog(LOG_CH, `[mcp] updated ${ANTIGRAVITY_MCP_CONFIG} in ${ctx.projectPath}`)
      }
    } catch (err) {
      cliLog(LOG_CH, `[mcp] ${err instanceof Error ? err.message : String(err)}`)
    }

    const env: Record<string, string> = { AIDE_PROJECT: ctx.projectPath }
    try {
      const settingsPath = writeAntigravityTabSettings(
        ctx.tabId,
        ctx.projectPath,
        ctx.hook,
        ctx.mcpServers.map((s) => s.name)
      )
      return settingsPath ? { args: ` --settings "${settingsPath}"`, env } : { env }
    } catch (err) {
      cliLog(LOG_CH, `[launch] failed to write session settings for ${ctx.tabId}: ${err instanceof Error ? err.message : String(err)}`)
      return { env }
    }
  },

  onHookEvent(binding: HookBinding): string | void {
    const payload = binding.payload
    if (!payload) return

    if (!binding.sessionId && typeof payload.conversation_id === 'string' && payload.conversation_id) {
      binding.sessionId = payload.conversation_id
    }
    // agy 1.5.x reports `~/.gemini/antigravity/brain/...` in `transcript_path`
    // while actually writing transcripts under `~/.gemini/antigravity-cli/brain/...`.
    if (binding.sessionId && (!binding.transcriptPath || !existsSync(binding.transcriptPath))) {
      binding.transcriptPath = getAntigravityTranscriptPath(binding.sessionId, false)
    }

    hookDrivenTabs.add(binding.tabId)
    clearFallbackInactivity(binding.tabId)

    if (typeof payload.email === 'string' && payload.email.trim()) {
      cachedEmail = payload.email.trim()
      recordAntigravityEmail(cachedEmail)
    }
    if (typeof payload.plan_tier === 'string' && payload.plan_tier.trim()) {
      cachedPlanTier = payload.plan_tier.trim()
    }
    if (payload.quota) {
      recordAntigravityHookQuota(payload.quota, cachedPlanTier, cachedEmail)
    }

    const state = typeof payload.agent_state === 'string' ? payload.agent_state : ''
    const prevState = lastAgentStateByTab.get(binding.tabId) ?? ''
    if (state) lastAgentStateByTab.set(binding.tabId, state)

    const confirm = payload.tool_confirmation_pending === true
    const prevConfirm = lastConfirmPendingByTab.get(binding.tabId) ?? false
    lastConfirmPendingByTab.set(binding.tabId, confirm)

    const becameIdle = BUSY_STATES.has(prevState) && WAIT_STATES.has(state)
    const becameConfirmation = !prevConfirm && confirm
    if (becameIdle || becameConfirmation) {
      signalByTab.get(binding.tabId)?.('completeAndWait')
    }
    // Always sync tabActivity with Antigravity's authoritative agent_state (fast turns
    // can skip emitting 'working' before 'idle', and initial hooks report 'idle' with
    // prevState === ''; syncing here avoids leaving the tab stuck as busy without
    // triggering spurious completion sounds).
    if (BUSY_STATES.has(state)) {
      tabActivity.markBusy(binding.tabId)
    } else if (WAIT_STATES.has(state) || confirm) {
      tabActivity.markIdle(binding.tabId)
    }

    return formatAntigravityTitle(payload)
  },

  // ── Startup health & tab signals ──────────────────────────────────────────

  checkStartupHealth(accumulated: string): 'ok' | 'dead' | 'pending' {
    if (
      accumulated.includes('command not found') ||
      accumulated.includes('is not recognized') ||
      accumulated.includes('Cannot find module') ||
      accumulated.includes('Failed to start:') ||
      accumulated.includes('authentication required') ||
      accumulated.includes('conversation not found')
    ) {
      return 'dead'
    }

    if (
      tuiReadyForInput(accumulated) ||
      accumulated.includes('shift+tab') ||
      accumulated.includes('Describe your') ||
      accumulated.includes('Auto mode:') ||
      accumulated.includes('Antigravity')
    ) {
      return 'ok'
    }

    return 'pending'
  },

  onPtyActivity(tabId: string): void {
    ensureFallbackInactivityTimer(tabId)
  },

  async onTabReady(ctx: TabReadyContext): Promise<void> {
    const cfg = getToolConfig(TOOL_ID)
    if (cfg[AIDE_MCP_KEY] === false || cfg[PRELOAD_MCP_KEY] === false) return
    await preloadAntigravityMcp(ctx)
  },

  registerSignalHandler(tabId: string, handler: (event: string) => void): void {
    signalByTab.set(tabId, handler)
  },

  deregisterTab(tabId: string): void {
    clearFallbackInactivity(tabId)
    signalByTab.delete(tabId)
    hookDrivenTabs.delete(tabId)
    lastAgentStateByTab.delete(tabId)
    lastConfirmPendingByTab.delete(tabId)
    cleanupAntigravityTabSettings(tabId)
  },

  // ── Sessions, history & thinking ──────────────────────────────────────────

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const rows = listAntigravitySessions(projectPath)
    return rows.map((row) => {
      const first = readAntigravityFirstMessage(row.conversationId)
      return {
        sessionId: row.conversationId,
        slug: row.title || row.preview || TOOL_NAME,
        summary: row.title || undefined,
        firstMessage: first || row.preview || undefined,
        lastModified: row.lastModified
      }
    })
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    const knownIds = scanAntigravitySessionIdsSync(projectPath)
    return watchAntigravitySessions(projectPath, knownIds, (row) => {
      onNew({
        sessionId: row.conversationId,
        slug: row.title || row.preview || TOOL_NAME,
        summary: row.title || undefined,
        lastModified: row.lastModified
      })
    })
  },

  async getSessionPreview(_projectPath: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    return readAntigravitySessionPreview(sessionId)
  },

  async getSessionHistory(_projectPath: string, sessionId: string): Promise<HistoryEntry[]> {
    return readAntigravitySessionHistory(sessionId)
  },

  subscribeToSessionHistory(
    _projectPath: string,
    sessionId: string,
    onEntry: (entry: HistoryEntry) => void
  ): () => void {
    return subscribeAntigravitySessionHistory(sessionId, onEntry)
  },

  getSessionFilePath(_projectPath: string, sessionId: string): string | null {
    return getAntigravityTranscriptPath(sessionId, false)
  },

  parseThinkingBlocks(line: string): string[] {
    return parseAntigravityThinkingBlocks(line)
  },

  // ── Context insert ────────────────────────────────────────────────────────

  contextInsert(relPath: string): string {
    return `@${relPath}`
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  settingsFields(): SettingsField[] {
    return [
      {
        key: 'proxy',
        label: 'Proxy address',
        description: 'HTTP proxy for new Antigravity tabs and headless runs (e.g. http://127.0.0.1:1080). Leave empty to inherit the environment.',
        type: 'string',
        default: ''
      },
      {
        key: 'model',
        label: 'Model',
        description: 'Optional model slug for new sessions (see `agy models`). Leave empty for the CLI default.',
        type: 'string',
        default: ''
      },
      {
        key: 'effort',
        label: 'Reasoning effort',
        description: 'Optional reasoning effort for new sessions (depending on the model).',
        type: 'select',
        options: [
          { value: '', label: 'CLI default' },
          { value: 'low', label: 'low' },
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
          { value: 'xhigh', label: 'xhigh' },
          { value: 'max', label: 'max' }
        ],
        default: ''
      },
      {
        key: PRELOAD_MCP_KEY,
        label: 'Preload AIDE MCP tools on startup (/mcp)',
        description: 'Temporary workaround for a known Antigravity CLI issue where workspace MCP tools do not load until the second turn: opens and closes /mcp right after startup (uses no tokens).',
        type: 'boolean',
        default: true
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
    const value = getToolConfig(TOOL_ID).proxy
    const proxy = typeof value === 'string' ? value.trim() : ''
    if (!proxy) return {}
    const bypass = 'localhost,127.0.0.1,::1'
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: bypass,
      no_proxy: bypass
    }
  },

  // ── Accounts & usage ──────────────────────────────────────────────────────
  // Antigravity stores unified OAuth tokens in the OS secure keyring shared
  // across App, CLI, and IDE, so AIDE does not export/import its credentials.
  // Active email and quota are surfaced from live title-hook payloads.

  hasAccountSystem(): boolean {
    return false
  },

  accountUnsupportedReason:
    'Google Antigravity stores OAuth tokens in the OS secure keyring shared with the Antigravity App and IDE, and does not provide CLI credential export or import.',

  async getLoginIdentifier(): Promise<string | null> {
    return cachedEmail ?? getCachedAntigravityEmail()
  },

  async getUsageInfo(cacheMaxAgeMs?: number): Promise<UsageInfo | null> {
    return getAntigravityUsageInfo(cacheMaxAgeMs, this.getEnvOverrides?.() ?? {})
  }
}
