import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'fs'
import type { FSWatcher } from 'fs'
import { readFile, stat as fsStat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { HistoryBlock, HistoryEntry } from './types'

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

async function readCodexDiskSession(filePath: string, projectPath: string): Promise<CodexDiskSession | null> {
  let content = ''
  let mtime = 0
  try {
    const [fileStat, fileContent] = await Promise.all([
      fsStat(filePath),
      readFile(filePath, 'utf-8')
    ])
    mtime = fileStat.mtimeMs
    content = fileContent
  } catch {
    return null
  }

  const lines = content.split('\n').filter((line) => line.trim())
  const meta = parseSessionMetadata(lines, filePath)
  if (!meta || !isSameProject(projectPath, meta.cwd)) return null
  const { firstMessage, title } = extractFirstAndLastUserMessage(lines)

  return {
    sessionId: meta.sessionId,
    filePath,
    cwd: meta.cwd,
    firstMessage,
    title,
    mtime
  }
}

export async function scanCodexSessions(projectPath: string): Promise<CodexDiskSession[]> {
  const files = collectJsonlFiles(getCodexSessionsRoot())
  const sessions = await Promise.all(files.map((file) => readCodexDiskSession(file, projectPath)))
  return sessions
    .filter((session): session is CodexDiskSession => session !== null)
    .sort((a, b) => b.mtime - a.mtime)
}

export async function findCodexSessionFile(projectPath: string, sessionId: string): Promise<string | null> {
  const sessions = await scanCodexSessions(projectPath)
  return sessions.find((session) => session.sessionId === sessionId)?.filePath ?? null
}

export function findCodexSessionFileSync(projectPath: string, sessionId: string): string | null {
  for (const filePath of collectJsonlFiles(getCodexSessionsRoot())) {
    let content = ''
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split('\n').filter((line) => line.trim())
    const meta = parseSessionMetadata(lines, filePath)
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
