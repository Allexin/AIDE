import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { session } from 'electron'
import type { CliTool, CliSession, SettingsField, UsageInfo } from './types'
import { scanSessions as scanDiskSessions, watchSessionsDir, getSessionsDir, readSessionPreview } from './claudeCodeScanner'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import { cliLog } from './cliLogger'

const LOG_CH = 'Claude Code Errors'
const TOOL_NAME = 'Claude Code'

/** Detected CLI version, parsed from the startup banner ("Claude Code vX.Y.Z"). */
let detectedCliVersion: string | null = null

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

function usageFromCache(cached: Record<string, unknown>): UsageInfo {
  const s = (cached.session as Record<string, unknown>)?.percent as number ?? 0
  const w = (cached.week as Record<string, unknown>)?.percent as number ?? 0
  const maxP = Math.max(s, w)
  const lvl: UsageInfo['level'] = maxP >= 90 ? 'critical' : maxP >= 70 ? 'warn' : 'normal'
  const sResets = (cached.session as Record<string, unknown>)?.resets as string ?? ''
  const wResets = (cached.week as Record<string, unknown>)?.resets as string ?? ''
  return {
    summary: `${s}% / ${w}%`,
    tooltip: `session: ${s}%${sResets ? ` resets ${sResets}` : ''}\nweek: ${w}%${wResets ? ` resets ${wResets}` : ''}`,
    level: lvl,
    fetchedAt: (cached.updatedAt as number) || Date.now()
  }
}

export const claudeCodeTool: CliTool = {
  id: 'claude-code',
  name: TOOL_NAME,

  installUrl: 'https://claude.ai/download',

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('where', ['claude'], { timeout: 3000 }, (err) => resolve(!err))
    })
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
      https_proxy: addr
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
      lastModified: new Date(s.mtime)
    }))
  },

  resumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`
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

  async credentialsMatch(saved: Record<string, unknown>): Promise<boolean> {
    if (!existsSync(CLAUDE_JSON)) return false
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      const currentOauth = root.oauthAccount
      const savedOauth = saved.oauthAccount as Record<string, unknown> | undefined
      if (!currentOauth || !savedOauth) return false
      return currentOauth.accountUuid === savedOauth.accountUuid
        && currentOauth.emailAddress === savedOauth.emailAddress
    } catch {
      return false
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

  async getUsageInfo(): Promise<UsageInfo | null> {
    const CACHE_MAX_AGE = 7 * 60 * 1000 // 7 minutes
    const cachePath = join(homedir(), '.aide', 'usage.json')

    // Resolve current account for cache ownership check
    let currentAccount: string | null = null
    try {
      if (existsSync(CLAUDE_JSON)) {
        const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
        currentAccount = root.oauthAccount?.emailAddress ?? null
      }
    } catch { /* ignore */ }

    // ── Try cached file first (shared across multiple AIDE instances) ──
    try {
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
        // If cache has an account field and it doesn't match current → cache miss
        const cacheAccount = cached.account as string | undefined
        const accountMatch = !cacheAccount || !currentAccount || cacheAccount === currentAccount
        if (accountMatch && cached.updatedAt && Date.now() - cached.updatedAt < CACHE_MAX_AGE) {
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

      const parts: string[] = []
      const tipParts: string[] = []
      let maxUtil = 0

      for (const [key, val] of Object.entries(data)) {
        if (val && typeof val === 'object' && 'utilization' in (val as Record<string, unknown>)) {
          const bucket = val as { utilization: number | null; resets_at?: string }
          if (bucket.utilization == null) continue
          const util = bucket.utilization
          if (util > maxUtil) maxUtil = util
          const label = key.replace(/_/g, ' ')
          parts.push(`${Math.round(util)}%`)
          const resetStr = bucket.resets_at
            ? ` resets ${new Date(bucket.resets_at).toLocaleString(undefined, { timeZoneName: 'short' })}`
            : ''
          tipParts.push(`${label}: ${Math.round(util)}%${resetStr}`)
        }
      }

      if (parts.length === 0) {
        cliLog(LOG_CH, `[usage] no utilization buckets found in response: ${JSON.stringify(data)}`)
        return null
      }

      const level: UsageInfo['level'] = maxUtil >= 90 ? 'critical' : maxUtil >= 70 ? 'warn' : 'normal'
      const now = Date.now()
      const result: UsageInfo = {
        summary: parts.join(' / '),
        tooltip: tipParts.join('\n'),
        level,
        fetchedAt: now
      }

      // ── Write cache ──
      try {
        const dir = join(homedir(), '.aide')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

        const bucketEntries = Object.entries(data)
          .filter(([, v]) => v && typeof v === 'object' && 'utilization' in (v as Record<string, unknown>))
          .map(([, v]) => v as { utilization: number | null; resets_at?: string })
          .filter((b) => b.utilization != null)

        const toCache = (b?: { utilization: number | null; resets_at?: string }): { percent: number; resets: string } => ({
          percent: b ? Math.round(b.utilization!) : 0,
          resets: b?.resets_at ? new Date(b.resets_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: undefined }) : ''
        })

        const cacheData = {
          account: currentAccount ?? undefined,
          session: toCache(bucketEntries[0]),
          week: toCache(bucketEntries[1]),
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
    }
  },

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
          (err, stdout) => {
            if (err) reject(err)
            else resolve(stdout.trim())
          }
        )
      })
      if (!json) return null
      const parsed = JSON.parse(json)
      const allProcs: Array<{ ProcessId: number; ParentProcessId: number; Name: string }> = Array.isArray(parsed)
        ? parsed
        : [parsed]

      // Build parent map for ancestor chain traversal
      const parentMap = new Map<number, number>()
      for (const proc of allProcs) {
        parentMap.set(proc.ProcessId, proc.ParentProcessId)
      }

      const pidSet = new Set(candidatePids)

      // Walk up from a given PID to find the first ancestor that is one of our candidate PTY PIDs.
      // This handles multi-hop chains: powershell → cmd.exe (npm shim) → claude.exe
      const findAncestorInSet = (startPid: number): number | null => {
        let pid = startPid
        const visited = new Set<number>()
        while (pid && pid !== 0 && !visited.has(pid)) {
          if (pidSet.has(pid)) return pid
          visited.add(pid)
          pid = parentMap.get(pid) ?? 0
        }
        return null
      }

      // Collect all claude-related processes descended from one of our candidate PTYs
      const matches: Array<{ pid: number; ancestor: number }> = []
      for (const proc of allProcs) {
        if (!(proc.Name ?? '').toLowerCase().startsWith('claude')) continue
        const ancestor = findAncestorInSet(proc.ParentProcessId)
        if (ancestor !== null) {
          matches.push({ pid: proc.ProcessId, ancestor })
        }
      }

      if (matches.length === 0) return null

      // When multiple tabs are waiting: pick the most recently started claude (highest PID)
      // so that each new session file is matched to the tab that just launched it.
      matches.sort((a, b) => b.pid - a.pid)
      return matches[0].ancestor
    } catch (e) {
      cliLog(LOG_CH, `[resolveOwnerPid] failed: ${e}`)
      return null
    }
  },

  detectTitleEvent(prevTitle: string | null, newTitle: string): string | null {
    // Detect transition into CompletedAndWaiting state:
    // Claude Code sets the title to a string starting with ✳ (U+2733) when it has
    // finished processing and is waiting for user input.
    // prevTitle === null means this is the very first title (startup) — skip it.
    const isWaiting = (t: string): boolean => t.codePointAt(0) === 0x2733
    if (prevTitle !== null && !isWaiting(prevTitle) && isWaiting(newTitle)) {
      return 'completeAndWait'
    }
    return null
  },

  getSessionPreview(projectPath: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    return Promise.resolve(readSessionPreview(getSessionsDir(projectPath), sessionId))
  },

  getSessionFilePath(projectPath: string, sessionId: string): string {
    return join(getSessionsDir(projectPath), `${sessionId}.jsonl`)
  },

  contextInsert(relPath: string): string {
    return `@${relPath}`
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
