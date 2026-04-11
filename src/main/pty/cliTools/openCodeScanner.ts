/**
 * OpenCode session scanner — reads the OpenCode SQLite database directly.
 *
 * Database location (Windows): ~/.local/share/opencode/opencode.db
 * Database location (Unix):    ~/.local/share/opencode/opencode.db
 *
 * The ProjectID stored in the session table is the first git root-commit hash,
 * also cached in <projectRoot>/.git/opencode. We read this file to filter
 * sessions belonging to the current project.
 *
 * Schema (relevant tables):
 *   session: id, project_id, directory, title, slug, time_created, time_updated
 *   message: id, session_id, data (JSON with role), time_created
 *   part:    id, message_id, session_id, data (JSON with type/text), time_created
 */

import { existsSync, readFileSync, watch } from 'fs'
import { join } from 'path'
import type { HistoryBlock, HistoryEntry } from './types'
import { cliLog } from './cliLogger'

const LOG_CH = 'OpenCode'

// ── DB path helpers ───────────────────────────────────────────────────────────

export function getOpenCodeDataDir(): string {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR

  // OpenCode uses XDG_DATA_HOME style path on all platforms
  // Windows: ~/.local/share/opencode
  // Unix: ~/.local/share/opencode
  const { homedir } = require('os') as typeof import('os')

  // Check XDG_DATA_HOME first (Unix standard)
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, 'opencode')
  }

  // Default to ~/.local/share/opencode
  return join(homedir(), '.local', 'share', 'opencode')
}

export function getDbPath(): string {
  return join(getOpenCodeDataDir(), 'opencode.db')
}

// ── ProjectID resolution ──────────────────────────────────────────────────────

/**
 * Returns the OpenCode project ID for the given project directory.
 * OpenCode stores it as the first git root-commit hash in .git/opencode.
 * Returns null if the file doesn't exist or the project is not a git repo.
 */
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
 * Open the OpenCode SQLite database in read-only mode.
 * Returns null if the database doesn't exist or can't be opened.
 *
 * Uses lazy require() so the module load fails gracefully if better-sqlite3
 * is not installed or fails to load (e.g. wrong ABI during dev).
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

// ── Session row type ──────────────────────────────────────────────────────────

interface SessionRow {
  id: string
  project_id: string
  directory: string
  title: string
  slug: string
  time_created: number
  time_updated: number
}

// ── Public session scanner ────────────────────────────────────────────────────

export interface OpenCodeSession {
  sessionId: string
  title: string
  slug: string
  directory: string
  timeUpdated: number
  timeCreated: number
}

/**
 * Scan the OpenCode database for sessions belonging to the given project.
 * Returns sessions sorted newest first.
 */
export function scanOpenCodeSessions(projectPath: string): OpenCodeSession[] {
  const projectId = readProjectId(projectPath)
  const db = openDb()
  if (!db) return []

  try {
    let rows: SessionRow[]
    if (projectId) {
      rows = db
        .prepare('SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session WHERE project_id = ? ORDER BY time_updated DESC')
        .all(projectId) as SessionRow[]
    } else {
      // No .git/opencode cache — match by directory prefix
      const normalized = projectPath.replace(/\\/g, '/')
      rows = db
        .prepare('SELECT id, project_id, directory, title, slug, time_created, time_updated FROM session ORDER BY time_updated DESC')
        .all() as SessionRow[]
      rows = rows.filter((r) => {
        const dir = (r.directory ?? '').replace(/\\/g, '/')
        return dir.startsWith(normalized) || normalized.startsWith(dir)
      })
    }

    return rows.map((r) => ({
      sessionId: r.id,
      title: r.title ?? '',
      slug: r.slug ?? '',
      directory: r.directory ?? '',
      timeUpdated: r.time_updated ?? 0,
      timeCreated: r.time_created ?? 0
    }))
  } catch (e) {
    cliLog(LOG_CH, `[scanSessions] query failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

// ── Message / part row types ──────────────────────────────────────────────────

interface MessageData {
  role?: 'user' | 'assistant'
  [key: string]: unknown
}

interface MessageRow {
  id: string
  session_id: string
  time_created: number
}

interface PartData {
  type?: string
  text?: string
  content?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  state?: string
  args?: unknown
}

interface PartRow {
  id: string
  message_id: string
  session_id: string
  data: string   // JSON serialised PartData
  time_created: number
}

// ── History parsing ───────────────────────────────────────────────────────────

function parsePartData(partData: PartData): HistoryBlock | null {
  const text = partData.text ?? partData.content ?? ''

  switch (partData.type) {
    case 'text':
      if (typeof text === 'string' && text.trim()) return { type: 'text', text }
      break

    case 'reasoning':
      if (typeof text === 'string' && text.trim()) return { type: 'thinking', thinking: text }
      break

    case 'tool-call':
    case 'tool_call': {
      const input = (partData.args ?? partData.input ?? {}) as Record<string, unknown>
      if (partData.toolCallId || partData.toolName) {
        return {
          type: 'tool_use',
          id: partData.toolCallId ?? '',
          name: partData.toolName ?? 'unknown',
          input
        }
      }
      break
    }

    case 'tool-result':
    case 'tool_result':
      if (partData.toolCallId) {
        return {
          type: 'tool_result',
          tool_use_id: partData.toolCallId,
          content: typeof text === 'string' ? text : ''
        }
      }
      break

    // step-start, step-finish, snapshot, patch etc. — skip (metadata only)
    default:
      break
  }

  return null
}

// ── Session history reader ────────────────────────────────────────────────────

/**
 * Read the full conversation history for a session from the database.
 * Messages are in the `message` table; their content parts are in `part`.
 */
export function readOpenCodeSessionHistory(sessionId: string): HistoryEntry[] {
  const db = openDb()
  if (!db) return []

  try {
    const msgRows = db
      .prepare('SELECT id, session_id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC')
      .all(sessionId) as Array<{ id: string; session_id: string; data: string; time_created: number }>

    const entries: HistoryEntry[] = []

    for (const msgRow of msgRows) {
      let msgData: MessageData
      try { msgData = JSON.parse(msgRow.data) as MessageData } catch { continue }

      const role = msgData.role
      if (role !== 'user' && role !== 'assistant') continue

      const partRows = db
        .prepare('SELECT id, message_id, session_id, data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC')
        .all(msgRow.id) as PartRow[]

      const blocks: HistoryBlock[] = []
      for (const partRow of partRows) {
        let partData: PartData
        try { partData = JSON.parse(partRow.data) as PartData } catch { continue }
        const block = parsePartData(partData)
        if (block) blocks.push(block)
      }

      if (blocks.length > 0) entries.push({ role, blocks })
    }

    return entries
  } catch (e) {
    cliLog(LOG_CH, `[history] query failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

/**
 * Read the last few messages for session preview (hover card in Session Picker).
 */
export function readOpenCodeSessionPreview(sessionId: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  const db = openDb()
  if (!db) return []

  try {
    const msgRows = db
      .prepare('SELECT id, session_id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 10')
      .all(sessionId) as Array<{ id: string; session_id: string; data: string; time_created: number }>

    // Reverse so oldest first
    msgRows.reverse()

    const result: Array<{ role: 'user' | 'assistant'; text: string }> = []

    for (const msgRow of msgRows) {
      let msgData: MessageData
      try { msgData = JSON.parse(msgRow.data) as MessageData } catch { continue }

      const role = msgData.role
      if (role !== 'user' && role !== 'assistant') continue

      const partRows = db
        .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC')
        .all(msgRow.id) as Array<{ data: string }>

      const textParts: string[] = []
      for (const partRow of partRows) {
        let partData: PartData
        try { partData = JSON.parse(partRow.data) as PartData } catch { continue }
        if (partData.type === 'text') {
          const t = partData.text ?? partData.content ?? ''
          if (typeof t === 'string' && t.trim()) textParts.push(t)
        }
      }

      const text = textParts.join('\n').trim()
      if (text) result.push({ role, text: text.slice(0, 200) })
    }

    return result.slice(-3)
  } catch (e) {
    cliLog(LOG_CH, `[preview] query failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

// ── Live session / message watching ──────────────────────────────────────────

/**
 * Watch the OpenCode database for new sessions.
 *
 * Strategy: watch the DB file for changes (writes appear in WAL mode as
 * changes to the -wal file or the main DB). On change, re-query and emit
 * any newly discovered sessions via onNew.
 *
 * Returns a cleanup function.
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
        const unsub = watchOpenCodeSessions(projectPath, knownIds, onNew)
        cleanupFns.push(unsub)
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

  const checkForNew = () => {
    if (stopped) return
    const sessions = scanOpenCodeSessions(projectPath)
    for (const s of sessions) {
      if (!knownIds.has(s.sessionId)) {
        knownIds.add(s.sessionId)
        onNew(s)
      }
    }
  }

  const scheduleCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(checkForNew, 500)
  }

  // Watch the WAL file (most activity happens there in WAL mode)
  const walPath = dbPath + '-wal'
  let watcher: ReturnType<typeof watch> | null = null
  try {
    // Watch whichever exists: prefer WAL, fall back to main DB
    const watchTarget = existsSync(walPath) ? walPath : dbPath
    watcher = watch(watchTarget, scheduleCheck)
  } catch (e) {
    cliLog(LOG_CH, `[watch] failed to watch db: ${e}`)
  }

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    watcher?.close()
  }
}

/**
 * Watch the OpenCode database for new messages in a session.
 * Polls the message count; on increase, reads new parts and calls onEntry.
 * Returns a cleanup function.
 */
export function watchOpenCodeMessages(
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) return () => {}

  let stopped = false
  let lastCount = 0
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Seed initial message count (skip existing messages — they're loaded via getSessionHistory)
  try {
    const db = openDb()
    if (db) {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM message WHERE session_id = ?').get(sessionId) as { cnt: number }
      lastCount = row?.cnt ?? 0
      db.close()
    }
  } catch { /* ignore */ }

  const checkForNew = () => {
    if (stopped) return
    const db = openDb()
    if (!db) return
    try {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM message WHERE session_id = ?').get(sessionId) as { cnt: number }
      const currentCount = row?.cnt ?? 0
      if (currentCount > lastCount) {
        // Read only the newly added messages
        const msgRows = db
          .prepare('SELECT id, session_id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT ?')
          .all(sessionId, currentCount) as Array<{ id: string; session_id: string; data: string; time_created: number }>
        const newMsgRows = msgRows.slice(lastCount)
        lastCount = currentCount

        for (const msgRow of newMsgRows) {
          if (stopped) break
          let msgData: MessageData
          try { msgData = JSON.parse(msgRow.data) as MessageData } catch { continue }

          const role = msgData.role
          if (role !== 'user' && role !== 'assistant') continue

          const partRows = db
            .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC')
            .all(msgRow.id) as Array<{ data: string }>

          const blocks: HistoryBlock[] = []
          for (const partRow of partRows) {
            let partData: PartData
            try { partData = JSON.parse(partRow.data) as PartData } catch { continue }
            const block = parsePartData(partData)
            if (block) blocks.push(block)
          }

          if (blocks.length > 0 && !stopped) onEntry({ role, blocks })
        }
      }
    } catch (e) {
      cliLog(LOG_CH, `[watchMessages] query failed: ${e}`)
    } finally {
      db.close()
    }
  }

  const scheduleCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(checkForNew, 300)
  }

  // Watch WAL for changes
  const walPath = dbPath + '-wal'
  let watcher: ReturnType<typeof watch> | null = null
  try {
    const watchTarget = existsSync(walPath) ? walPath : dbPath
    watcher = watch(watchTarget, scheduleCheck)
  } catch { /* ignore */ }

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    watcher?.close()
  }
}
