import { existsSync, readdirSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { HistoryBlock, HistoryEntry } from './types'
import { cliLog } from './cliLogger'

const LOG_CH = 'Cursor Agent CLI'
const STORE_DB_NAME = 'store.db'
const POLL_INTERVAL_MS = 5000
const DEBOUNCE_MS = 300
const warnedKeys = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  cliLog(LOG_CH, `[warn] ${message}`)
}

interface CursorStoreRow {
  rowid: number
  data: Buffer | Uint8Array | string | null
}

interface CursorStoreMessage {
  role?: string
  content?: unknown
}

type BetterSqlite3Database = import('better-sqlite3').Database

const sessionDbPathCache = new Map<string, string>()

function getChatsRoot(): string {
  return join(homedir(), '.cursor', 'chats')
}

function openDb(dbPath: string): BetterSqlite3Database | null {
  if (!existsSync(dbPath)) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof import('better-sqlite3')
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch (e) {
    cliLog(LOG_CH, `[store] failed to open db ${dbPath}: ${e}`)
    return null
  }
}

function decodeBlobToMessage(data: CursorStoreRow['data']): CursorStoreMessage | null {
  if (data == null) return null

  const raw = typeof data === 'string'
    ? data
    : Buffer.from(data as Buffer | Uint8Array).toString('utf-8')

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as CursorStoreMessage
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    warnOnce(
      'store-json-schema',
      'Cursor store.db blob payload is not valid JSON. Storage format may have changed; history parsing continues in best-effort mode.'
    )
    return null
  }
}

function asToolCallInput(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // keep fallback
    }
  }
  return {}
}

function asToolResultContent(
  part: Record<string, unknown>
): Extract<HistoryBlock, { type: 'tool_result' }>['content'] {
  const exp = part.experimental_content
  if (Array.isArray(exp)) {
    const textBlocks = exp
      .filter(
        (x): x is { type: string; text?: string } =>
          !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string'
      )
      .map((x) => ({ type: x.type, text: typeof x.text === 'string' ? x.text : undefined }))
      .filter((x) => x.type === 'text' && typeof x.text === 'string')
    if (textBlocks.length > 0) return textBlocks
  }

  const result = part.result
  if (typeof result === 'string') return result
  if (result === null || result === undefined) return ''
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function parseMessageToEntry(msg: CursorStoreMessage): HistoryEntry | null {
  const role = msg.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
    warnOnce(
      'store-role-schema',
      `Cursor store message role is unsupported (role="${String(role ?? 'undefined')}"). This can indicate schema drift.`
    )
    return null
  }
  if (!Array.isArray(msg.content)) {
    warnOnce(
      'store-content-schema',
      'Cursor store message content is not an array. This can indicate a Cursor schema change.'
    )
    return null
  }

  const blocks: HistoryBlock[] = []

  for (const item of msg.content) {
    if (!item || typeof item !== 'object') continue
    const part = item as Record<string, unknown>
    const type = part.type

    if (type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
      blocks.push({ type: 'text', text: part.text })
      continue
    }

    if (type === 'reasoning' && typeof part.text === 'string' && part.text.trim().length > 0) {
      blocks.push({ type: 'thinking', thinking: part.text })
      continue
    }

    if (type === 'tool-call') {
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
      const toolName = typeof part.toolName === 'string' ? part.toolName : 'unknown'
      blocks.push({
        type: 'tool_use',
        id: toolCallId,
        name: toolName,
        input: asToolCallInput(part.args)
      })
      continue
    }

    if (type === 'tool-result') {
      const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
      blocks.push({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: asToolResultContent(part)
      })
    }
  }

  if (blocks.length === 0) return null
  return { role: role === 'tool' ? 'assistant' : role, blocks }
}

function listWorkspaceHashes(): string[] {
  const root = getChatsRoot()
  if (!existsSync(root)) return []
  try {
    return readdirSync(root).filter((name) => existsSync(join(root, name)))
  } catch {
    return []
  }
}

function locateSessionStoreDbPath(sessionId: string): string | null {
  const cached = sessionDbPathCache.get(sessionId)
  if (cached && existsSync(cached)) return cached

  const root = getChatsRoot()
  for (const hash of listWorkspaceHashes()) {
    const p = join(root, hash, sessionId, STORE_DB_NAME)
    if (existsSync(p)) {
      sessionDbPathCache.set(sessionId, p)
      return p
    }
  }
  return null
}

export function readCursorStoreHistory(sessionId: string): HistoryEntry[] {
  const dbPath = locateSessionStoreDbPath(sessionId)
  if (!dbPath) return []

  const db = openDb(dbPath)
  if (!db) return []

  try {
    const rows = db
      .prepare('SELECT rowid, data FROM blobs ORDER BY rowid ASC')
      .all() as CursorStoreRow[]

    const entries: HistoryEntry[] = []
    for (const row of rows) {
      const msg = decodeBlobToMessage(row.data)
      if (!msg) continue
      const entry = parseMessageToEntry(msg)
      if (entry) entries.push(entry)
    }
    return entries
  } catch (e) {
    cliLog(LOG_CH, `[store] read history failed for ${sessionId}: ${e}`)
    return []
  } finally {
    db.close()
  }
}

function readLatestRowId(dbPath: string): number {
  const db = openDb(dbPath)
  if (!db) return 0
  try {
    const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) as maxId FROM blobs').get() as { maxId?: number }
    return Number(row?.maxId ?? 0)
  } catch {
    return 0
  } finally {
    db.close()
  }
}

function readRowsAfter(dbPath: string, afterRowId: number): Array<{ rowid: number; entry: HistoryEntry }> {
  const db = openDb(dbPath)
  if (!db) return []

  try {
    const rows = db
      .prepare('SELECT rowid, data FROM blobs WHERE rowid > ? ORDER BY rowid ASC')
      .all(afterRowId) as CursorStoreRow[]

    const out: Array<{ rowid: number; entry: HistoryEntry }> = []
    for (const row of rows) {
      const msg = decodeBlobToMessage(row.data)
      if (!msg) continue
      const entry = parseMessageToEntry(msg)
      if (!entry) continue
      out.push({ rowid: row.rowid, entry })
    }
    return out
  } catch (e) {
    cliLog(LOG_CH, `[store] read new rows failed: ${e}`)
    return []
  } finally {
    db.close()
  }
}

export function watchCursorStoreHistory(
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  let stopped = false
  let dbPath: string | null = locateSessionStoreDbPath(sessionId)
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setInterval> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastRowId = dbPath ? readLatestRowId(dbPath) : 0

  const emitNewRows = () => {
    if (stopped || !dbPath) return
    const items = readRowsAfter(dbPath, lastRowId)
    for (const item of items) {
      if (stopped) return
      lastRowId = Math.max(lastRowId, item.rowid)
      onEntry(item.entry)
    }
  }

  const scheduleEmit = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(emitNewRows, DEBOUNCE_MS)
  }

  const startWatching = () => {
    if (stopped || !dbPath) return

    const walPath = `${dbPath}-wal`
    const target = existsSync(walPath) ? walPath : dbPath
    try {
      watcher = watch(target, scheduleEmit)
    } catch (e) {
      cliLog(LOG_CH, `[store] watch failed for ${target}: ${e}`)
      watcher = null
    }

    if (!pollTimer) {
      pollTimer = setInterval(scheduleEmit, POLL_INTERVAL_MS)
    }
  }

  if (dbPath) {
    startWatching()
  } else {
    retryTimer = setInterval(() => {
      if (stopped) return
      const found = locateSessionStoreDbPath(sessionId)
      if (!found) return
      dbPath = found
      lastRowId = readLatestRowId(found)
      if (retryTimer) {
        clearInterval(retryTimer)
        retryTimer = null
      }
      startWatching()
    }, 1000)
  }

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    if (pollTimer) clearInterval(pollTimer)
    if (retryTimer) clearInterval(retryTimer)
    watcher?.close()
  }
}
