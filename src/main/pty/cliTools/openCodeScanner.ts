/**
 * OpenCode 2 session scanner — reads the OpenCode SQLite database directly.
 *
 * Database location: ~/.local/share/opencode/opencode.db (XDG_DATA_HOME / OPENCODE_DATA_DIR override)
 *
 * OpenCode 2 keeps sessions in its v2 tables (it migrated the 1.x `session` /
 * `message` / `part` tables into them and no longer writes those):
 *   session_v2:      id, project_id, parent_id, directory, title, slug, cost,
 *                    time_created, time_updated, time_archived
 *   session_message: id, session_id, type (user | assistant | system | synthetic |
 *                    compaction | idle | …), seq, time_created, time_updated,
 *                    data (JSON; user: { text }, assistant: { content[], cost, time.completed })
 *
 * An assistant row is inserted when the turn starts and updated as it streams;
 * it is complete once `data.time.completed` is set.
 *
 * The project id of a git project is its first root-commit hash, also cached in
 * <projectRoot>/.git/opencode; sessions are matched by it or by directory.
 */

import { existsSync, readFileSync, watch } from 'fs'
import { join } from 'path'
import type { HistoryBlock, HistoryEntry } from './types'
import { cliLog } from './cliLogger'
import { openCodePartBlocks } from './openCodeParts'

const LOG_CH = 'OpenCode'

// ── DB path helpers ───────────────────────────────────────────────────────────

export function getOpenCodeDataDir(): string {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'opencode')
  const { homedir } = require('os') as typeof import('os')
  return join(homedir(), '.local', 'share', 'opencode')
}

export function getDbPath(): string {
  return join(getOpenCodeDataDir(), 'opencode.db')
}

// ── ProjectID resolution ──────────────────────────────────────────────────────

/** The OpenCode project id cached in <project>/.git/opencode, or null. */
export function readProjectId(projectPath: string): string | null {
  const cacheFile = join(projectPath, '.git', 'opencode')
  if (!existsSync(cacheFile)) return null
  try {
    return readFileSync(cacheFile, 'utf-8').trim() || null
  } catch {
    return null
  }
}

// ── Database access ───────────────────────────────────────────────────────────

/**
 * Open the OpenCode SQLite database in read-only mode, or null.
 * Lazy require() so a missing or wrong-ABI better-sqlite3 degrades gracefully.
 */
function openDb(): import('better-sqlite3').Database | null {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch (e) {
    cliLog(LOG_CH, `[db] failed to open: ${e}`)
    return null
  }
}

function withDb<T>(what: string, fallback: T, fn: (db: import('better-sqlite3').Database) => T): T {
  const db = openDb()
  if (!db) return fallback
  try {
    return fn(db)
  } catch (e) {
    cliLog(LOG_CH, `[${what}] query failed: ${e}`)
    return fallback
  } finally {
    db.close()
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string
  project_id: string
  directory: string
  title: string | null
  slug: string | null
  time_created: number
  time_updated: number
}

export interface OpenCodeSession {
  sessionId: string
  title: string
  slug: string
  directory: string
  timeUpdated: number
  timeCreated: number
}

function normalizeDir(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/** The project's top-level sessions (no subagent children, no archived ones), newest first. */
export function scanOpenCodeSessions(projectPath: string): OpenCodeSession[] {
  const projectId = readProjectId(projectPath)
  const root = normalizeDir(projectPath)
  return withDb('scanSessions', [], (db) => {
    const rows = db
      .prepare('SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session_v2 WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC')
      .all() as SessionRow[]
    return rows
      .filter((r) => {
        if (projectId && r.project_id === projectId) return true
        const dir = normalizeDir(r.directory ?? '')
        return dir === root || dir.startsWith(root + '/')
      })
      .map((r) => ({
        sessionId: r.id,
        title: r.title ?? '',
        slug: r.slug ?? '',
        directory: r.directory ?? '',
        timeUpdated: r.time_updated ?? 0,
        timeCreated: r.time_created ?? 0
      }))
  })
}

// ── Messages ──────────────────────────────────────────────────────────────────

interface MessageRow {
  id: string
  type: string
  data: string
  time_updated: number
}

const MESSAGE_COLUMNS = "SELECT id, type, data, time_updated FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant')"

/** A user message, or an assistant message that has finished streaming; null otherwise. */
function messageEntry(row: MessageRow): { entry: HistoryEntry | null; complete: boolean } {
  let data: Record<string, unknown>
  try { data = JSON.parse(row.data) as Record<string, unknown> } catch { return { entry: null, complete: true } }
  if (row.type === 'user') {
    const text = typeof data.text === 'string' ? data.text : ''
    return { entry: text.trim() ? { role: 'user', blocks: [{ type: 'text', text }] } : null, complete: true }
  }
  const time = (data.time ?? {}) as Record<string, unknown>
  if (typeof time.completed !== 'number') return { entry: null, complete: false }
  const blocks: HistoryBlock[] = []
  for (const part of Array.isArray(data.content) ? data.content : []) blocks.push(...openCodePartBlocks(part))
  return { entry: blocks.length > 0 ? { role: 'assistant', blocks } : null, complete: true }
}

/** The session's conversation; an assistant turn still streaming is left to the live watcher. */
export function readOpenCodeSessionHistory(sessionId: string): HistoryEntry[] {
  return withDb('history', [], (db) => {
    const rows = db.prepare(`${MESSAGE_COLUMNS} ORDER BY seq ASC`).all(sessionId) as MessageRow[]
    const entries: HistoryEntry[] = []
    for (const row of rows) {
      const { entry } = messageEntry(row)
      if (entry) entries.push(entry)
    }
    return entries
  })
}

/** The last few text messages for the session preview (hover card in Session Picker). */
export function readOpenCodeSessionPreview(sessionId: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  return withDb('preview', [], (db) => {
    const rows = (db.prepare(`${MESSAGE_COLUMNS} ORDER BY seq DESC LIMIT 10`).all(sessionId) as MessageRow[]).reverse()
    const result: Array<{ role: 'user' | 'assistant'; text: string }> = []
    for (const row of rows) {
      const { entry } = messageEntry(row)
      if (!entry) continue
      const text = entry.blocks.map((b) => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n').trim()
      if (text) result.push({ role: entry.role, text: text.slice(0, 200) })
    }
    return result.slice(-3)
  })
}

/**
 * Cost in USD of the session's assistant turns that started at or after `sinceMs`
 * — one headless run. `opencode run` exits before streaming the last step's cost,
 * so the stream alone undercounts. Null when nothing is recorded.
 */
export function readOpenCodeRunCost(sessionId: string, sinceMs: number): number | null {
  return withDb('runCost', null, (db) => {
    const rows = db
      .prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' AND time_created >= ?")
      .all(sessionId, sinceMs) as Array<{ data: string }>
    let total: number | null = null
    for (const row of rows) {
      try {
        const cost = (JSON.parse(row.data) as { cost?: unknown }).cost
        if (typeof cost === 'number') total = (total ?? 0) + cost
      } catch { /* skip */ }
    }
    return total
  })
}

/** A provider credential (`credential` table), in the shape `opencode auth export` prints and `auth import` reads. */
export interface OpenCodeCredential {
  id: string
  integrationID: string
  label: string
  active: boolean
  value: Record<string, unknown>
}

export function readOpenCodeCredentials(): OpenCodeCredential[] {
  return withDb('credentials', [], (db) => {
    const rows = db.prepare('SELECT id, integration_id, label, value, active FROM credential ORDER BY time_created').all() as Array<{
      id: string; integration_id: string; label: string | null; value: string; active: number
    }>
    const credentials: OpenCodeCredential[] = []
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value) as Record<string, unknown>
        credentials.push({ id: row.id, integrationID: row.integration_id, label: row.label ?? row.integration_id, active: row.active === 1, value })
      } catch { /* unreadable value */ }
    }
    return credentials
  })
}

export interface OpenCodeRetry {
  attempt: number
  errorType: string
  message: string
  retryAfterMs: number | null
}

/**
 * The retry OpenCode is in for the session's latest assistant turn, if any: it
 * retries provider errors such as a rate limit (429) by itself, indefinitely,
 * and the stream shows only a new `step_start` per attempt.
 */
export function readOpenCodeRetry(sessionId: string): OpenCodeRetry | null {
  return withDb('retry', null, (db) => {
    const row = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1")
      .get(sessionId) as { data: string } | undefined
    if (!row) return null
    const retry = (JSON.parse(row.data) as { retry?: Record<string, unknown> }).retry
    if (!retry || typeof retry !== 'object') return null
    const error = (retry.error ?? {}) as Record<string, unknown>
    return {
      attempt: typeof retry.attempt === 'number' ? retry.attempt : 0,
      errorType: typeof error.type === 'string' ? error.type : '',
      message: typeof error.message === 'string' ? error.message : '',
      retryAfterMs: typeof error.retryAfterMs === 'number' ? error.retryAfterMs : null
    }
  })
}

/** `provider/model` of the assistant turns that started at or after `sinceMs` — what actually answered. */
export function readOpenCodeRunModels(sessionId: string, sinceMs: number): string[] {
  return withDb('runModels', [], (db) => {
    const rows = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' AND time_created >= ?")
      .all(sessionId, sinceMs) as Array<{ data: string }>
    const models = new Set<string>()
    for (const row of rows) {
      try {
        const model = (JSON.parse(row.data) as { model?: { id?: unknown; providerID?: unknown } }).model
        if (model && typeof model.providerID === 'string' && typeof model.id === 'string') models.add(`${model.providerID}/${model.id}`)
      } catch { /* skip */ }
    }
    return [...models]
  })
}

// ── Live session / message watching ──────────────────────────────────────────

/** Polling backstop: a watch on the data directory still misses some SQLite writes (docs/timers.md). */
const POLL_INTERVAL_MS = 5000

/**
 * Watch the data directory for changes to the database or its WAL / shared-memory
 * files — the directory reports more of them than a watch on the WAL file alone,
 * and survives the WAL being recreated. Returns a cleanup function.
 */
function watchDb(onChange: () => void): () => void {
  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = watch(getOpenCodeDataDir(), (_event, name) => {
      if (!name || String(name).startsWith('opencode.db')) onChange()
    })
  } catch (e) {
    cliLog(LOG_CH, `[watch] failed to watch the data directory: ${e}`)
  }
  const poll = setInterval(onChange, POLL_INTERVAL_MS)
  return () => {
    clearInterval(poll)
    watcher?.close()
  }
}

/**
 * Watch the OpenCode database for new sessions of the project. On a database
 * change, re-query and emit sessions not in `knownIds`. Returns a cleanup function.
 */
export function watchOpenCodeSessions(
  projectPath: string,
  knownIds: Set<string>,
  onNew: (session: OpenCodeSession) => void
): () => void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) {
    // DB doesn't exist yet — poll until it appears
    let stopped = false
    const cleanupFns: Array<() => void> = []
    const interval = setInterval(() => {
      if (stopped) { clearInterval(interval); return }
      if (existsSync(dbPath)) {
        clearInterval(interval)
        cleanupFns.push(watchOpenCodeSessions(projectPath, knownIds, onNew))
      }
    }, 2000)
    return () => {
      stopped = true
      clearInterval(interval)
      cleanupFns.forEach((f) => f())
    }
  }

  let stopped = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const checkForNew = (): void => {
    if (stopped) return
    for (const s of scanOpenCodeSessions(projectPath)) {
      if (!knownIds.has(s.sessionId)) {
        knownIds.add(s.sessionId)
        onNew(s)
      }
    }
  }

  const unwatch = watchDb(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(checkForNew, 500)
  })

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    unwatch()
  }
}

/**
 * Watch a session for messages that complete after the watch starts (history
 * up to then comes from readOpenCodeSessionHistory) and emit each once.
 * Returns a cleanup function.
 */
export function watchOpenCodeMessages(
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  if (!existsSync(getDbPath())) return () => {}

  let stopped = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const done = new Set<string>()
  // Rows are rescanned from the latest update seen: an assistant row is updated in place.
  let since = 0

  const scan = (emit: boolean): void => {
    withDb('watchMessages', undefined, (db) => {
      const rows = db.prepare(`${MESSAGE_COLUMNS} AND time_updated >= ? ORDER BY seq ASC`).all(sessionId, since) as MessageRow[]
      for (const row of rows) {
        if (stopped) return
        since = Math.max(since, row.time_updated)
        if (done.has(row.id)) continue
        const { entry, complete } = messageEntry(row)
        if (!complete) continue
        done.add(row.id)
        if (emit && entry) onEntry(entry)
      }
    })
  }

  scan(false)

  const scheduleCheck = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { if (!stopped) scan(true) }, 300)
  }

  const unwatch = watchDb(scheduleCheck)

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    unwatch()
  }
}
