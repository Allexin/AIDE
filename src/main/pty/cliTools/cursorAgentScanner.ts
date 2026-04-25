import { existsSync, readdirSync, statSync, watch, openSync, fstatSync, readSync, closeSync } from 'fs'
import type { FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { CliSession, HistoryBlock, HistoryEntry } from './types'
import { cliLog } from './cliLogger'

const LOG_CH = 'Cursor Agent CLI'
const warnedKeys = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  cliLog(LOG_CH, `[warn] ${message}`)
}

interface CursorTranscriptEntry {
  role?: 'user' | 'assistant'
  message?: {
    content?: Array<Record<string, unknown>> | string
  }
}

function projectSlug(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/')

  if (platform() === 'win32') {
    const driveMatch = /^([A-Za-z]):\/?(.*)$/.exec(normalized)
    if (driveMatch) {
      const drive = driveMatch[1].toLowerCase()
      const rest = driveMatch[2]
      return `${drive}-${rest}`.replace(/[^A-Za-z0-9]/g, '-')
    }
  }

  return normalized.replace(/^\/+/, '').replace(/[^A-Za-z0-9]/g, '-')
}

function getTranscriptsDir(projectPath: string): string {
  return join(homedir(), '.cursor', 'projects', projectSlug(projectPath), 'agent-transcripts')
}

export function getCursorSessionFilePath(projectPath: string, sessionId: string): string {
  return join(getTranscriptsDir(projectPath), sessionId, `${sessionId}.jsonl`)
}

function clip(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) : text
}

function normalizeChatText(raw: string): string {
  const withoutTs = raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '').trim()
  const queryMatch = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(withoutTs)
  const body = (queryMatch?.[1] ?? withoutTs).trim()
  return body.replace(/\r\n/g, '\n')
}

function extractTextFromContent(content: CursorTranscriptEntry['message'] extends { content?: infer T } ? T : unknown): string {
  if (typeof content === 'string') return normalizeChatText(content)
  if (!Array.isArray(content)) return ''

  const chunks: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const t = normalizeChatText(block.text)
      if (t) chunks.push(t)
    }
  }

  return chunks.join('\n').trim()
}

function parseEntry(line: string): CursorTranscriptEntry | null {
  try {
    const obj = JSON.parse(line) as CursorTranscriptEntry
    if (obj.role !== 'user' && obj.role !== 'assistant') {
      warnOnce(
        'transcript-role-schema',
        `Cursor transcript role schema changed (role="${String(obj.role ?? 'undefined')}"). Falling back to best-effort parsing.`
      )
      return null
    }
    if (!obj.message || typeof obj.message !== 'object') {
      warnOnce(
        'transcript-message-schema',
        'Cursor transcript message payload is missing or invalid. This may indicate a Cursor storage format change.'
      )
      return null
    }
    return obj
  } catch {
    warnOnce(
      'transcript-json-parse',
      'Cursor transcript JSONL contains non-JSON lines. Storage format may have changed; parsing continues in best-effort mode.'
    )
    return null
  }
}

function normalizeThinkingText(raw: string): string | null {
  const noAnsi = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  const lines = noAnsi
    .split('\n')
    .map((line) =>
      line
        .replace(/^[\s|│┃┆┊┇┋]+/, '')
        .replace(/[\s|│┃┆┊┇┋]+$/, '')
    )
    .filter((line) => line.length > 0)
    .filter((line) => !/^…?\s*Thought for\b/i.test(line))
    .filter((line) => !/^Thought for\b/i.test(line))

  if (lines.length === 0) return null
  const joined = lines.join('\n').trim()
  if (!joined) return null
  if (!/[\p{L}\p{N}]/u.test(joined)) return null
  return joined
}

async function readEntries(filePath: string): Promise<CursorTranscriptEntry[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    warnOnce(
      'transcript-read-failed',
      `Failed to read Cursor transcript file: ${filePath}. Session scanning may be incomplete.`
    )
    return []
  }

  const entries: CursorTranscriptEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = parseEntry(trimmed)
    if (entry) entries.push(entry)
  }
  return entries
}

function asHistoryBlocks(entry: CursorTranscriptEntry): HistoryBlock[] {
  const content = entry.message?.content
  if (typeof content === 'string') {
    const text = normalizeChatText(content)
    return text ? [{ type: 'text', text }] : []
  }
  if (!Array.isArray(content)) return []

  const blocks: HistoryBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const type = part.type
    if (type === 'text' && typeof part.text === 'string') {
      const text = normalizeChatText(part.text)
      if (text) blocks.push({ type: 'text', text })
      continue
    }
    if (type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
      blocks.push({ type: 'thinking', thinking: part.thinking })
      continue
    }
    if (type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: String(part.id ?? ''),
        name: String(part.name ?? 'unknown'),
        input: (part.input as Record<string, unknown>) ?? {}
      })
      continue
    }
    if (type === 'tool_result') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: String(part.tool_use_id ?? ''),
        content: (part.content as string | Array<{ type: string; text?: string }>) ?? ''
      })
    }
  }

  return blocks
}

export async function scanCursorSessions(projectPath: string, fallbackSlug: string): Promise<CliSession[]> {
  const dir = getTranscriptsDir(projectPath)
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const sessions: CliSession[] = []
  for (const sessionId of entries) {
    const filePath = getCursorSessionFilePath(projectPath, sessionId)
    if (!existsSync(filePath)) continue

    let lastModified: Date
    try {
      lastModified = statSync(filePath).mtime
    } catch {
      continue
    }

    const parsed = await readEntries(filePath)
    let firstMessage = ''
    let lastUserMessage = ''

    for (const entry of parsed) {
      if (entry.role !== 'user') continue
      const text = extractTextFromContent(entry.message?.content)
      if (!text) continue
      if (!firstMessage) firstMessage = clip(text, 120)
      lastUserMessage = clip(text, 120)
    }

    sessions.push({
      sessionId,
      firstMessage: firstMessage || undefined,
      slug: lastUserMessage || firstMessage || fallbackSlug,
      lastModified
    })
  }

  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
}

export async function readCursorSessionPreview(
  projectPath: string,
  sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const filePath = getCursorSessionFilePath(projectPath, sessionId)
  if (!existsSync(filePath)) return []

  const entries = await readEntries(filePath)
  const preview = entries
    .map((entry) => {
      const text = extractTextFromContent(entry.message?.content)
      if (!text || (entry.role !== 'user' && entry.role !== 'assistant')) return null
      return { role: entry.role, text: clip(text, 200) }
    })
    .filter((item): item is { role: 'user' | 'assistant'; text: string } => item !== null)

  return preview.slice(-3)
}

export async function readCursorSessionHistory(projectPath: string, sessionId: string): Promise<HistoryEntry[]> {
  const filePath = getCursorSessionFilePath(projectPath, sessionId)
  if (!existsSync(filePath)) return []

  const entries = await readEntries(filePath)
  const out: HistoryEntry[] = []
  for (const entry of entries) {
    if (entry.role !== 'user' && entry.role !== 'assistant') continue
    const blocks = asHistoryBlocks(entry)
    if (blocks.length === 0) continue
    out.push({ role: entry.role, blocks })
  }
  return out
}

function parseHistoryLine(line: string): HistoryEntry | null {
  const entry = parseEntry(line)
  if (!entry || (entry.role !== 'user' && entry.role !== 'assistant')) return null
  const blocks = asHistoryBlocks(entry)
  if (blocks.length === 0) return null
  return { role: entry.role, blocks }
}

export function watchCursorSessionHistory(
  projectPath: string,
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  const filePath = getCursorSessionFilePath(projectPath, sessionId)
  if (!existsSync(filePath)) return () => {}

  let stopped = false
  let watcher: FSWatcher | null = null
  let offset = 0

  try {
    const fd = openSync(filePath, 'r')
    offset = fstatSync(fd).size
    closeSync(fd)
  } catch {
    offset = 0
  }

  const readNew = () => {
    if (stopped || !existsSync(filePath)) return
    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      return
    }

    try {
      const st = fstatSync(fd)
      if (st.size <= offset) return
      const len = st.size - offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      offset = st.size

      const text = buf.toString('utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = parseHistoryLine(trimmed)
        if (parsed && !stopped) onEntry(parsed)
      }
    } finally {
      closeSync(fd)
    }
  }

  try {
    watcher = watch(filePath, () => readNew())
  } catch {
    watcher = null
  }

  return () => {
    stopped = true
    watcher?.close()
  }
}

export function watchCursorSessions(
  projectPath: string,
  fallbackSlug: string,
  onNew: (session: CliSession) => void
): () => void {
  const transcriptsDir = getTranscriptsDir(projectPath)
  let stopped = false
  let watcher: FSWatcher | null = null
  const known = new Set<string>()

  const seedKnown = () => {
    if (!existsSync(transcriptsDir)) return
    try {
      for (const entry of readdirSync(transcriptsDir)) {
        const filePath = getCursorSessionFilePath(projectPath, entry)
        if (existsSync(filePath)) known.add(entry)
      }
    } catch {
      // ignore
    }
  }

  const emitIfReady = async (sessionId: string) => {
    if (stopped || known.has(sessionId)) return

    for (let attempt = 0; attempt < 12; attempt++) {
      const filePath = getCursorSessionFilePath(projectPath, sessionId)
      if (existsSync(filePath)) {
        known.add(sessionId)
        const sessions = await scanCursorSessions(projectPath, fallbackSlug)
        const found = sessions.find((s) => s.sessionId === sessionId)
        onNew(found ?? { sessionId, slug: fallbackSlug, lastModified: new Date() })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  const start = () => {
    if (stopped || !existsSync(transcriptsDir)) return
    seedKnown()
    try {
      watcher = watch(transcriptsDir, (_event, filename) => {
        if (!filename) return
        void emitIfReady(filename)
      })
    } catch {
      watcher = null
    }
  }

  if (existsSync(transcriptsDir)) {
    start()
  }

  const poll = setInterval(() => {
    if (stopped) {
      clearInterval(poll)
      return
    }
    if (!watcher && existsSync(transcriptsDir)) start()
  }, 500)

  return () => {
    stopped = true
    clearInterval(poll)
    watcher?.close()
  }
}

export function parseCursorThinkingBlocks(line: string): string[] {
  const entry = parseEntry(line)
  if (!entry || entry.role !== 'assistant') return []
  const content = entry.message?.content
  if (!Array.isArray(content)) return []

  return content
    .filter((b) => b && typeof b === 'object')
    .map((b) => {
      if (b.type === 'thinking' && typeof b.thinking === 'string') {
        return normalizeThinkingText(b.thinking)
      }
      if (b.type === 'reasoning' && typeof b.text === 'string') {
        return normalizeThinkingText(b.text)
      }
      return null
    })
    .filter((v): v is string => !!v)
}
