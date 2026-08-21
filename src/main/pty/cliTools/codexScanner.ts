import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { readFile, stat as fsStat, open } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { HistoryBlock, HistoryEntry } from './types'
import { getCachedMeta, setCachedMeta, pruneCache } from './sessionMetaCache'

export interface CodexDiskSession {
  sessionId: string
  filePath: string
  cwd: string
  firstMessage: string
  title: string
  mtime: number
}

interface CodexRecord {
  type?: string
  payload?: Record<string, unknown>
}

interface CodexContentPart {
  type?: string
  text?: string
}

export function getCodexSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions')
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isSameProject(projectPath: string, cwd: string): boolean {
  const project = normalizePathForCompare(projectPath)
  const current = normalizePathForCompare(cwd)
  return current === project
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

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const p = part as CodexContentPart
      return p.type === 'input_text' || p.type === 'output_text' || p.type === 'text' || p.type === 'summary_text'
        ? (p.text ?? '')
        : ''
    })
    .filter((text) => text.trim())
    .join('\n')
    .trim()
}

function extractTextFromUserEvent(payload: Record<string, unknown>): string {
  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  if (message) return message

  const textElements = payload.text_elements
  if (!Array.isArray(textElements)) return ''
  return textElements
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        return typeof p.text === 'string' ? p.text : ''
      }
      return ''
    })
    .filter((text) => text.trim())
    .join('\n')
    .trim()
}

function extractSessionIdFromFileName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  return base.replace(/\.jsonl$/, '').replace(/^rollout-[^-]+-[0-9a-f]+-/, '')
}

function parseSessionMetadata(lines: string[], filePath: string): Pick<CodexDiskSession, 'sessionId' | 'cwd'> | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as CodexRecord
      if (obj.type !== 'session_meta') continue
      const payload = obj.payload ?? {}
      const sessionId = typeof payload.id === 'string' ? payload.id : extractSessionIdFromFileName(filePath)
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
      if (!sessionId || !cwd) return null
      return { sessionId, cwd }
    } catch {
      return null
    }
  }
  return null
}

function extractFirstAndLastUserMessage(lines: string[]): { firstMessage: string; title: string } {
  let firstMessage = ''
  let title = ''

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as CodexRecord
      const payload = obj.payload ?? {}
      let text = ''

      if (obj.type === 'event_msg' && payload.type === 'user_message') {
        text = extractTextFromUserEvent(payload)
      }

      if (!text) continue
      const clipped = text.slice(0, 80)
      if (!firstMessage) firstMessage = clipped
      title = clipped
    } catch {
      // skip malformed lines
    }
  }

  return { firstMessage, title }
}

/**
 * How much of a transcript is read to answer a listing question.
 *
 * Codex keeps every session for every project in one flat directory, and a
 * long-running project accumulates them fast — each `/compact` starts a new
 * one. Measured on this machine: 277 files, 443 MB, the largest 83 MB. Reading
 * them in full to answer "which sessions belong to this project?" put well over
 * a gigabyte of transcript text on the main-process heap at once, which is what
 * killed the app.
 *
 * Everything the session list needs lives at the two ends of the file: the
 * `session_meta` record is the first line, the most recent user message is near
 * the end. So both ends are read, and nothing in between ever is.
 */
const META_CHUNK_BYTES = 64 * 1024
const TAIL_CHUNK_BYTES = 64 * 1024

/** Read a bounded window from a file without pulling in the whole thing. */
async function readChunk(filePath: string, offset: number, length: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

/** Namespace for this tool's entries in the shared on-disk metadata cache. */
const CACHE_NS = 'codex'

export interface CodexSessionRef {
  sessionId: string
  filePath: string
  cwd: string
  mtime: number
}

/**
 * List the sessions belonging to a project, newest first, without reading any
 * transcript body. This is the cheap half of a scan.
 */
export async function listCodexSessionRefs(projectPath: string): Promise<CodexSessionRef[]> {
  const files = collectJsonlFiles(getCodexSessionsRoot())
  const refs: CodexSessionRef[] = []
  const seen = new Set<string>()

  for (const filePath of files) {
    let fileStat: import('fs').Stats
    try {
      fileStat = await fsStat(filePath)
    } catch {
      continue
    }
    seen.add(filePath)

    // A file already in the cache and unchanged costs nothing beyond the stat
    // above — no read at all. Only genuinely new or rewritten transcripts are
    // opened, which is what keeps this bounded as sessions accumulate.
    let meta: Pick<CodexDiskSession, 'sessionId' | 'cwd'> | null = null
    const cached = getCachedMeta(CACHE_NS, filePath, fileStat.mtimeMs, fileStat.size)
    if (cached?.sessionId && cached.cwd !== undefined) {
      meta = { sessionId: cached.sessionId, cwd: cached.cwd }
    } else {
      let head = ''
      try {
        head = await readChunk(filePath, 0, Math.min(fileStat.size, META_CHUNK_BYTES))
      } catch {
        continue
      }
      meta = parseSessionMetadata(head.split('\n').filter((l) => l.trim()), filePath)
      // Negative results are cached too, otherwise an unparseable transcript is
      // re-read on every single scan forever.
      setCachedMeta(CACHE_NS, filePath, fileStat.mtimeMs, fileStat.size, {
        sessionId: meta?.sessionId ?? '',
        cwd: meta?.cwd ?? ''
      })
    }

    if (!meta?.sessionId || !meta.cwd || !isSameProject(projectPath, meta.cwd)) continue
    refs.push({ sessionId: meta.sessionId, filePath, cwd: meta.cwd, mtime: fileStat.mtimeMs })
  }

  pruneCache(CACHE_NS, seen)
  return refs.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Fill in the preview fields for a set of refs. Call it with one page worth of
 * refs, not the whole list — this is the half that touches file contents.
 */
export async function describeCodexSessions(refs: CodexSessionRef[]): Promise<CodexDiskSession[]> {
  return Promise.all(
    refs.map(async (ref): Promise<CodexDiskSession> => {
      let firstMessage = ''
      let title = ''
      try {
        const size = (await fsStat(ref.filePath)).size
        const head = await readChunk(ref.filePath, 0, Math.min(size, META_CHUNK_BYTES))
        const headLines = head.split('\n').filter((l) => l.trim())
        firstMessage = extractFirstAndLastUserMessage(headLines).firstMessage

        if (size > META_CHUNK_BYTES) {
          const tailStart = Math.max(0, size - TAIL_CHUNK_BYTES)
          const tail = await readChunk(ref.filePath, tailStart, size - tailStart)
          const tailLines = tail.split('\n').filter((l) => l.trim())
          // The first line of the tail window is probably truncated.
          if (tailStart > 0) tailLines.shift()
          title = extractFirstAndLastUserMessage(tailLines).title || firstMessage
        } else {
          title = extractFirstAndLastUserMessage(headLines).title
        }
      } catch {
        // Preview is cosmetic — a ref with no preview still lists and resumes.
      }
      return {
        sessionId: ref.sessionId,
        filePath: ref.filePath,
        cwd: ref.cwd,
        firstMessage,
        title,
        mtime: ref.mtime
      }
    })
  )
}

/** One page of sessions, newest first, plus the total available. */
export async function scanCodexSessionsPaged(
  projectPath: string,
  offset: number,
  limit: number
): Promise<{ sessions: CodexDiskSession[]; total: number }> {
  const refs = await listCodexSessionRefs(projectPath)
  const page = refs.slice(offset, offset + limit)
  return { sessions: await describeCodexSessions(page), total: refs.length }
}

export async function scanCodexSessions(projectPath: string): Promise<CodexDiskSession[]> {
  const refs = await listCodexSessionRefs(projectPath)
  return describeCodexSessions(refs)
}

export function scanCodexSessionIdsSync(projectPath: string): Set<string> {
  const ids = new Set<string>()
  for (const filePath of collectJsonlFiles(getCodexSessionsRoot())) {
    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      continue
    }
    try {
      const size = Math.min(fstatSync(fd).size, 65536)
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, 0)
      const lines = buf.toString('utf-8').split('\n').filter((line) => line.trim())
      const meta = parseSessionMetadata(lines, filePath)
      if (meta && isSameProject(projectPath, meta.cwd)) ids.add(meta.sessionId)
    } finally {
      closeSync(fd)
    }
  }
  return ids
}

export async function findCodexSessionFile(projectPath: string, sessionId: string): Promise<string | null> {
  // Refs carry the session id, so no transcript body needs reading to locate one.
  const refs = await listCodexSessionRefs(projectPath)
  return refs.find((ref) => ref.sessionId === sessionId)?.filePath ?? null
}

export function findCodexSessionFileSync(projectPath: string, sessionId: string): string | null {
  for (const filePath of collectJsonlFiles(getCodexSessionsRoot())) {
    // Only the head is needed: `session_meta` is the first record. This used to
    // read every transcript in full, synchronously, on the main thread.
    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      continue
    }
    let meta: Pick<CodexDiskSession, 'sessionId' | 'cwd'> | null = null
    try {
      const size = Math.min(fstatSync(fd).size, META_CHUNK_BYTES)
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, 0)
      const lines = buf.toString('utf-8').split('\n').filter((line) => line.trim())
      meta = parseSessionMetadata(lines, filePath)
    } finally {
      closeSync(fd)
    }
    if (!meta || meta.sessionId !== sessionId || !isSameProject(projectPath, meta.cwd)) continue
    return filePath
  }
  return null
}

function parseMessageBlocks(payload: Record<string, unknown>): { role: 'user' | 'assistant' | null; blocks: HistoryBlock[] } {
  const role = payload.role === 'user' || payload.role === 'assistant' ? payload.role : null
  if (!role) return { role: null, blocks: [] }
  const text = extractTextFromContent(payload.content)
  return {
    role,
    blocks: text ? [{ type: 'text', text }] : []
  }
}

export function parseCodexHistoryLine(line: string): HistoryEntry | null {
  let obj: CodexRecord
  try {
    obj = JSON.parse(line) as CodexRecord
  } catch {
    return null
  }

  const payload = obj.payload ?? {}

  if (obj.type === 'event_msg' && payload.type === 'user_message') {
    const text = extractTextFromUserEvent(payload)
    return text ? { role: 'user', blocks: [{ type: 'text', text }] } : null
  }

  if (obj.type !== 'response_item') return null

  if (payload.type === 'message') {
    const parsed = parseMessageBlocks(payload)
    if (parsed.role !== 'assistant' || parsed.blocks.length === 0) return null
    return { role: parsed.role, blocks: parsed.blocks }
  }

  if (payload.type === 'reasoning') {
    const text = extractTextFromContent(payload.content) || extractTextFromContent(payload.summary)
    return text ? { role: 'assistant', blocks: [{ type: 'thinking', thinking: text }] } : null
  }

  if (payload.type === 'function_call') {
    let input: unknown = {}
    if (typeof payload.arguments === 'string' && payload.arguments.trim()) {
      try {
        input = JSON.parse(payload.arguments)
      } catch {
        input = payload.arguments
      }
    }
    return {
      role: 'assistant',
      blocks: [{
        type: 'tool_use',
        id: String(payload.call_id ?? ''),
        name: String(payload.name ?? 'unknown'),
        input
      }]
    }
  }

  if (payload.type === 'function_call_output') {
    const content = typeof payload.output === 'string'
      ? payload.output
      : JSON.stringify(payload.output ?? '')
    return {
      role: 'user',
      blocks: [{
        type: 'tool_result',
        tool_use_id: String(payload.call_id ?? ''),
        content
      }]
    }
  }

  return null
}

export async function readCodexSessionHistory(filePath: string): Promise<HistoryEntry[]> {
  let content = ''
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  const entries: HistoryEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = parseCodexHistoryLine(trimmed)
    if (entry) entries.push(entry)
  }
  return entries
}

export function readCodexSessionPreview(filePath: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }

  try {
    const fileSize = fstatSync(fd).size
    const maxChunk = Math.min(fileSize, 65536)
    const startOffset = fileSize - maxChunk
    const buf = Buffer.alloc(maxChunk)
    readSync(fd, buf, 0, maxChunk, startOffset)
    const lines = buf.toString('utf-8').split('\n').filter((line) => line.trim())
    if (startOffset > 0) lines.shift()

    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = []
    for (const line of lines) {
      const entry = parseCodexHistoryLine(line)
      if (!entry) continue
      const text = entry.blocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text) messages.push({ role: entry.role, text: text.slice(0, 200) })
    }
    return messages.slice(-3)
  } finally {
    closeSync(fd)
  }
}

export function watchCodexSessionFile(
  filePath: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  if (!existsSync(filePath)) return () => {}

  let stopped = false
  let watcher: FSWatcher | null = null
  let offset = 0

  try {
    const fd = openSync(filePath, 'r')
    offset = fstatSync(fd).size
    closeSync(fd)
  } catch {
    return () => {}
  }

  const readNewEntries = () => {
    if (stopped || !existsSync(filePath)) return

    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      return
    }

    try {
      const fileStat = fstatSync(fd)
      if (fileStat.size <= offset) return

      const len = fileStat.size - offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      offset = fileStat.size

      for (const line of buf.toString('utf-8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry = parseCodexHistoryLine(trimmed)
        if (entry && !stopped) onEntry(entry)
      }
    } finally {
      closeSync(fd)
    }
  }

  try {
    watcher = watch(filePath, readNewEntries)
  } catch {
    // ignore; polling below still catches updates
  }

  const pollInterval = setInterval(readNewEntries, 5000)

  return () => {
    stopped = true
    clearInterval(pollInterval)
    watcher?.close()
  }
}

export function watchCodexSessions(
  projectPath: string,
  knownIds: Set<string>,
  onNew: (session: CodexDiskSession) => void
): () => void {
  let stopped = false
  let watcher: FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const checkForNew = async () => {
    if (stopped) return
    const sessions = await scanCodexSessions(projectPath)
    for (const session of sessions) {
      if (knownIds.has(session.sessionId)) continue
      knownIds.add(session.sessionId)
      if (!stopped) onNew(session)
    }
  }

  const scheduleCheck = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void checkForNew() }, 500)
  }

  if (existsSync(getCodexSessionsRoot())) {
    try {
      watcher = watch(getCodexSessionsRoot(), { recursive: true }, scheduleCheck)
    } catch {
      watcher = null
    }
  }

  const pollInterval = setInterval(scheduleCheck, 2000)

  return () => {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    clearInterval(pollInterval)
    watcher?.close()
  }
}

export function getCodexSessionMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}
