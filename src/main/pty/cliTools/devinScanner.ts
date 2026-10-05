/**
 * Devin CLI session scanning and history reading — direct SQLite access.
 *
 * Devin keeps its data in the user data dir (%APPDATA%\devin on Windows,
 * $XDG_DATA_HOME/devin elsewhere):
 *   cli/sessions.db            — SQLite (WAL) session store. Tables:
 *       sessions(id, working_directory, title, model, agent_mode,
 *                created_at, last_activity_at, main_chain_id, hidden, ...)
 *       message_nodes(row_id, session_id, node_id, parent_node_id,
 *                     chat_message, created_at) — live conversation forest;
 *                     chat_message is a ChatMessage JSON:
 *                     {message_id, role: system|user|assistant|tool, content,
 *                      thinking{thinking}, tool_calls[{id,name,arguments}],
 *                      tool_call_id, metadata.is_user_input}
 *       prompt_history(session_id, content, is_shell, timestamp) — real prompts
 *   cli/session_locks/*.lock   — one lock file per live session
 *   cli/transcripts/<id>.json  — ATIF export, materialised at session end
 *   cli/trusted_workspaces.json — workspace trust list
 *   credentials.toml           — session token
 *
 * Everything is read straight from sessions.db — spawning `devin list` takes
 * ~1.5 s per call, which is unusable for watches and would freeze the main
 * process if done synchronously.
 */

import { existsSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { HistoryBlock, HistoryEntry } from './types'
import { cliLog } from './cliLogger'

const LOG_CH = 'Devin'

export interface DevinListEntry {
  id: string
  title: string
  lastModified: Date
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getDevinDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'devin')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'devin')
}

export function getDevinCliDir(): string {
  return join(getDevinDataDir(), 'cli')
}

export function getDevinDbPath(): string {
  return join(getDevinCliDir(), 'sessions.db')
}

export function getDevinTranscriptPath(sessionId: string): string {
  return join(getDevinCliDir(), 'transcripts', `${sessionId}.json`)
}

// ── Database access ─────────────────────────────────────────────────────────

/**
 * Open sessions.db in read-only mode (WAL allows concurrent readers).
 * Lazy require() so a missing/mismatched better-sqlite3 fails gracefully.
 * Caller must close() the returned handle.
 */
function openDb(): import('better-sqlite3').Database | null {
  const dbPath = getDevinDbPath()
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

function normalizePathForCompare(p: string): string {
  return p.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

// ── Sessions ────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string
  working_directory: string
  title: string | null
  last_activity_at: number
}

/** Sessions belonging to a project dir, newest first. Cheap local SQL. */
export function listDevinSessions(projectPath: string): DevinListEntry[] {
  const db = openDb()
  if (!db) return []
  try {
    const rows = db
      .prepare('SELECT id, working_directory, title, last_activity_at FROM sessions WHERE hidden = 0 ORDER BY last_activity_at DESC')
      .all() as SessionRow[]
    const project = normalizePathForCompare(projectPath)
    return rows
      .filter((r) => normalizePathForCompare(r.working_directory ?? '') === project)
      .map((r) => ({
        id: r.id,
        title: r.title ?? '',
        lastModified: new Date(r.last_activity_at * 1000)
      }))
  } catch (e) {
    cliLog(LOG_CH, `[sessions] query failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

export function scanDevinSessionIdsSync(projectPath: string): Set<string> {
  return new Set(listDevinSessions(projectPath).map((s) => s.id))
}

/** Current title of one session, or null. */
export function getDevinSessionTitle(sessionId: string): string | null {
  const db = openDb()
  if (!db) return null
  try {
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string | null } | undefined
    return row?.title ?? null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** First real user prompt of a session (prompt_history, non-shell). */
export function getDevinFirstPrompt(sessionId: string): string {
  const db = openDb()
  if (!db) return ''
  try {
    const row = db
      .prepare('SELECT content FROM prompt_history WHERE session_id = ? AND is_shell = 0 ORDER BY id LIMIT 1')
      .get(sessionId) as { content: string } | undefined
    return row?.content.trim().slice(0, 80) ?? ''
  } catch {
    return ''
  } finally {
    db.close()
  }
}

/**
 * Watch the sessions table for new sessions in this project.
 * The DB lives in WAL mode, so writes land in sessions.db-wal; we watch the
 * cli dir (covers both files), debounce, and diff. A slow poll catches events
 * the watcher missed.
 */
export function watchDevinSessions(
  projectPath: string,
  knownIds: Set<string>,
  onNew: (session: DevinListEntry) => void
): () => void {
  const cliDir = getDevinCliDir()
  let stopped = false
  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null

  const checkNew = () => {
    if (stopped) return
    for (const session of listDevinSessions(projectPath)) {
      if (knownIds.has(session.id)) continue
      knownIds.add(session.id)
      if (!stopped) onNew(session)
    }
  }

  const scheduleCheck = () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(checkNew, 300)
  }

  if (existsSync(cliDir)) {
    try {
      watcher = watch(cliDir, { persistent: false }, (_event, filename) => {
        if (filename?.startsWith('sessions.db')) scheduleCheck()
      })
    } catch { /* ignore */ }
  }

  const poll = setInterval(checkNew, 5000)

  return () => {
    stopped = true
    if (debounce) clearTimeout(debounce)
    clearInterval(poll)
    watcher?.close()
  }
}

/** Stream title updates for one session (titles are generated asynchronously). */
export function watchDevinSessionLabel(
  sessionId: string,
  onLabel: (label: string) => void
): () => void {
  const cliDir = getDevinCliDir()
  if (!existsSync(cliDir)) return () => {}

  let stopped = false
  let lastLabel = ''
  let debounce: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  const check = () => {
    if (stopped) return
    const title = getDevinSessionTitle(sessionId)
    if (title && title !== lastLabel) {
      lastLabel = title
      onLabel(title)
    }
  }

  try {
    watcher = watch(cliDir, { persistent: false }, (_event, filename) => {
      if (!filename?.startsWith('sessions.db')) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(check, 500)
    })
  } catch { /* ignore */ }

  return () => {
    stopped = true
    if (debounce) clearTimeout(debounce)
    watcher?.close()
  }
}

// ── ChatMessage → HistoryEntry ───────────────────────────────────────────────

interface DevinChatMessage {
  message_id?: string
  role?: string
  content?: unknown
  thinking?: { thinking?: unknown }
  tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown }>
  tool_call_id?: string
  metadata?: { is_user_input?: boolean | null }
}

interface NodeRow {
  row_id: number
  node_id: number
  parent_node_id: number | null
  chat_message: string
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const p = part as { text?: unknown; content?: unknown }
        if (typeof p.text === 'string') return p.text
        if (typeof p.content === 'string') return p.content
      }
      return ''
    })
    .filter((t) => t.trim())
    .join('\n')
    .trim()
}

function messageToEntry(msg: DevinChatMessage): HistoryEntry | null {
  if (msg.role === 'user') {
    // Internal chain-driving messages ("continue") carry is_user_input != true.
    if (msg.metadata?.is_user_input !== true) return null
    const text = extractText(msg.content)
    return text ? { role: 'user', blocks: [{ type: 'text', text }] } : null
  }

  if (msg.role === 'assistant') {
    const blocks: HistoryBlock[] = []
    const thinking = typeof msg.thinking?.thinking === 'string' ? msg.thinking.thinking.trim() : ''
    if (thinking) blocks.push({ type: 'thinking', thinking })

    const text = extractText(msg.content)
    if (text) blocks.push({ type: 'text', text })

    for (const call of msg.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: String(call.id ?? ''),
        name: String(call.name ?? 'unknown'),
        input: call.arguments
      })
    }
    return blocks.length > 0 ? { role: 'assistant', blocks } : null
  }

  if (msg.role === 'tool') {
    const content = extractText(msg.content)
    if (!content) return null
    return {
      role: 'assistant',
      blocks: [{
        type: 'tool_result',
        tool_use_id: String(msg.tool_call_id ?? ''),
        content
      }]
    }
  }

  return null
}

function parseNode(row: NodeRow): { msg: DevinChatMessage; entry: HistoryEntry | null } | null {
  try {
    const msg = JSON.parse(row.chat_message) as DevinChatMessage
    return { msg, entry: messageToEntry(msg) }
  } catch {
    return null
  }
}

/**
 * Load the visible conversation as a linear sequence.
 *
 * message_nodes is a forest: each turn re-anchors prior context under a new
 * root (same message_id, new node_id) and the per-turn user prompt lives on a
 * side chain — walking main_chain_id's ancestors alone would drop user input.
 * Flattening by node_id and deduplicating on message_id (first occurrence
 * wins) reproduces the chronological conversation.
 */
function loadChainEntries(sessionId: string): HistoryEntry[] {
  const db = openDb()
  if (!db) return []
  try {
    const rows = db
      .prepare('SELECT row_id, node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY node_id')
      .all(sessionId) as NodeRow[]

    const entries: HistoryEntry[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const parsed = parseNode(row)
      if (!parsed) continue
      const mid = parsed.msg.message_id
      if (mid) {
        if (seen.has(mid)) continue
        seen.add(mid)
      }
      if (parsed.entry) entries.push(parsed.entry)
    }
    return entries
  } catch (e) {
    cliLog(LOG_CH, `[history] query failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

export function readDevinSessionHistory(sessionId: string): HistoryEntry[] {
  return loadChainEntries(sessionId)
}

export function readDevinSessionPreview(sessionId: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  const entries = loadChainEntries(sessionId)
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const entry of entries) {
    const text = entry.blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) messages.push({ role: entry.role, text: text.slice(0, 200) })
  }
  return messages.slice(-3)
}

/**
 * Live subscription: message_nodes.row_id is an insertion-order cursor.
 * On each poll/watch fire we fetch rows newer than the cursor, skip rows whose
 * message_id was already emitted (re-anchored copies), and convert to entries.
 */
export function subscribeDevinSessionHistory(
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  let stopped = false
  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let lastRowId = 0
  const emittedMsgIds = new Set<string>()

  const poll = () => {
    if (stopped) return
    const db = openDb()
    if (!db) return
    try {
      const rows = db
        .prepare('SELECT row_id, node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id')
        .all(sessionId, lastRowId) as NodeRow[]
      for (const row of rows) {
        lastRowId = Math.max(lastRowId, row.row_id)
        const parsed = parseNode(row)
        if (!parsed) continue
        const mid = parsed.msg.message_id
        if (mid) {
          if (emittedMsgIds.has(mid)) continue
          emittedMsgIds.add(mid)
        }
        if (parsed.entry && !stopped) onEntry(parsed.entry)
      }
    } catch (e) {
      cliLog(LOG_CH, `[subscribe] query failed: ${e}`)
    } finally {
      db.close()
    }
  }

  // Baseline: existing rows are delivered via getSessionHistory.
  const db = openDb()
  if (db) {
    try {
      const rows = db
        .prepare('SELECT row_id, chat_message FROM message_nodes WHERE session_id = ?')
        .all(sessionId) as Array<{ row_id: number; chat_message: string }>
      for (const row of rows) {
        lastRowId = Math.max(lastRowId, row.row_id)
        try {
          const mid = (JSON.parse(row.chat_message) as DevinChatMessage).message_id
          if (mid) emittedMsgIds.add(mid)
        } catch { /* skip malformed */ }
      }
    } catch { /* ignore */ } finally {
      db.close()
    }
  }

  const cliDir = getDevinCliDir()
  if (existsSync(cliDir)) {
    try {
      watcher = watch(cliDir, { persistent: false }, (_event, filename) => {
        if (!filename?.startsWith('sessions.db')) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(poll, 300)
      })
    } catch { /* ignore */ }
  }

  const interval = setInterval(poll, 3000)

  return () => {
    stopped = true
    if (debounce) clearTimeout(debounce)
    clearInterval(interval)
    watcher?.close()
  }
}
