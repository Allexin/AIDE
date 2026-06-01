import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { UsageInfo } from './types'
import { cliLog } from './cliLogger'

const LOG_CH = 'Codex'
const CODEX_HOME = join(homedir(), '.codex')
const SESSIONS_ROOT = join(CODEX_HOME, 'sessions')
const CACHE_PATH = join(CODEX_HOME, 'aide-usage-cache.json')
const LOCK_PATH = `${CACHE_PATH}.lock`
const CACHE_MAX_AGE_MS = 30_000
const STALE_CACHE_MAX_AGE_MS = 5 * 60_000
const LOCK_STALE_MS = 15_000
const MAX_FILES_TO_SCAN = 80
const MAX_TAIL_BYTES = 256 * 1024

interface RateLimitWindow {
  used_percent?: number
  window_minutes?: number
  resets_at?: number
}

interface CodexRateLimits {
  limit_id?: string | null
  limit_name?: string | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: unknown
  plan_type?: string | null
}

interface TokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

interface UsageSnapshot {
  accountKey?: string
  rateLimits: CodexRateLimits
  totalTokenUsage?: TokenUsage
  lastTokenUsage?: TokenUsage
  sourceFile: string
  sourceMtime: number
  observedAt: number
  fetchedAt: number
}

function loadJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function getNestedString(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : null
}

function currentAccountKey(): string | undefined {
  const auth = loadJsonFile(join(CODEX_HOME, 'auth.json'))
  if (!auth) return undefined
  return (
    getNestedString(auth, ['tokens', 'account_id']) ??
    getNestedString(auth, ['tokens', 'id_token'])?.slice(0, 48) ??
    (getNestedString(auth, ['OPENAI_API_KEY']) ? 'api-key' : undefined) ??
    getNestedString(auth, ['auth_mode']) ??
    undefined
  )
}

function readCache(maxAgeMs: number, accountKey?: string): UsageSnapshot | null {
  const cache = loadJsonFile(CACHE_PATH) as UsageSnapshot | null
  if (!cache?.rateLimits || !cache.fetchedAt) return null
  if (accountKey && cache.accountKey && cache.accountKey !== accountKey) return null
  if (Date.now() - cache.fetchedAt > maxAgeMs) return null
  return cache
}

function writeCache(snapshot: UsageSnapshot): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true })
    const tmp = `${CACHE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
    renameSync(tmp, CACHE_PATH)
  } catch (e) {
    cliLog(LOG_CH, `[usage] failed to write cache: ${e}`)
  }
}

function acquireLock(): number | null {
  try {
    mkdirSync(dirname(LOCK_PATH), { recursive: true })
    const fd = openSync(LOCK_PATH, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf-8')
    return fd
  } catch {
    try {
      const age = Date.now() - statSync(LOCK_PATH).mtimeMs
      if (age > LOCK_STALE_MS) {
        unlinkSync(LOCK_PATH)
        return acquireLock()
      }
    } catch {}
    return null
  }
}

function releaseLock(fd: number | null): void {
  if (fd === null) return
  try { closeSync(fd) } catch {}
  try { unlinkSync(LOCK_PATH) } catch {}
}

function collectJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []

  const files: string[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }
  return files
}

function readTailLines(filePath: string): string[] {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }

  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, MAX_TAIL_BYTES)
    const offset = size - len
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, offset)
    const lines = buf.toString('utf-8').split('\n')
    if (offset > 0) lines.shift()
    return lines.filter((line) => line.trim())
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
}

function parseSnapshotLine(line: string, filePath: string, sourceMtime: number, accountKey?: string): UsageSnapshot | null {
  try {
    const obj = JSON.parse(line) as {
      timestamp?: string
      type?: string
      payload?: {
        type?: string
        info?: {
          total_token_usage?: TokenUsage
          last_token_usage?: TokenUsage
        }
        rate_limits?: CodexRateLimits
      }
    }

    if (obj.type !== 'event_msg' || obj.payload?.type !== 'token_count') return null
    const rateLimits = obj.payload.rate_limits
    if (!rateLimits || typeof rateLimits !== 'object') return null

    const observedAt = obj.timestamp ? Date.parse(obj.timestamp) : sourceMtime
    return {
      accountKey,
      rateLimits,
      totalTokenUsage: obj.payload.info?.total_token_usage,
      lastTokenUsage: obj.payload.info?.last_token_usage,
      sourceFile: filePath,
      sourceMtime,
      observedAt: Number.isFinite(observedAt) ? observedAt : sourceMtime,
      fetchedAt: Date.now()
    }
  } catch {
    return null
  }
}

function scanLatestSnapshot(accountKey?: string): UsageSnapshot | null {
  const files = collectJsonlFiles(SESSIONS_ROOT)
    .map((filePath) => {
      try {
        return { filePath, mtime: statSync(filePath).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { filePath: string; mtime: number } => item !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES_TO_SCAN)

  for (const { filePath, mtime } of files) {
    const lines = readTailLines(filePath)
    for (let i = lines.length - 1; i >= 0; i--) {
      const snapshot = parseSnapshotLine(lines[i], filePath, mtime, accountKey)
      if (snapshot) return snapshot
    }
  }

  return null
}

function windowLabel(window?: RateLimitWindow | null): string {
  const minutes = window?.window_minutes
  if (minutes === 300) return '5h'
  if (minutes === 10080) return 'weekly'
  if (typeof minutes === 'number' && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440}d`
    if (minutes % 60 === 0) return `${minutes / 60}h`
    return `${minutes}m`
  }
  return 'limit'
}

function formatReset(epochSeconds?: number): string {
  if (!epochSeconds) return ''
  try {
    return new Date(epochSeconds * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatTokens(usage?: TokenUsage): string | null {
  if (!usage) return null
  const total = numberField(usage.total_tokens)
  if (total === null) return null
  const input = numberField(usage.input_tokens) ?? 0
  const cached = numberField(usage.cached_input_tokens) ?? 0
  const output = numberField(usage.output_tokens) ?? 0
  const reasoning = numberField(usage.reasoning_output_tokens) ?? 0
  return `tokens: ${total.toLocaleString()} total (${input.toLocaleString()} in, ${cached.toLocaleString()} cached, ${output.toLocaleString()} out, ${reasoning.toLocaleString()} reasoning)`
}

function usageFromSnapshot(snapshot: UsageSnapshot): UsageInfo | null {
  const primary = snapshot.rateLimits.primary ?? null
  const secondary = snapshot.rateLimits.secondary ?? null
  const primaryPct = numberField(primary?.used_percent)
  const secondaryPct = numberField(secondary?.used_percent)
  if (primaryPct === null && secondaryPct === null) return null

  const parts = [
    primaryPct === null ? null : `${Math.round(primaryPct)}%`,
    secondaryPct === null ? null : `${Math.round(secondaryPct)}%`
  ].filter((part): part is string => part !== null)

  const maxPct = Math.max(primaryPct ?? 0, secondaryPct ?? 0)
  const level: UsageInfo['level'] = maxPct >= 90 ? 'critical' : maxPct >= 70 ? 'warn' : 'normal'
  const plan = snapshot.rateLimits.plan_type ? `plan: ${snapshot.rateLimits.plan_type}` : ''

  const tooltipParts = [
    plan,
    primaryPct === null
      ? ''
      : `${windowLabel(primary)} limit: ${Math.round(primaryPct)}% used${formatReset(primary?.resets_at) ? `, resets ${formatReset(primary?.resets_at)}` : ''}`,
    secondaryPct === null
      ? ''
      : `${windowLabel(secondary)} limit: ${Math.round(secondaryPct)}% used${formatReset(secondary?.resets_at) ? `, resets ${formatReset(secondary?.resets_at)}` : ''}`,
    formatTokens(snapshot.lastTokenUsage),
    `updated: ${new Date(snapshot.observedAt).toLocaleString()}`
  ].filter((part): part is string => !!part)

  return {
    summary: parts.join(' / '),
    tooltip: tooltipParts.join('\n'),
    level,
    fetchedAt: snapshot.fetchedAt,
    hasLimit: true
  }
}

export async function getCodexUsageInfo(): Promise<UsageInfo | null> {
  const accountKey = currentAccountKey()

  const fresh = readCache(CACHE_MAX_AGE_MS, accountKey)
  if (fresh) return usageFromSnapshot(fresh)

  const lockFd = acquireLock()
  if (lockFd === null) {
    const stale = readCache(STALE_CACHE_MAX_AGE_MS, accountKey)
    return stale ? usageFromSnapshot(stale) : null
  }

  try {
    const refreshedByOther = readCache(CACHE_MAX_AGE_MS, accountKey)
    if (refreshedByOther) return usageFromSnapshot(refreshedByOther)

    const snapshot = scanLatestSnapshot(accountKey)
    if (!snapshot) {
      const stale = readCache(STALE_CACHE_MAX_AGE_MS, accountKey)
      return stale ? usageFromSnapshot(stale) : null
    }

    writeCache(snapshot)
    return usageFromSnapshot(snapshot)
  } finally {
    releaseLock(lockFd)
  }
}
