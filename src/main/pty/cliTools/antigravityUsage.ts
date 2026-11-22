/**
 * Active quota / usage fetching and caching for Google Antigravity CLI.
 *
 * `agy -p /usage --output-format json` fetches fresh backend quota across all
 * model groups (5h and weekly buckets) without starting a model turn or
 * creating a conversation. That keeps the status bar accurate even when no
 * session is active or a session is paused on a limit.
 *
 * Live `title.command` hook payloads also update matching bucket fractions in
 * place during active sessions so usage reflects each turn immediately.
 */

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { resolveAntigravityExecutable } from '../../pipeline/headless/antigravityHeadless'
import { cliLog } from './cliLogger'
import type { UsageInfo } from './types'

const LOG_CH = 'Antigravity'
const DEFAULT_CACHE_MAX_AGE_MS = 20 * 60_000
const FETCH_TIMEOUT_MS = 25_000
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000

export interface AntigravityQuotaBucket {
  id: string
  group?: string
  name: string
  window?: string
  remainingFraction: number
  resetTime?: string
}

export interface AntigravityQuotaSnapshot {
  buckets: AntigravityQuotaBucket[]
  planTier?: string | null
  email?: string | null
  fetchedAt: number
}

let memorySnapshot: AntigravityQuotaSnapshot | null = null
let inFlightFetch: Promise<AntigravityQuotaSnapshot | null> | null = null
const backoff = { delay: BACKOFF_BASE_MS, until: 0 }

function usageCachePath(): string {
  return join(homedir(), '.aide', 'antigravity-usage.json')
}

function readDiskCache(): AntigravityQuotaSnapshot | null {
  const path = usageCachePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AntigravityQuotaSnapshot>
    if (!parsed || !Array.isArray(parsed.buckets) || typeof parsed.fetchedAt !== 'number') return null
    return {
      buckets: parsed.buckets,
      planTier: typeof parsed.planTier === 'string' ? parsed.planTier : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      fetchedAt: parsed.fetchedAt
    }
  } catch {
    return null
  }
}

function writeDiskCache(snapshot: AntigravityQuotaSnapshot): void {
  const path = usageCachePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
    renameSync(tmp, path)
  } catch (e) {
    cliLog(LOG_CH, `[usage] failed to write cache: ${e}`)
  }
}

function inferWindow(id: string, name: string): string | undefined {
  const text = `${id} ${name}`.toLowerCase()
  if (text.includes('5h') || text.includes('five hour') || text.includes('5-hour')) return '5h'
  if (text.includes('weekly') || text.includes('week')) return 'weekly'
  return undefined
}

/** Parse stdout of `agy -p /usage --output-format json`. */
export function parseUsageCommandJson(stdout: string, fetchedAt = Date.now()): AntigravityQuotaSnapshot | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed.status !== 'SUCCESS') return null
  const command = parsed.command as { data?: { groups?: unknown } } | undefined
  const groups = command?.data?.groups
  if (!Array.isArray(groups)) return null

  const buckets: AntigravityQuotaBucket[] = []
  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== 'object') continue
    const g = rawGroup as { name?: unknown; buckets?: unknown }
    const groupName = typeof g.name === 'string' ? g.name.trim() : undefined
    if (!Array.isArray(g.buckets)) continue
    for (const rawBucket of g.buckets) {
      if (!rawBucket || typeof rawBucket !== 'object') continue
      const b = rawBucket as {
        id?: unknown
        name?: unknown
        window?: unknown
        remaining_fraction?: unknown
        reset_time?: unknown
        disabled?: unknown
      }
      if (b.disabled === true) continue
      if (typeof b.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) continue
      const id = typeof b.id === 'string' && b.id ? b.id : `${groupName ?? 'quota'}-${buckets.length}`
      const name = typeof b.name === 'string' && b.name ? b.name : id
      const window = typeof b.window === 'string' && b.window ? b.window : inferWindow(id, name)
      buckets.push({
        id,
        group: groupName,
        name,
        window,
        remainingFraction: Math.max(0, Math.min(1, b.remaining_fraction)),
        resetTime: typeof b.reset_time === 'string' && b.reset_time ? b.reset_time : undefined
      })
    }
  }

  return buckets.length > 0 ? { buckets, fetchedAt } : null
}

/** Parse `payload.quota` from Antigravity's `title.command` JSON state. */
export function parseHookQuotaPayload(
  quota: unknown,
  planTier: string | null,
  fetchedAt = Date.now(),
  existing?: AntigravityQuotaSnapshot | null
): AntigravityQuotaSnapshot | null {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null
  const byId = new Map<string, AntigravityQuotaBucket>()
  for (const b of existing?.buckets ?? []) byId.set(b.id, { ...b })

  let sawAny = false
  for (const [id, raw] of Object.entries(quota as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const b = raw as { remaining_fraction?: unknown; reset_time?: unknown; disabled?: unknown }
    if (b.disabled === true) continue
    if (typeof b.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) continue
    sawAny = true
    const prev = byId.get(id)
    byId.set(id, {
      id,
      group: prev?.group,
      name: prev?.name ?? id,
      window: prev?.window ?? inferWindow(id, prev?.name ?? id),
      remainingFraction: Math.max(0, Math.min(1, b.remaining_fraction)),
      resetTime: typeof b.reset_time === 'string' && b.reset_time ? b.reset_time : prev?.resetTime
    })
  }

  if (!sawAny) return null
  return {
    buckets: [...byId.values()],
    planTier: planTier ?? existing?.planTier ?? null,
    email: existing?.email ?? null,
    fetchedAt
  }
}

function formatRemainingDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin < 60) return `in ${totalMin}m`
  const totalHours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (totalHours < 24) return mins > 0 ? `in ${totalHours}h ${mins}m` : `in ${totalHours}h`
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`
}

function formatReset(resetTime: string | undefined, now: number): string | null {
  if (!resetTime) return null
  const parsed = Date.parse(resetTime)
  if (Number.isNaN(parsed)) return resetTime
  const local = new Date(parsed).toLocaleString(undefined, { timeZoneName: 'short' })
  const rel = formatRemainingDuration(parsed - now)
  return `${rel}, ${local}`
}

/** Format a quota snapshot into AIDE's status-bar UsageInfo, computing countdowns relative to `now`. */
export function formatAntigravityUsage(snapshot: AntigravityQuotaSnapshot, now = Date.now()): UsageInfo | null {
  if (!snapshot.buckets || snapshot.buckets.length === 0) return null

  const usedPct = (b: AntigravityQuotaBucket): number => Math.round((1 - Math.max(0, Math.min(1, b.remainingFraction))) * 100)

  const fiveHourBuckets = snapshot.buckets.filter((b) => b.window === '5h')
  const weeklyBuckets = snapshot.buckets.filter((b) => b.window === 'weekly')
  const allPcts = snapshot.buckets.map(usedPct)
  const maxPct = Math.max(...allPcts)

  let summary: string
  if (fiveHourBuckets.length > 0 && weeklyBuckets.length > 0) {
    const max5h = Math.max(...fiveHourBuckets.map(usedPct))
    const maxWeekly = Math.max(...weeklyBuckets.map(usedPct))
    summary = `${max5h}% / ${maxWeekly}%`
  } else {
    summary = `${maxPct}%`
  }

  const level: UsageInfo['level'] = maxPct >= 90 ? 'critical' : maxPct >= 70 ? 'warn' : 'normal'
  const lines: string[] = []
  if (snapshot.planTier) lines.push(`Plan: ${snapshot.planTier}`)
  for (const b of snapshot.buckets) {
    const label = b.group ? `${b.group} (${b.window ?? b.name})` : b.name
    const reset = formatReset(b.resetTime, now)
    lines.push(`${label}: ${usedPct(b)}%${reset ? ` — resets ${reset}` : ''}`)
  }

  return {
    summary,
    tooltip: lines.join('\n'),
    level,
    fetchedAt: snapshot.fetchedAt,
    hasLimit: true
  }
}

/** True when any depleted bucket's reset timestamp has already elapsed, so fresh quota should be fetched now. */
export function hasElapsedReset(snapshot: AntigravityQuotaSnapshot, now = Date.now()): boolean {
  return snapshot.buckets.some((b) => {
    if (b.remainingFraction >= 0.999 || !b.resetTime) return false
    const resetMs = Date.parse(b.resetTime)
    return !Number.isNaN(resetMs) && resetMs <= now
  })
}

/** Update in-memory and disk cache immediately from a live tab's `title.command` quota payload. */
export function recordAntigravityHookQuota(quota: unknown, planTier: string | null, email?: string | null): void {
  const existing = memorySnapshot ?? readDiskCache()
  const updated = parseHookQuotaPayload(quota, planTier, Date.now(), existing)
  if (!updated) return
  if (email) updated.email = email
  memorySnapshot = updated
  writeDiskCache(updated)
}

/** Persist the signed-in email observed from a live hook so the status bar shows it before a tab opens. */
export function recordAntigravityEmail(email: string): void {
  const trimmed = email.trim()
  if (!trimmed) return
  const existing = memorySnapshot ?? readDiskCache()
  if (existing) {
    if (existing.email === trimmed) return
    memorySnapshot = { ...existing, email: trimmed }
    writeDiskCache(memorySnapshot)
    return
  }
  memorySnapshot = { buckets: [], email: trimmed, fetchedAt: 0 }
  writeDiskCache(memorySnapshot)
}

/** Read the last observed Antigravity account email from memory or disk cache. */
export function getCachedAntigravityEmail(): string | null {
  if (memorySnapshot?.email) return memorySnapshot.email
  const disk = readDiskCache()
  if (disk?.email) {
    if (!memorySnapshot) memorySnapshot = disk
    return disk.email
  }
  return null
}

function runUsageCommand(envOverrides: Record<string, string>): Promise<AntigravityQuotaSnapshot | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides }
  const exe = resolveAntigravityExecutable(env)
  if (!exe) return Promise.resolve(null)

  return new Promise((resolve) => {
    execFile(
      exe,
      ['-p', '/usage', '--output-format', 'json'],
      { timeout: FETCH_TIMEOUT_MS, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || String(err)).trim().slice(0, 300)
          backoff.until = Date.now() + backoff.delay
          backoff.delay = Math.min(backoff.delay * 2, BACKOFF_MAX_MS)
          cliLog(LOG_CH, `[usage] agy -p /usage failed, backing off ${Math.round((backoff.until - Date.now()) / 1000)}s: ${msg}`)
          resolve(null)
          return
        }
        const parsed = parseUsageCommandJson(stdout, Date.now())
        if (!parsed) {
          backoff.until = Date.now() + backoff.delay
          backoff.delay = Math.min(backoff.delay * 2, BACKOFF_MAX_MS)
          cliLog(LOG_CH, '[usage] could not parse JSON from agy -p /usage')
          resolve(null)
          return
        }
        backoff.delay = BACKOFF_BASE_MS
        backoff.until = 0
        const prev = memorySnapshot ?? readDiskCache()
        const merged: AntigravityQuotaSnapshot = {
          ...parsed,
          planTier: prev?.planTier ?? null,
          email: prev?.email ?? null
        }
        memorySnapshot = merged
        writeDiskCache(merged)
        resolve(merged)
      }
    )
  })
}

/**
 * Return current Antigravity quota for the status bar and Remote Access.
 * Serves from memory/disk cache while fresh (and no depleted bucket has reset);
 * otherwise runs `agy -p /usage --output-format json` in the background.
 */
export async function getAntigravityUsageInfo(
  cacheMaxAgeMs = DEFAULT_CACHE_MAX_AGE_MS,
  envOverrides: Record<string, string> = {}
): Promise<UsageInfo | null> {
  const now = Date.now()
  const disk = readDiskCache()
  if (disk && (!memorySnapshot || disk.fetchedAt > memorySnapshot.fetchedAt)) {
    memorySnapshot = disk
  }

  const cached = memorySnapshot && memorySnapshot.buckets.length > 0 ? memorySnapshot : null
  if (cached && now - cached.fetchedAt < cacheMaxAgeMs && !hasElapsedReset(cached, now)) {
    return formatAntigravityUsage(cached, now)
  }

  if (backoff.until > now) {
    return cached ? formatAntigravityUsage(cached, now) : null
  }

  if (!inFlightFetch) {
    inFlightFetch = runUsageCommand(envOverrides).finally(() => {
      inFlightFetch = null
    })
  }
  const fresh = await inFlightFetch
  const best = fresh ?? cached
  return best ? formatAntigravityUsage(best, Date.now()) : null
}
