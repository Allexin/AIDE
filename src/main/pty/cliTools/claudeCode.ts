import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, watch, openSync, fstatSync, readSync, closeSync } from 'fs'
import type { FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { session } from 'electron'
import type { CliTool, CliSession, SettingsField, UsageInfo, HistoryEntry, HookLaunchContext } from './types'
import { writeTabHookSettings, cleanupTabHookSettings } from './claudeHooks'
import { scanSessions as scanDiskSessions, watchSessionsDir, getSessionsDir, readSessionPreview, readSessionHistory, parseHistoryLine } from './claudeCodeScanner'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import { cliLog } from './cliLogger'
import { createJsonlSmartCompactCapability, runProcess } from './smartCompactJsonl'
import { findExecutable, listProcesses } from '../../platform'
import { resolveOwnerPidFromSnapshot } from '../../platform/processTree'
import {
  getActiveAccount,
  getSubscriptionUsageCache,
  listAccounts,
  releaseSubscriptionUsageRefresh,
  setSubscriptionUsageCache,
  tryAcquireSubscriptionUsageRefresh,
  updateAccount as updateStoredAccount
} from '../../config/accountStorage'

const LOG_CH = 'Claude Code Errors'
const TOOL_NAME = 'Claude Code'

/** Detected CLI version, parsed from the startup banner ("Claude Code vX.Y.Z"). */
let detectedCliVersion: string | null = null

/** Per-tab signal callbacks, set by PtyManager at spawn time. */
const signalByTab = new Map<string, (event: string) => void>()

const CLAUDE_JSON = join(homedir(), '.claude.json')

/** Normalise a project path to the key format Claude uses in ~/.claude.json.
 *  Windows: backslashes → forward slashes. E.g. E:\Projects\X → E:/Projects/X
 */
function normaliseProjectKey(projectPath: string): string {
  return projectPath.replace(/\\/g, '/')
}

/** Ensure ~/.claude.json marks the project as trusted so Claude Code
 *  doesn't show the "Do you trust files in this folder?" prompt.
 */
async function ensureProjectTrusted(projectPath: string): Promise<void> {
  const key = normaliseProjectKey(projectPath)

  let root: Record<string, unknown> = {}
  if (existsSync(CLAUDE_JSON)) {
    try {
      root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
    } catch {
      // corrupt file — leave root as empty object, will be merged below
    }
  }

  const projects = (root.projects ?? {}) as Record<string, Record<string, unknown>>
  const entry = projects[key] ?? {}

  if (entry.hasTrustDialogAccepted === true) return // already trusted, nothing to do

  projects[key] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    ...entry,
    hasTrustDialogAccepted: true,
  }

  root.projects = projects
  writeFileSync(CLAUDE_JSON, JSON.stringify(root, null, 2), 'utf-8')
}

/** Keys from ~/.claude.json that constitute auth credentials. */
const CREDENTIAL_KEYS = ['oauthAccount', 'userID'] as const

/** Path to the separate credentials file (access/refresh tokens). */
const CREDENTIALS_JSON = join(homedir(), '.claude', '.credentials.json')

const TOOL_ID = 'claude-code'

/** Returns the configured proxy address, or null if not set. */
function resolveProxyAddress(): string | null {
  const addr = (getToolConfig(TOOL_ID).proxy as string) ?? ''
  return addr || null
}

/** Exponential backoff state for usage API 429 responses. */
const usageBackoff = { delay: 60_000, until: 0 }

/** When true, getUsageInfo returns a placeholder without hitting the API.
 *  Starts true (app launch) and is set true again on importCredentials (account switch). */
let usageSuppressed = true

function formatUsageReset(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, { timeZoneName: 'short' })
}

function usageFromCache(cached: Record<string, unknown>): UsageInfo {
  const s = (cached.session as Record<string, unknown>)?.percent as number ?? 0
  const w = (cached.week as Record<string, unknown>)?.percent as number ?? 0
  const maxP = Math.max(s, w)
  const lvl: UsageInfo['level'] = maxP >= 90 ? 'critical' : maxP >= 70 ? 'warn' : 'normal'
  const sResets = (cached.session as Record<string, unknown>)?.resets as string ?? ''
  const wResets = (cached.week as Record<string, unknown>)?.resets as string ?? ''
  return {
    summary: `${s}% / ${w}%`,
    tooltip: `session: ${s}%${sResets ? ` resets ${formatUsageReset(sResets)}` : ''}\nweek: ${w}%${wResets ? ` resets ${formatUsageReset(wResets)}` : ''}`,
    level: lvl,
    fetchedAt: (cached.updatedAt as number) || Date.now()
  }
}

function sharedUsageFromPayload(data: Record<string, unknown>, fetchedAt: number): UsageInfo | null {
  const fiveHour = data.five_hour as { utilization?: unknown; resets_at?: unknown } | undefined
  const sevenDay = data.seven_day as { utilization?: unknown; resets_at?: unknown } | undefined
  if (typeof fiveHour?.utilization !== 'number' || typeof sevenDay?.utilization !== 'number') return null
  return usageFromCache({
    session: {
      percent: Math.round(fiveHour.utilization),
      resets: typeof fiveHour.resets_at === 'string' ? fiveHour.resets_at : ''
    },
    week: {
      percent: Math.round(sevenDay.utilization),
      resets: typeof sevenDay.resets_at === 'string' ? sevenDay.resets_at : ''
    },
    updatedAt: fetchedAt
  })
}

function resolveSavedClaudeAccountId(identifier: string | null): string | null {
  if (!identifier) return null
  const accounts = listAccounts(TOOL_ID)
  const activeId = getActiveAccount(TOOL_ID)
  const active = accounts.find((account) => account.id === activeId)
  if (active?.identifier === identifier) return active.id
  return accounts.find((account) => account.identifier === identifier)?.id ?? null
}

function syncActiveClaudeCredentials(accountId: string, identifier: string): void {
  const saved = listAccounts(TOOL_ID).find((account) => account.id === accountId)
  if (!saved || saved.identifier !== identifier || !existsSync(CREDENTIALS_JSON) || !existsSync(CLAUDE_JSON)) return
  try {
    const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8')) as Record<string, unknown>
    const oauthAccount = root.oauthAccount as Record<string, unknown> | undefined
    if (oauthAccount?.emailAddress !== identifier) return
    const liveCredentials = JSON.parse(readFileSync(CREDENTIALS_JSON, 'utf-8')) as Record<string, unknown>
    const savedSnapshot = saved.credentials._credentialsJson as Record<string, unknown> | undefined
    const liveOauth = liveCredentials.claudeAiOauth as Record<string, unknown> | undefined
    const savedOauth = savedSnapshot?.claudeAiOauth as Record<string, unknown> | undefined
    if (!liveOauth?.accessToken || liveOauth.accessToken === savedOauth?.accessToken) return

    const credentials: Record<string, unknown> = { ...saved.credentials, _credentialsJson: liveCredentials }
    if (root.oauthAccount !== undefined) credentials.oauthAccount = root.oauthAccount
    if (root.userID !== undefined) credentials.userID = root.userID
    updateStoredAccount(TOOL_ID, accountId, identifier, credentials, saved.revision)
  } catch (e) {
    cliLog(LOG_CH, `[usage] failed to synchronize active account credentials: ${e}`)
  }
}

export const claudeCodeTool: CliTool = {
  id: 'claude-code',
  name: TOOL_NAME,

  smartCompact: createJsonlSmartCompactCapability({
    locateSessionFile: (projectPath, sessionId) => join(getSessionsDir(projectPath), `${sessionId}.jsonl`),
    getStorageInstructions: (sessionFile) => `Claude Code stores this session as JSONL at ${sessionFile}.
Records with type "user" or "assistant" contain message.content. Content may be text or an array
containing text, thinking, tool_use, and tool_result blocks. Match tool_use.id to
tool_result.tool_use_id and always select both records. Records with isMeta=true and records whose
type is not user/assistant are session metadata and must never be selected.`,
    runAutonomous: ({ workspace, prompt, onOutput }) => runProcess(
      'claude',
      ['-p', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--tools', 'Read,Write', prompt],
      { cwd: workspace.directory, env: claudeCodeTool.getEnvOverrides?.(), onOutput }
    ),
    describeRecord: (record) => {
      const obj = record.value
      if (!obj || (obj.type !== 'user' && obj.type !== 'assistant') || obj.isMeta === true) {
        return { removable: false, role: 'metadata', preview: '', links: [] }
      }
      const message = obj.message as Record<string, unknown> | undefined
      const content = message?.content
      const blocks = Array.isArray(content) ? content : [content]
      const texts: string[] = []
      const links: string[] = []
      for (const block of blocks) {
        if (typeof block === 'string') texts.push(block)
        else if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (typeof b.text === 'string') texts.push(b.text)
          if (b.type === 'tool_use' && typeof b.id === 'string') links.push(`tool:${b.id}`)
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') links.push(`tool:${b.tool_use_id}`)
        }
      }
      return {
        removable: true,
        role: String(obj.type),
        preview: texts.join('\n').trim().slice(0, 500) || `[${String(obj.type)} record]`,
        links
      }
    },
    prepareRetainedRecords: (retained, original) => {
      const retainedUuids = new Set(retained.flatMap((record) => {
        const uuid = record.value?.uuid
        return typeof uuid === 'string' ? [uuid] : []
      }))
      const parentByUuid = new Map<string, string | null>()
      for (const record of original) {
        const uuid = record.value?.uuid
        if (typeof uuid !== 'string') continue
        const parent = record.value?.parentUuid
        parentByUuid.set(uuid, typeof parent === 'string' && parent ? parent : null)
      }

      return retained.map((record) => {
        const value = record.value
        if (!value || typeof value.parentUuid !== 'string' || retainedUuids.has(value.parentUuid)) return record
        let parent: string | null = value.parentUuid
        const visited = new Set<string>()
        while (parent && !retainedUuids.has(parent) && !visited.has(parent)) {
          visited.add(parent)
          parent = parentByUuid.get(parent) ?? null
        }
        const next = { ...value, parentUuid: parent }
        return { ...record, value: next, raw: JSON.stringify(next) }
      })
    }
  }),

  installUrl: 'https://claude.ai/download',

  async isInstalled(): Promise<boolean> {
    return findExecutable('claude')
  },

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
    const addr = resolveProxyAddress()
    if (!addr) return {}
    return {
      HTTP_PROXY: addr,
      http_proxy: addr,
      HTTPS_PROXY: addr,
      https_proxy: addr,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1'
    }
  },

  hookLaunchArgs(ctx: HookLaunchContext): string {
    // Write a per-tab settings file wiring SessionStart/Stop hooks back to AIDE's
    // hook server (deterministic tab -> transcript_path binding). Merges with the
    // user's project .claude/settings.json rather than replacing it.
    try {
      const path = writeTabHookSettings(ctx.tabId, ctx.hookPort, ctx.hookToken)
      return ` --settings "${path}"`
    } catch (err) {
      cliLog(LOG_CH, `Failed to write hook settings for ${ctx.tabId}: ${String(err)}`)
      return ''
    }
  },

  async prepareProject(projectPath: string): Promise<void> {
    await ensureProjectTrusted(projectPath)
  },

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const sessions = await scanDiskSessions(projectPath)
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      slug: s.title,
      summary: s.summary || undefined,
      firstMessage: s.firstMessage || undefined,
      lastModified: new Date(s.mtime)
    }))
  },

  resumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`
  },

  exitCommand(): string {
    return '/exit'
  },

  interactiveSubmitSequence(): string {
    return '\r'
  },

  newSessionCommand(): string {
    return 'claude'
  },

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (accumulated.includes('No conversation found with session ID')) return 'dead'
    // CLI sets terminal title to "✻ Claude Code" (OSC sequence) when ready
    if (accumulated.includes('Claude Code')) {
      // Parse version from startup banner: "Claude Code v2.1.69"
      const vm = /Claude Code v(\d+\.\d+\.\d+)/.exec(accumulated)
      if (vm) detectedCliVersion = vm[1]
      return 'ok'
    }
    if (elapsedMs > 15000) return 'ok' // assume ok after 15s
    return 'pending'
  },

  hasAccountSystem(): boolean {
    return true
  },

  async isLoggedIn(): Promise<boolean> {
    if (!existsSync(CLAUDE_JSON)) return false
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      return !!(root.oauthAccount && root.oauthAccount.emailAddress)
    } catch {
      return false
    }
  },

  async getLoginIdentifier(): Promise<string | null> {
    if (!existsSync(CLAUDE_JSON)) return null
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      return root.oauthAccount?.emailAddress ?? null
    } catch {
      return null
    }
  },

  async exportCredentials(): Promise<Record<string, unknown> | null> {
    if (!existsSync(CLAUDE_JSON)) return null
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      if (!root.oauthAccount) return null
      const creds: Record<string, unknown> = {}
      for (const key of CREDENTIAL_KEYS) {
        if (root[key] !== undefined) creds[key] = root[key]
      }
      // Also export access/refresh tokens from ~/.claude/.credentials.json
      if (existsSync(CREDENTIALS_JSON)) {
        try {
          creds._credentialsJson = JSON.parse(readFileSync(CREDENTIALS_JSON, 'utf-8'))
        } catch { /* ignore */ }
      }
      return creds
    } catch {
      return null
    }
  },

  async importCredentials(credentials: Record<string, unknown>): Promise<void> {
    usageSuppressed = true
    let root: Record<string, unknown> = {}
    if (existsSync(CLAUDE_JSON)) {
      try {
        root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      } catch {
        // start fresh
      }
    }
    for (const key of CREDENTIAL_KEYS) {
      if (credentials[key] !== undefined) {
        root[key] = credentials[key]
      }
    }
    writeFileSync(CLAUDE_JSON, JSON.stringify(root, null, 2), 'utf-8')

    // Restore access/refresh tokens to ~/.claude/.credentials.json
    if (credentials._credentialsJson) {
      const dir = join(homedir(), '.claude')
      mkdirSync(dir, { recursive: true })
      writeFileSync(CREDENTIALS_JSON, JSON.stringify(credentials._credentialsJson, null, 2), 'utf-8')
    }
  },

  async clearCredentials(): Promise<void> {
    // Remove auth keys from ~/.claude.json (keep other settings intact)
    if (existsSync(CLAUDE_JSON)) {
      try {
        const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
        for (const key of CREDENTIAL_KEYS) delete root[key]
        writeFileSync(CLAUDE_JSON, JSON.stringify(root, null, 2), 'utf-8')
      } catch { /* ignore */ }
    }
    // Remove the tokens file entirely
    if (existsSync(CREDENTIALS_JSON)) {
      try { unlinkSync(CREDENTIALS_JSON) } catch { /* ignore */ }
    }
  },

  async getUsageInfo(cacheMaxAgeMs = 20 * 60_000): Promise<UsageInfo | null> {
    const cachePath = join(homedir(), '.aide', 'usage.json')

    // Resolve current account for cache ownership check
    let currentAccount: string | null = null
    try {
      if (existsSync(CLAUDE_JSON)) {
        const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
        currentAccount = root.oauthAccount?.emailAddress ?? null
      }
    } catch { /* ignore */ }

    const currentAccountId = resolveSavedClaudeAccountId(currentAccount)
    if (currentAccountId && currentAccount) syncActiveClaudeCredentials(currentAccountId, currentAccount)
    const sharedCache = currentAccountId
      ? getSubscriptionUsageCache(TOOL_ID, currentAccountId)
      : null
    if (sharedCache && Date.now() - sharedCache.fetchedAtMs < cacheMaxAgeMs) {
      const cachedUsage = sharedUsageFromPayload(sharedCache.payload, sharedCache.fetchedAtMs)
      if (cachedUsage) {
        if (usageSuppressed) usageSuppressed = false
        return cachedUsage
      }
      cliLog(LOG_CH, '[usage] shared SQLite cache is missing five_hour or seven_day utilization')
    }

    // ── Try cached file first (shared across multiple AIDE instances) ──
    try {
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
        // If cache has an account field and it doesn't match current → cache miss
        const cacheAccount = cached.account as string | undefined
        const accountMatch = !cacheAccount || !currentAccount || cacheAccount === currentAccount
        if (accountMatch && cached.updatedAt && Date.now() - cached.updatedAt < cacheMaxAgeMs) {
          if (currentAccountId) {
            const sessionBucket = cached.session as Record<string, unknown> | undefined
            const weekBucket = cached.week as Record<string, unknown> | undefined
            setSubscriptionUsageCache(TOOL_ID, currentAccountId, {
              five_hour: { utilization: sessionBucket?.percent, resets_at: sessionBucket?.resets },
              seven_day: { utilization: weekBucket?.percent, resets_at: weekBucket?.resets }
            }, cached.updatedAt, 'aide-file')
          }
          if (usageSuppressed) usageSuppressed = false
          return usageFromCache(cached)
        }
        // Cache expired but we're in backoff and account matches — still use stale cache
        if (accountMatch && usageBackoff.until > Date.now()) {
          return usageFromCache(cached)
        }
      }
    } catch { /* cache miss — proceed to API */ }

    // After app start or account switch, skip API call (cache miss is fine — just show placeholder)
    if (usageSuppressed) {
      usageSuppressed = false
      return { summary: '–', tooltip: 'not available yet', level: 'normal', fetchedAt: Date.now() }
    }

    // If in backoff period and no cache, skip
    if (usageBackoff.until > Date.now()) return null

    // ── Fetch from API ──
    const credsPath = join(homedir(), '.claude', '.credentials.json')
    let accessToken: string | undefined
    try {
      if (existsSync(credsPath)) {
        const creds = JSON.parse(readFileSync(credsPath, 'utf-8'))
        accessToken = creds?.claudeAiOauth?.accessToken
      } else {
        cliLog(LOG_CH, `[usage] credentials file not found: ${credsPath}`)
      }
    } catch (e) {
      cliLog(LOG_CH, `[usage] failed to read credentials: ${e}`)
    }
    if (!accessToken) {
      cliLog(LOG_CH, '[usage] no access token found in credentials')
      return null
    }

    let refreshLeaseOwner: string | null = null
    if (currentAccountId) {
      refreshLeaseOwner = randomUUID()
      const acquired = tryAcquireSubscriptionUsageRefresh(
        TOOL_ID,
        currentAccountId,
        refreshLeaseOwner,
        Date.now(),
        60_000
      )
      if (!acquired) {
        return sharedCache ? sharedUsageFromPayload(sharedCache.payload, sharedCache.fetchedAtMs) : null
      }
    }

    try {
      const usageSession = session.fromPartition('claude-usage-api', { cache: false })
      const proxyAddr = resolveProxyAddress()
      await usageSession.setProxy({ proxyRules: proxyAddr ?? '' })

      const userAgent = `claude-cli/${detectedCliVersion ?? '1.0.0'} (external, cli)`
      const res = await usageSession.fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': userAgent,
          'anthropic-beta': 'oauth-2025-04-20',
          'x-app': 'cli',
          'Content-Type': 'application/json'
        }
      })
      if (!res.ok) {
        if (res.status === 429) {
          // Exponential backoff: use retry-after header or double the delay
          const retryAfter = res.headers.get('retry-after')
          const delaySec = retryAfter ? parseInt(retryAfter, 10) : 0
          const backoffMs = delaySec > 0
            ? delaySec * 1000
            : Math.min(usageBackoff.delay * 2, 30 * 60 * 1000) // max 30 min
          usageBackoff.delay = backoffMs
          usageBackoff.until = Date.now() + backoffMs
          cliLog(LOG_CH, `[usage] 429 rate limited, backing off ${Math.round(backoffMs / 1000)}s`)
        } else {
          const body = await res.text().catch(() => '')
          cliLog(LOG_CH, `[usage] API returned ${res.status} ${res.statusText}: ${body}`)
        }
        return null
      }

      // Success — reset backoff
      usageBackoff.delay = 60_000
      usageBackoff.until = 0

      const data = (await res.json()) as Record<string, unknown>

      const expectedBuckets = [
        ['five_hour', data.five_hour],
        ['seven_day', data.seven_day]
      ] as const
      const responseAnomalies: string[] = []
      for (const [key, value] of expectedBuckets) {
        if (!value || typeof value !== 'object') {
          responseAnomalies.push(`missing ${key}`)
          continue
        }
        const bucket = value as Record<string, unknown>
        if (typeof bucket.utilization !== 'number') responseAnomalies.push(`${key}.utilization invalid`)
        if (bucket.utilization !== 0 &&
            (typeof bucket.resets_at !== 'string' || Number.isNaN(new Date(bucket.resets_at).getTime()))) {
          responseAnomalies.push(`${key}.resets_at invalid`)
        }
      }
      if (responseAnomalies.length > 0) {
        cliLog(LOG_CH, `[usage] response anomaly (${responseAnomalies.join(', ')}): ${JSON.stringify(data)}`)
      }

      const now = Date.now()
      const result = sharedUsageFromPayload(data, now)
      if (!result) {
        cliLog(LOG_CH, `[usage] required utilization buckets not found in response: ${JSON.stringify(data)}`)
        return null
      }

      if (currentAccountId) {
        setSubscriptionUsageCache(TOOL_ID, currentAccountId, data, now, 'aide')
      }

      // ── Write cache ──
      try {
        const dir = join(homedir(), '.aide')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

        const toCache = (b?: { utilization: number | null; resets_at?: string }): { percent: number; resets: string } => ({
          percent: b ? Math.round(b.utilization!) : 0,
          // Preserve the server timestamp. Formatting it before persistence
          // previously made fresh and cached tooltips alternate between a full
          // date and a bare hour.
          resets: b?.resets_at ?? ''
        })

        const fiveHour = data.five_hour as { utilization: number | null; resets_at?: string } | undefined
        const sevenDay = data.seven_day as { utilization: number | null; resets_at?: string } | undefined
        if (fiveHour?.utilization == null || sevenDay?.utilization == null) {
          throw new Error('required five_hour or seven_day bucket is missing; cache was not updated')
        }

        const cacheData = {
          account: currentAccount ?? undefined,
          session: toCache(fiveHour),
          week: toCache(sevenDay),
          updatedAt: Date.now()
        }

        const tmp = cachePath + '.tmp'
        writeFileSync(tmp, JSON.stringify(cacheData, null, 2), 'utf-8')
        renameSync(tmp, cachePath)
      } catch (e) {
        cliLog(LOG_CH, `[usage] failed to write cache: ${e}`)
      }

      return result
    } catch (e) {
      cliLog(LOG_CH, `[usage] fetch error: ${e}`)
      return null
    } finally {
      if (currentAccountId && refreshLeaseOwner) {
        releaseSubscriptionUsageRefresh(TOOL_ID, currentAccountId, refreshLeaseOwner)
      }
    }
  },

  async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
    if (candidatePids.length === 0) return null
    try {
      const procs = await listProcesses()
      // Handles multi-hop chains: powershell → cmd.exe (npm shim) → claude.exe on
      // Windows, or bash → node → claude on Linux.
      return resolveOwnerPidFromSnapshot(procs, candidatePids, (name) => name.startsWith('claude'))
    } catch (e) {
      cliLog(LOG_CH, `[resolveOwnerPid] failed: ${e}`)
      return null
    }
  },

  detectTitleEvent(tabId: string, prevTitle: string | null, newTitle: string): void {
    // Detect transition into CompletedAndWaiting state:
    // Claude Code sets the title to a string starting with ✳ (U+2733) when it has
    // finished processing and is waiting for user input.
    const isWaiting = (t: string): boolean => t.codePointAt(0) === 0x2733
    if (prevTitle !== null && !isWaiting(prevTitle) && isWaiting(newTitle)) {
      signalByTab.get(tabId)?.('completeAndWait')
    }
  },

  /** Register the signal callback for a tab. Called by PtyManager at spawn time. */
  registerSignalHandler(tabId: string, handler: (event: string) => void): void {
    signalByTab.set(tabId, handler)
  },

  /** Remove the signal callback for a closed tab. */
  deregisterTab(tabId: string): void {
    signalByTab.delete(tabId)
    cleanupTabHookSettings(tabId)
  },

  getSessionPreview(projectPath: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    return Promise.resolve(readSessionPreview(getSessionsDir(projectPath), sessionId))
  },

  getSessionHistory(projectPath: string, sessionId: string) {
    return readSessionHistory(getSessionsDir(projectPath), sessionId)
  },

  subscribeToSessionHistory(
    projectPath: string,
    sessionId: string,
    onEntry: (entry: HistoryEntry) => void
  ): () => void {
    const filePath = join(getSessionsDir(projectPath), `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return () => {}

    let stopped = false
    let watcher: FSWatcher | null = null

    // Track current file size so we only read new content
    let offset = 0
    try {
      const fd = openSync(filePath, 'r')
      offset = fstatSync(fd).size
      closeSync(fd)
    } catch { /* ignore */ }

    const readNewEntries = () => {
      if (stopped || !existsSync(filePath)) return

      let fd: number
      try {
        fd = openSync(filePath, 'r')
      } catch {
        return
      }

      try {
        const fileSize = fstatSync(fd)
        if (fileSize.size <= offset) return

        const len = fileSize.size - offset
        const buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, offset)
        offset = fileSize.size

        const text = buf.toString('utf-8')
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const entry = parseHistoryLine(trimmed)
          if (entry && !stopped) onEntry(entry)
        }
      } finally {
        closeSync(fd)
      }
    }

    try {
      watcher = watch(filePath, () => readNewEntries())
    } catch { /* ignore */ }

    return () => {
      stopped = true
      watcher?.close()
    }
  },

  getSessionFilePath(projectPath: string, sessionId: string): string {
    return join(getSessionsDir(projectPath), `${sessionId}.jsonl`)
  },

  contextInsert(relPath: string): string {
    return `@${relPath}`
  },

  parseThinkingBlocks(line: string): string[] {
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
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    const sessionsDir = getSessionsDir(projectPath)
    return watchSessionsDir(sessionsDir, (sessionId: string) => {
      onNew({
        sessionId,
        slug: TOOL_NAME,
        lastModified: new Date()
      })
    })
  }
}
