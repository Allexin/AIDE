import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { session } from 'electron'
import type { CliTool, SettingsField, UsageInfo } from './types'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import { cliLog } from './cliLogger'
import {
  getCursorSessionFilePath,
  parseCursorThinkingBlocks,
  readCursorSessionHistory,
  readCursorSessionPreview,
  scanCursorSessions,
  watchCursorSessions
} from './cursorAgentScanner'
import { readCursorStoreHistory, watchCursorStoreHistory } from './cursorAgentStoreScanner'

const TOOL_ID = 'cursor-agent'
const TOOL_NAME = 'Cursor Agent CLI'
const LOG_CH = 'Cursor Agent CLI'
const APP_USER_KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'
const DEFAULT_BACKEND_URL = 'https://api2.cursor.sh'
const USAGE_CACHE_PATH = join(homedir(), '.aide', 'cursor-agent-usage.json')
const USAGE_CACHE_MAX_AGE_MS = 5 * 60 * 1000
const USAGE_BACKOFF_BASE_MS = 60_000
const USAGE_BACKOFF_MAX_MS = 30 * 60 * 1000
const INACTIVITY_THRESHOLD = 5 // seconds of silence -> completeAndWait (same behavior as Qwen/OpenCode)

type BetterSqlite3Database = import('better-sqlite3').Database

interface CursorAuthJson {
  accessToken?: string
  refreshToken?: string
  [key: string]: unknown
}

interface CursorAccountBundle {
  email?: string
  accessToken?: string
  refreshToken?: string
  signUpType?: string
  membershipType?: string
  subscriptionStatus?: string
  openAIKey?: string
  claudeKey?: string
  googleKey?: string
  teamIds?: unknown[]
  backendUrl?: string
  authClientId?: string
}

interface CursorStateAppUser {
  membershipType?: string
  subscriptionStatus?: string
  cursorCreds?: {
    backendUrl?: string
    authClientId?: string
    [key: string]: unknown
  }
  aiSettings?: {
    teamIds?: unknown[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface CursorUsageCache {
  account: string | null
  summary: string
  tooltip: string
  level: UsageInfo['level']
  hasLimit: boolean
  fetchedAt: number
}

const usageBackoff = { delay: USAGE_BACKOFF_BASE_MS, until: 0 }
let usageSuppressed = true
const warnedKeys = new Set<string>()

interface InactivityState {
  counter: number
  interval: ReturnType<typeof setInterval>
}
const inactivityByTab = new Map<string, InactivityState>()
const signalByTab = new Map<string, (event: string) => void>()

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  cliLog(LOG_CH, `[warn] ${message}`)
}

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

function cleanupInactivity(tabId: string): void {
  const state = inactivityByTab.get(tabId)
  if (state) {
    clearInterval(state.interval)
    inactivityByTab.delete(tabId)
  }
  signalByTab.delete(tabId)
}

function resolveProxyAddress(): string | null {
  const addr = (getToolConfig(TOOL_ID).proxy as string) ?? ''
  return addr || null
}

function getCursorRootDir(): string {
  const appData = process.env.APPDATA
  return appData ? join(appData, 'Cursor') : join(homedir(), 'AppData', 'Roaming', 'Cursor')
}

function getCursorAuthPath(): string {
  return join(getCursorRootDir(), 'auth.json')
}

function getCursorStateDbPath(): string {
  return join(getCursorRootDir(), 'User', 'globalStorage', 'state.vscdb')
}

function openStateDb(readonly: boolean): BetterSqlite3Database | null {
  const dbPath = getCursorStateDbPath()
  if (!existsSync(dbPath)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    return new Database(dbPath, { readonly, fileMustExist: true })
  } catch (e) {
    cliLog(LOG_CH, `[account] failed to open Cursor state db: ${e}`)
    return null
  }
}

function decodeSqlValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value == null) return null
  try {
    return Buffer.from(value as Buffer | Uint8Array).toString('utf-8')
  } catch {
    return null
  }
}

function readAuthJson(): CursorAuthJson {
  const authPath = getCursorAuthPath()
  if (!existsSync(authPath)) return {}
  try {
    return JSON.parse(readFileSync(authPath, 'utf-8')) as CursorAuthJson
  } catch {
    return {}
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

function readStateKeyMap(keys: string[]): Record<string, string> {
  if (keys.length === 0) return {}
  const db = openStateDb(true)
  if (!db) return {}
  try {
    const placeholders = keys.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`)
      .all(...keys) as Array<{ key: string; value: unknown }>
    const out: Record<string, string> = {}
    for (const row of rows) {
      const decoded = decodeSqlValue(row.value)
      if (decoded != null) out[row.key] = decoded
    }
    return out
  } catch (e) {
    warnOnce(
      'account-state-read',
      `Failed to read Cursor state.vscdb keys. Cursor account storage schema may have changed: ${String(e)}`
    )
    cliLog(LOG_CH, `[account] failed to read state keys: ${e}`)
    return {}
  } finally {
    db.close()
  }
}

function readAppUserFromStateDb(): CursorStateAppUser {
  const keyMap = readStateKeyMap([APP_USER_KEY])
  const raw = keyMap[APP_USER_KEY]
  if (!raw) return {}
  try {
    return JSON.parse(raw) as CursorStateAppUser
  } catch {
    warnOnce(
      'account-app-user-json',
      `Cursor applicationUser JSON is unreadable (key=${APP_USER_KEY}). Account sync will stay in best-effort mode.`
    )
    return {}
  }
}

function loadCurrentAccountBundle(): CursorAccountBundle {
  const auth = readAuthJson()
  const keyMap = readStateKeyMap([
    'cursorAuth/accessToken',
    'cursorAuth/refreshToken',
    'cursorAuth/cachedEmail',
    'cursorAuth/cachedSignUpType',
    'cursorAuth/stripeMembershipType',
    'cursorAuth/stripeSubscriptionStatus',
    'cursorAuth/openAIKey',
    'cursorAuth/claudeKey',
    'cursorAuth/googleKey'
  ])
  const appUser = readAppUserFromStateDb()
  const stateAccessToken = keyMap['cursorAuth/accessToken']
  const stateRefreshToken = keyMap['cursorAuth/refreshToken']
  if (!stateAccessToken && !stateRefreshToken && (auth.accessToken || auth.refreshToken)) {
    warnOnce(
      'account-keys-missing',
      'Cursor account keys are missing in state.vscdb while auth.json contains tokens. Account sync will continue in degraded compatibility mode.'
    )
  }

  return {
    email: keyMap['cursorAuth/cachedEmail'],
    accessToken: stateAccessToken || auth.accessToken,
    refreshToken: stateRefreshToken || auth.refreshToken,
    signUpType: keyMap['cursorAuth/cachedSignUpType'],
    membershipType: keyMap['cursorAuth/stripeMembershipType'] || appUser.membershipType,
    subscriptionStatus: keyMap['cursorAuth/stripeSubscriptionStatus'] || appUser.subscriptionStatus,
    openAIKey: keyMap['cursorAuth/openAIKey'],
    claudeKey: keyMap['cursorAuth/claudeKey'],
    googleKey: keyMap['cursorAuth/googleKey'],
    teamIds: Array.isArray(appUser.aiSettings?.teamIds) ? appUser.aiSettings?.teamIds : [],
    backendUrl: appUser.cursorCreds?.backendUrl || DEFAULT_BACKEND_URL,
    authClientId: appUser.cursorCreds?.authClientId
  }
}

function writeAccountBundle(bundle: CursorAccountBundle): void {
  const authPath = getCursorAuthPath()
  const prevAuth = readAuthJson()
  const nextAuth: CursorAuthJson = {
    ...prevAuth,
    accessToken: bundle.accessToken ?? '',
    refreshToken: bundle.refreshToken ?? ''
  }
  writeJsonAtomic(authPath, nextAuth)

  const db = openStateDb(false)
  if (!db) return

  try {
    const currentAppUser = readAppUserFromStateDb()
    const tx = db.transaction(() => {
      const upsert = db.prepare(`
        INSERT INTO ItemTable(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `)

      upsert.run('cursorAuth/accessToken', bundle.accessToken ?? '')
      upsert.run('cursorAuth/refreshToken', bundle.refreshToken ?? '')
      upsert.run('cursorAuth/cachedEmail', bundle.email ?? '')
      upsert.run('cursorAuth/cachedSignUpType', bundle.signUpType ?? '')
      upsert.run('cursorAuth/stripeMembershipType', bundle.membershipType ?? '')
      upsert.run('cursorAuth/stripeSubscriptionStatus', bundle.subscriptionStatus ?? '')
      upsert.run('cursorAuth/openAIKey', bundle.openAIKey ?? '')
      upsert.run('cursorAuth/claudeKey', bundle.claudeKey ?? '')
      upsert.run('cursorAuth/googleKey', bundle.googleKey ?? '')

      const nextAppUser: CursorStateAppUser = {
        ...currentAppUser,
        membershipType: bundle.membershipType ?? currentAppUser.membershipType,
        subscriptionStatus: bundle.subscriptionStatus ?? currentAppUser.subscriptionStatus,
        aiSettings: {
          ...(currentAppUser.aiSettings ?? {}),
          teamIds: Array.isArray(bundle.teamIds) ? bundle.teamIds : (currentAppUser.aiSettings?.teamIds ?? [])
        }
      }
      upsert.run(APP_USER_KEY, JSON.stringify(nextAppUser))
    })
    tx()
  } catch (e) {
    warnOnce(
      'account-state-write',
      `Failed to write Cursor account state keys. Cursor storage schema may have changed: ${String(e)}`
    )
  } finally {
    db.close()
  }
}

function formatUsdFromCents(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '$0.00'
  return `$${(cents / 100).toFixed(2)}`
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizePercent(value: unknown): number | null {
  const n = asFiniteNumber(value)
  if (n == null) return null
  // Cursor may return either 0..1 fraction or 0..100 percent.
  return n <= 1 ? Math.round(n * 100) : Math.round(n)
}

function pickField(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key]
  }
  return undefined
}

function pickNumberField(obj: Record<string, unknown>, keys: string[]): number | null {
  return asFiniteNumber(pickField(obj, keys))
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  const value = pickField(obj, keys)
  return typeof value === 'string' ? value : null
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function usageFromCache(cached: CursorUsageCache): UsageInfo {
  return {
    summary: cached.summary,
    tooltip: cached.tooltip,
    level: cached.level,
    fetchedAt: cached.fetchedAt,
    hasLimit: cached.hasLimit
  }
}

function readUsageCache(currentAccount: string | null): CursorUsageCache | null {
  if (!existsSync(USAGE_CACHE_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(USAGE_CACHE_PATH, 'utf-8')) as CursorUsageCache
    if ((parsed.account ?? null) !== (currentAccount ?? null)) return null
    return parsed
  } catch {
    return null
  }
}

function writeUsageCache(cache: CursorUsageCache): void {
  writeJsonAtomic(USAGE_CACHE_PATH, cache)
}

async function fetchCursorUsagePayloads(
  accessToken: string,
  backendUrl: string
): Promise<{ usage: Record<string, unknown>; plan: Record<string, unknown> } | null> {
  const usageSession = session.fromPartition('cursor-agent-usage-api', { cache: false })
  const proxyAddr = resolveProxyAddress()
  await usageSession.setProxy({ proxyRules: proxyAddr ?? '' })

  const requestHeaders = (): Record<string, string> => {
    const requestId = randomUUID()
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
      'X-Amzn-Trace-Id': `Root=${requestId}`,
      'x-cursor-client-type': 'ide',
      'x-cursor-client-device-type': 'desktop'
    }
  }

  const call = async (method: string): Promise<Record<string, unknown> | null> => {
    const res = await usageSession.fetch(`${backendUrl}/aiserver.v1.DashboardService/${method}`, {
      method: 'POST',
      headers: requestHeaders(),
      body: '{}'
    })

    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after')
        const retryAfterSec = retryAfter ? parseInt(retryAfter, 10) : 0
        const delayMs = retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(usageBackoff.delay * 2, USAGE_BACKOFF_MAX_MS)
        usageBackoff.delay = delayMs
        usageBackoff.until = Date.now() + delayMs
        cliLog(LOG_CH, `[usage] 429 for ${method}, backing off ${Math.round(delayMs / 1000)}s`)
      } else {
        cliLog(LOG_CH, `[usage] ${method} failed: ${res.status} ${res.statusText}`)
      }
      return null
    }

    usageBackoff.delay = USAGE_BACKOFF_BASE_MS
    usageBackoff.until = 0
    return await res.json() as Record<string, unknown>
  }

  const usage = await call('GetCurrentPeriodUsage')
  if (!usage) return null
  const plan = await call('GetPlanInfo')
  if (!plan) return null
  return { usage, plan }
}

async function refreshCursorAccessToken(bundle: CursorAccountBundle): Promise<CursorAccountBundle> {
  const refreshToken = bundle.refreshToken
  if (!refreshToken) return bundle
  if (!bundle.authClientId) return bundle
  const backendUrl = bundle.backendUrl || DEFAULT_BACKEND_URL

  const usageSession = session.fromPartition('cursor-agent-usage-api', { cache: false })
  const proxyAddr = resolveProxyAddress()
  await usageSession.setProxy({ proxyRules: proxyAddr ?? '' })

  try {
    const res = await usageSession.fetch(`${backendUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: bundle.authClientId,
        refresh_token: refreshToken
      })
    })
    if (!res.ok) return bundle
    const payload = await res.json() as { access_token?: string; refresh_token?: string }
    if (!payload.access_token) return bundle

    const refreshed: CursorAccountBundle = {
      ...bundle,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? bundle.refreshToken
    }
    writeAccountBundle(refreshed)
    return refreshed
  } catch {
    return bundle
  }
}

export const cursorAgentTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,
  installUrl: 'https://cursor.com/docs/cli/installation',

  async isInstalled(): Promise<boolean> {
    const inPath = await new Promise<boolean>((resolve) => {
      execFile('where', ['agent'], { timeout: 3000 }, (err) => resolve(!err))
    })
    if (inPath) return true

    return new Promise<boolean>((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-Command agent -ErrorAction SilentlyContinue'],
        { timeout: 5000 },
        (err, stdout) => resolve(!err && stdout.trim().length > 0)
      )
    })
  },

  newSessionCommand(): string {
    return 'agent'
  },

  resumeCommand(sessionId: string): string {
    return `agent --resume "${sessionId}"`
  },

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (
      accumulated.includes('is not recognized') ||
      accumulated.includes('command not found') ||
      accumulated.includes('Cannot find module')
    ) {
      return 'dead'
    }

    if (
      accumulated.includes('Cursor Agent') ||
      accumulated.includes('cursor.com') ||
      accumulated.includes('Press') ||
      accumulated.includes('\x1b[')
    ) {
      return 'ok'
    }

    if (elapsedMs > 15000) return 'ok'
    return 'pending'
  },

  async scanSessions(projectPath: string) {
    return scanCursorSessions(projectPath, TOOL_NAME)
  },

  watchForNewSessions(projectPath: string, onNew): () => void {
    return watchCursorSessions(projectPath, TOOL_NAME, onNew)
  },

  getSessionPreview(projectPath: string, sessionId: string) {
    return readCursorSessionPreview(projectPath, sessionId)
  },

  async getSessionHistory(projectPath: string, sessionId: string) {
    const fromStore = readCursorStoreHistory(sessionId)
    if (fromStore.length > 0) return fromStore
    return readCursorSessionHistory(projectPath, sessionId)
  },

  subscribeToSessionHistory(projectPath: string, sessionId: string, onEntry) {
    void projectPath
    return watchCursorStoreHistory(sessionId, onEntry)
  },

  getSessionFilePath(projectPath: string, sessionId: string): string {
    return getCursorSessionFilePath(projectPath, sessionId)
  },

  async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
    if (candidatePids.length === 0) {
      cliLog(LOG_CH, '[resolveOwnerPid] skipped: no candidate PTY PIDs')
      return null
    }
    cliLog(LOG_CH, `[resolveOwnerPid] candidates=[${candidatePids.join(', ')}]`)
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
      if (!json) {
        cliLog(LOG_CH, '[resolveOwnerPid] no process snapshot data')
        return null
      }

      const parsed = JSON.parse(json)
      const allProcs: Array<{ ProcessId: number; ParentProcessId: number; Name: string }> =
        Array.isArray(parsed) ? parsed : [parsed]
      cliLog(LOG_CH, `[resolveOwnerPid] process snapshot size=${allProcs.length}`)

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
        const name = (proc.Name ?? '').toLowerCase()
        // Cursor CLI process names observed on Windows are expected to include
        // "agent" (e.g. agent.exe), sometimes wrapped by cursor launchers.
        if (!name.startsWith('agent') && !name.includes('cursor')) continue
        const ancestor = findAncestor(proc.ParentProcessId)
        if (ancestor !== null) matches.push({ pid: proc.ProcessId, ancestor })
      }

      if (matches.length === 0) {
        warnOnce(
          'owner-pid-no-match',
          'Could not map new Cursor Agent session to a PTY tab (no matching descendants). If Cursor changed process naming/launch chain, mapping rules may need updates.'
        )
        cliLog(LOG_CH, '[resolveOwnerPid] no matching Cursor/Agent descendants for candidate PTYs')
        return null
      }

      matches.sort((a, b) => b.pid - a.pid)
      const chosen = matches[0]
      const sample = matches
        .slice(0, 5)
        .map((m) => `${m.pid}->${m.ancestor}`)
        .join(', ')
      cliLog(LOG_CH, `[resolveOwnerPid] matches=${matches.length} sample=[${sample}] chosen=${chosen.pid}->${chosen.ancestor}`)
      return chosen.ancestor
    } catch (e) {
      warnOnce(
        'owner-pid-failed',
        `Failed to resolve Cursor Agent owner PID from process tree. Session assignment may be degraded: ${String(e)}`
      )
      cliLog(LOG_CH, `[resolveOwnerPid] failed: ${e}`)
      return null
    }
  },

  contextInsert(relPath: string): string {
    // Cursor Agent does not auto-attach file contents from @path at the moment,
    // but inserting the reference is still useful for fast prompt authoring.
    return `@${relPath}`
  },

  onPtyActivity(tabId: string): void {
    ensureInactivityTimer(tabId)
  },

  registerSignalHandler(tabId: string, handler: (event: string) => void): void {
    signalByTab.set(tabId, handler)
  },

  deregisterTab(tabId: string): void {
    cleanupInactivity(tabId)
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
      HTTPS_PROXY: addr,
      http_proxy: addr,
      https_proxy: addr
    }
  },

  hasAccountSystem(): boolean {
    return true
  },

  async isLoggedIn(): Promise<boolean> {
    const bundle = loadCurrentAccountBundle()
    return !!bundle.accessToken
  },

  async getLoginIdentifier(): Promise<string | null> {
    const bundle = loadCurrentAccountBundle()
    return bundle.email ?? null
  },

  async exportCredentials(): Promise<Record<string, unknown> | null> {
    const bundle = loadCurrentAccountBundle()
    if (!bundle.accessToken || !bundle.refreshToken) return null
    return bundle as Record<string, unknown>
  },

  async importCredentials(credentials: Record<string, unknown>): Promise<void> {
    usageSuppressed = true
    const current = loadCurrentAccountBundle()
    const next: CursorAccountBundle = {
      ...current,
      email: typeof credentials.email === 'string' ? credentials.email : current.email,
      accessToken: typeof credentials.accessToken === 'string' ? credentials.accessToken : current.accessToken,
      refreshToken: typeof credentials.refreshToken === 'string' ? credentials.refreshToken : current.refreshToken,
      signUpType: typeof credentials.signUpType === 'string' ? credentials.signUpType : current.signUpType,
      membershipType: typeof credentials.membershipType === 'string' ? credentials.membershipType : current.membershipType,
      subscriptionStatus: typeof credentials.subscriptionStatus === 'string' ? credentials.subscriptionStatus : current.subscriptionStatus,
      openAIKey: typeof credentials.openAIKey === 'string' ? credentials.openAIKey : current.openAIKey,
      claudeKey: typeof credentials.claudeKey === 'string' ? credentials.claudeKey : current.claudeKey,
      googleKey: typeof credentials.googleKey === 'string' ? credentials.googleKey : current.googleKey,
      teamIds: Array.isArray(credentials.teamIds) ? credentials.teamIds : current.teamIds
    }
    writeAccountBundle(next)
  },

  async clearCredentials(): Promise<void> {
    usageSuppressed = true
    const current = loadCurrentAccountBundle()
    const next: CursorAccountBundle = {
      ...current,
      email: '',
      accessToken: '',
      refreshToken: '',
      signUpType: '',
      membershipType: '',
      subscriptionStatus: '',
      openAIKey: '',
      claudeKey: '',
      googleKey: '',
      teamIds: []
    }
    writeAccountBundle(next)
  },

  async getUsageInfo(): Promise<UsageInfo | null> {
    const bundle = loadCurrentAccountBundle()
    const currentAccount = bundle.email ?? null

    const cached = readUsageCache(currentAccount)
    if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_MAX_AGE_MS) {
      if (usageSuppressed) usageSuppressed = false
      return usageFromCache(cached)
    }

    if (usageSuppressed) {
      usageSuppressed = false
      return {
        summary: '–',
        tooltip: 'not available yet',
        level: 'normal',
        fetchedAt: Date.now()
      }
    }

    if (usageBackoff.until > Date.now()) {
      return cached ? usageFromCache(cached) : null
    }

    let accessToken = bundle.accessToken
    if (!accessToken) return null
    const backendUrl = bundle.backendUrl || DEFAULT_BACKEND_URL

    let payloads = await fetchCursorUsagePayloads(accessToken, backendUrl)
    if (!payloads) {
      const refreshed = await refreshCursorAccessToken(bundle)
      if (refreshed.accessToken && refreshed.accessToken !== accessToken) {
        accessToken = refreshed.accessToken
        payloads = await fetchCursorUsagePayloads(accessToken, backendUrl)
      }
    }
    if (!payloads) return cached ? usageFromCache(cached) : null

    const usage = payloads.usage
    const plan = payloads.plan
    const planUsage = (
      (usage.plan_usage as Record<string, unknown> | undefined) ??
      (usage.planUsage as Record<string, unknown> | undefined) ??
      {}
    )
    const planInfo = (
      (plan.plan_info as Record<string, unknown> | undefined) ??
      (plan.planInfo as Record<string, unknown> | undefined) ??
      {}
    )

    // On some Pro accounts, total_spend/limit represent on-demand values only.
    // Prefer subscription-related usage fields with robust fallbacks.
    const totalSpend = pickNumberField(planUsage, ['total_spend', 'totalSpend']) ?? 0
    const includedSpend = pickNumberField(planUsage, ['included_spend', 'includedSpend']) ?? 0
    const bonusSpend = pickNumberField(planUsage, ['bonus_spend', 'bonusSpend']) ?? 0
    const apiSpend = pickNumberField(planUsage, ['api_spend', 'apiSpend']) ?? 0
    const autoSpend = pickNumberField(planUsage, ['auto_spend', 'autoSpend']) ?? 0

    const limitFromUsage = pickNumberField(planUsage, ['limit']) ?? 0
    const apiLimit = pickNumberField(planUsage, ['api_limit', 'apiLimit']) ?? 0
    const autoLimit = pickNumberField(planUsage, ['auto_limit', 'autoLimit']) ?? 0
    const includedAmountFromPlan = pickNumberField(planInfo, ['included_amount_cents', 'includedAmountCents']) ?? 0

    let usedCents = totalSpend
    if (usedCents <= 0 && (apiSpend > 0 || autoSpend > 0)) {
      usedCents = apiSpend + autoSpend
    }
    if (usedCents <= 0 && includedSpend > 0) {
      usedCents = includedSpend
    }

    let limitCents = limitFromUsage
    if (limitCents <= 0 && includedAmountFromPlan > 0) {
      limitCents = includedAmountFromPlan
    }
    if (limitCents <= 0 && (apiLimit > 0 || autoLimit > 0)) {
      limitCents = apiLimit + autoLimit
    }

    const remainingRaw = pickNumberField(planUsage, ['remaining'])
    const remainingCents = remainingRaw != null
      ? remainingRaw
      : (limitCents > 0 ? Math.max(0, limitCents - usedCents) : 0)

    const totalPercent = normalizePercent(pickField(planUsage, ['total_percent_used', 'totalPercentUsed']))
    const apiPercent = normalizePercent(pickField(planUsage, ['api_percent_used', 'apiPercentUsed']))
    const autoPercent = normalizePercent(pickField(planUsage, ['auto_percent_used', 'autoPercentUsed']))
    const computedPercent = limitCents > 0 ? Math.round((usedCents / limitCents) * 100) : 0
    const primaryPercent = apiPercent ?? totalPercent ?? computedPercent
    const secondaryPercent = totalPercent ?? computedPercent
    const level: UsageInfo['level'] =
      primaryPercent >= 90 ? 'critical' : primaryPercent >= 70 ? 'warn' : 'normal'
    const planName =
      pickStringField(planInfo, ['plan_name', 'planName']) ??
      bundle.membershipType ??
      'unknown'
    const displayMessage = pickStringField(usage, ['display_message', 'displayMessage']) ?? ''
    const hasLimit = limitCents > 0 || totalPercent !== null || apiPercent !== null || autoPercent !== null
    const billingCycleEndMs =
      parseEpochMs(pickField(usage, ['billing_cycle_end', 'billingCycleEnd'])) ??
      parseEpochMs(pickField(planInfo, ['billing_cycle_end', 'billingCycleEnd']))
    const resetAt = billingCycleEndMs != null
      ? new Date(billingCycleEndMs).toLocaleString(undefined, { timeZoneName: 'short' })
      : null

    cliLog(
      LOG_CH,
      `[usage] parsed metrics plan=${planName} total=${totalSpend} included=${includedSpend} api=${apiSpend} auto=${autoSpend} limit=${limitCents} pct(primary/total/auto)=${primaryPercent}/${secondaryPercent}/${autoPercent ?? 'n/a'} keys(planUsage)=[${Object.keys(planUsage).join(',')}]`
    )

    const result: UsageInfo = {
      summary: hasLimit
        ? `${primaryPercent}% / ${secondaryPercent}% / ${formatUsdFromCents(usedCents)}`
        : formatUsdFromCents(usedCents),
      tooltip: [
        `Plan: ${planName}`,
        `API usage: ${apiPercent ?? primaryPercent}%`,
        `Total usage: ${secondaryPercent}%`,
        `Used: ${formatUsdFromCents(usedCents)}`,
        includedAmountFromPlan > 0 ? `Included: ${formatUsdFromCents(includedSpend)} / ${formatUsdFromCents(includedAmountFromPlan)}` : null,
        apiSpend > 0 || apiPercent !== null ? `API: ${formatUsdFromCents(apiSpend)}${apiPercent !== null ? ` (${apiPercent}%)` : ''}` : null,
        autoSpend > 0 || autoPercent !== null ? `Auto: ${formatUsdFromCents(autoSpend)}${autoPercent !== null ? ` (${autoPercent}%)` : ''}` : null,
        bonusSpend > 0 ? `Bonus: ${formatUsdFromCents(bonusSpend)}` : null,
        `Remaining: ${formatUsdFromCents(remainingCents)}`,
        hasLimit ? `Limit: ${formatUsdFromCents(limitCents)}` : 'Limit: not set',
        resetAt ? `Resets: ${resetAt}` : null,
        displayMessage ? `Message: ${displayMessage}` : null
      ].filter((x): x is string => !!x).join('\n'),
      level,
      fetchedAt: Date.now(),
      hasLimit
    }

    writeUsageCache({
      account: currentAccount,
      summary: result.summary,
      tooltip: result.tooltip,
      level: result.level,
      hasLimit: result.hasLimit !== false,
      fetchedAt: result.fetchedAt
    })
    return result
  },

  parseThinkingBlocks(line: string): string[] {
    return parseCursorThinkingBlocks(line)
  }
}
