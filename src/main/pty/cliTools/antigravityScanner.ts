/**
 * Antigravity CLI session scanning, transcript reading, and live history watching.
 *
 * Antigravity CLI (`agy`) keeps its data under `~/.gemini/antigravity-cli/`:
 *   conversation_summaries.db  — SQLite (WAL) table `conversation_summaries`
 *       (conversation_id, title, preview, step_count, last_modified_time,
 *        workspace_uris JSON array of file:/// URIs, parent_conversation_id,
 *        nesting_depth, ...)
 *   brain/<id>/.system_generated/logs/transcript.jsonl — appendable JSONL
 *       (plus `transcript_full.jsonl` with un-truncated payloads)
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import type { HistoryBlock, HistoryEntry } from './types'
import { antigravityToolView } from './toolViews'
import { cliLog } from './cliLogger'

const LOG_CH = 'Antigravity'

export interface AntigravitySessionRow {
  conversationId: string
  title: string
  preview: string
  lastModified: Date
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function getAntigravityDataDir(home = homedir()): string {
  return join(home, '.gemini', 'antigravity-cli')
}

export function getAntigravityDbPath(home = homedir()): string {
  return join(getAntigravityDataDir(home), 'conversation_summaries.db')
}

export function getAntigravityTranscriptPath(sessionId: string, full = false, home = homedir()): string {
  const file = full ? 'transcript_full.jsonl' : 'transcript.jsonl'
  return join(getAntigravityDataDir(home), 'brain', sessionId, '.system_generated', 'logs', file)
}

// ── Workspace URI normalization ───────────────────────────────────────────────

export function normalizePathForCompare(p: string): string {
  return p
    .replace(/^\\\\\?\\UNC\\/, '\\\\')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

export function workspaceUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''))
  }
}

export function workspaceUrisMatchProject(workspaceUrisJson: string, projectPath: string): boolean {
  let uris: unknown
  try {
    uris = JSON.parse(workspaceUrisJson)
  } catch {
    return false
  }
  if (!Array.isArray(uris)) return false
  const target = normalizePathForCompare(projectPath)
  return uris.some((u) => typeof u === 'string' && normalizePathForCompare(workspaceUriToPath(u)) === target)
}

// ── SQLite access ─────────────────────────────────────────────────────────────

function openDb(dbPath = getAntigravityDbPath()): import('better-sqlite3').Database | null {
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

interface RawSummaryRow {
  conversation_id: string
  title: string | null
  preview: string | null
  last_modified_time: string
  workspace_uris: string
}

function parseSqliteDate(value: string): Date {
  // Go-formatted timestamps look like "2026-11-21 22:46:52.6021011+00:00"
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed
}

/** Top-level Antigravity conversations belonging to `projectPath`, newest first. */
export function listAntigravitySessions(projectPath: string, dbPath = getAntigravityDbPath()): AntigravitySessionRow[] {
  const db = openDb(dbPath)
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, last_modified_time, workspace_uris
         FROM conversation_summaries
         WHERE parent_conversation_id = '' AND nesting_depth = 0
         ORDER BY last_modified_time DESC`
      )
      .all() as RawSummaryRow[]
    return rows
      .filter((r) => workspaceUrisMatchProject(r.workspace_uris, projectPath))
      .map((r) => ({
        conversationId: r.conversation_id,
        title: (r.title ?? '').trim(),
        preview: (r.preview ?? '').trim(),
        lastModified: parseSqliteDate(r.last_modified_time)
      }))
  } catch (e) {
    cliLog(LOG_CH, `[sessions] query failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

export function scanAntigravitySessionIdsSync(projectPath: string, dbPath = getAntigravityDbPath()): Set<string> {
  return new Set(listAntigravitySessions(projectPath, dbPath).map((s) => s.conversationId))
}

/** Watch conversation_summaries.db (and its WAL) for new top-level sessions in `projectPath`. */
export function watchAntigravitySessions(
  projectPath: string,
  knownIds: Set<string>,
  onNew: (session: AntigravitySessionRow) => void,
  dataDir = getAntigravityDataDir()
): () => void {
  const dbPath = join(dataDir, 'conversation_summaries.db')
  let stopped = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  const scan = (): void => {
    if (stopped) return
    for (const s of listAntigravitySessions(projectPath, dbPath)) {
      if (!knownIds.has(s.conversationId)) {
        knownIds.add(s.conversationId)
        onNew(s)
      }
    }
  }

  const scheduleScan = (): void => {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      scan()
    }, 300)
  }

  if (existsSync(dataDir)) {
    try {
      watcher = watch(dataDir, (_event, filename) => {
        if (!filename || filename.startsWith('conversation_summaries.db')) {
          scheduleScan()
        }
      })
    } catch { /* fallback to periodic check */ }
  }

  const poll = setInterval(scan, 5000)

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    clearInterval(poll)
    watcher?.close()
  }
}

// ── Transcript JSONL parsing ──────────────────────────────────────────────────

/** Unwrap `<USER_REQUEST>\n...\n</USER_REQUEST>` envelopes in Antigravity transcripts. */
export function extractUserRequestText(raw: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw)
  return (match ? match[1] : raw).trim()
}

/** Values inside transcript `tool_calls[].args` are often JSON-encoded strings (e.g. `"\"E:\\\\x\""`). */
function decodeToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      try {
        out[key] = JSON.parse(value)
      } catch {
        out[key] = value
      }
    } else {
      out[key] = value
    }
  }
  return out
}

interface ParsedTranscriptStep {
  entry: HistoryEntry
  /** Tool call ids emitted by this step (used to pair following GENERIC result steps). */
  toolCallIds: string[]
}

export function parseAntigravityTranscriptStep(line: string, pendingToolIds: string[] = []): ParsedTranscriptStep | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null

  const type = typeof obj.type === 'string' ? obj.type : ''
  const stepIndex = typeof obj.step_index === 'number' ? obj.step_index : 0

  if (type === 'USER_INPUT') {
    const raw = typeof obj.content === 'string' ? obj.content : ''
    const text = extractUserRequestText(raw)
    if (!text) return null
    return { entry: { role: 'user', blocks: [{ type: 'text', text }] }, toolCallIds: [] }
  }

  if (type === 'PLANNER_RESPONSE') {
    const blocks: HistoryBlock[] = []
    if (typeof obj.thinking === 'string' && obj.thinking.trim()) {
      blocks.push({ type: 'thinking', thinking: obj.thinking.trim() })
    }
    if (typeof obj.content === 'string' && obj.content.trim()) {
      blocks.push({ type: 'text', text: obj.content })
    }
    const toolCallIds: string[] = []
    if (Array.isArray(obj.tool_calls)) {
      obj.tool_calls.forEach((rawCall, idx) => {
        if (!rawCall || typeof rawCall !== 'object') return
        const call = rawCall as { id?: unknown; name?: unknown; args?: unknown }
        const name = typeof call.name === 'string' ? call.name : ''
        if (!name) return
        const id = typeof call.id === 'string' && call.id ? call.id : `step-${stepIndex}-call-${idx}`
        const input = decodeToolArgs(call.args)
        toolCallIds.push(id)
        blocks.push({ type: 'tool_use', id, name, input, view: antigravityToolView(name, input) })
      })
    }
    if (blocks.length === 0) return null
    return { entry: { role: 'assistant', blocks }, toolCallIds }
  }

  if (type === 'GENERIC') {
    const content = typeof obj.content === 'string' ? obj.content : ''
    if (!content.trim()) return null
    const toolUseId = pendingToolIds.shift() ?? `step-${stepIndex}`
    return {
      entry: { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
      toolCallIds: []
    }
  }

  return null
}

/** Extract thinking texts from one transcript JSONL line (used by ThinkingWatcher). */
export function parseAntigravityThinkingBlocks(line: string): string[] {
  try {
    const obj = JSON.parse(line) as { type?: unknown; thinking?: unknown }
    if (obj.type !== 'PLANNER_RESPONSE') return []
    if (typeof obj.thinking === 'string' && obj.thinking.trim()) return [obj.thinking.trim()]
    return []
  } catch {
    return []
  }
}

function bestTranscriptPath(sessionId: string, home = homedir()): string | null {
  const full = getAntigravityTranscriptPath(sessionId, true, home)
  if (existsSync(full)) return full
  const compact = getAntigravityTranscriptPath(sessionId, false, home)
  return existsSync(compact) ? compact : null
}

/** Extract the first user prompt from the start of a session transcript. */
export function readAntigravityFirstMessage(sessionId: string, home = homedir()): string {
  const filePath = getAntigravityTranscriptPath(sessionId, false, home)
  if (!existsSync(filePath)) return ''
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return ''
  }
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    for (const line of buf.toString('utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseAntigravityTranscriptStep(trimmed)
      if (parsed?.entry.role === 'user') {
        const textBlock = parsed.entry.blocks.find((b): b is { type: 'text'; text: string } => b.type === 'text')
        if (textBlock?.text) return textBlock.text.replace(/\s+/g, ' ').slice(0, 80)
      }
    }
    return ''
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

export function readAntigravitySessionPreview(
  sessionId: string,
  home = homedir()
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const filePath = getAntigravityTranscriptPath(sessionId, false, home)
  if (!existsSync(filePath)) return []
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, 64 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf-8').split('\n')
    if (size > len) lines.shift()

    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseAntigravityTranscriptStep(trimmed)
      if (!parsed) continue
      const text = parsed.entry.blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text) messages.push({ role: parsed.entry.role, text: text.slice(0, 200) })
    }
    return messages.slice(-4)
  } catch {
    return []
  } finally {
    closeSync(fd)
  }
}

export function readAntigravitySessionHistory(sessionId: string, home = homedir()): HistoryEntry[] {
  const filePath = bestTranscriptPath(sessionId, home)
  if (!filePath) return []
  try {
    const content = readFileSync(filePath, 'utf-8')
    const entries: HistoryEntry[] = []
    const pendingToolIds: string[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseAntigravityTranscriptStep(trimmed, pendingToolIds)
      if (!parsed) continue
      if (parsed.toolCallIds.length > 0) pendingToolIds.push(...parsed.toolCallIds)
      entries.push(parsed.entry)
    }
    return entries
  } catch (e) {
    cliLog(LOG_CH, `[history] failed to read ${filePath}: ${e}`)
    return []
  }
}

export function subscribeAntigravitySessionHistory(
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void,
  home = homedir()
): () => void {
  const filePath = bestTranscriptPath(sessionId, home) ?? getAntigravityTranscriptPath(sessionId, false, home)
  let stopped = false
  let watcher: FSWatcher | null = null
  let waitInterval: ReturnType<typeof setInterval> | null = null
  const pendingToolIds: string[] = []

  let offset = 0
  if (existsSync(filePath)) {
    try {
      const fd = openSync(filePath, 'r')
      offset = fstatSync(fd).size
      closeSync(fd)
    } catch { /* ignore */ }
  }

  let remainder = ''
  const readNew = (): void => {
    if (stopped || !existsSync(filePath)) return
    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size <= offset) return
      const len = size - offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      offset = size

      const text = remainder + buf.toString('utf-8')
      const lines = text.split('\n')
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = parseAntigravityTranscriptStep(trimmed, pendingToolIds)
        if (!parsed || stopped) continue
        if (parsed.toolCallIds.length > 0) pendingToolIds.push(...parsed.toolCallIds)
        onEntry(parsed.entry)
      }
    } finally {
      closeSync(fd)
    }
  }

  const attach = (): void => {
    try {
      watcher = watch(filePath, () => readNew())
    } catch { /* ignore */ }
  }

  if (existsSync(filePath)) {
    attach()
  } else {
    waitInterval = setInterval(() => {
      if (stopped) {
        if (waitInterval) clearInterval(waitInterval)
        return
      }
      if (existsSync(filePath)) {
        if (waitInterval) clearInterval(waitInterval)
        waitInterval = null
        readNew()
        attach()
      }
    }, 500)
  }

  return () => {
    stopped = true
    if (waitInterval) clearInterval(waitInterval)
    watcher?.close()
  }
}
