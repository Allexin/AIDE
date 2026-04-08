import { openSync, fstatSync, readSync, closeSync, watch, existsSync } from 'fs'
import type { FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import type { HistoryBlock, HistoryEntry } from './types'

// ── Qwen JSONL record shapes ──────────────────────────────────────────────────

interface QwenPart {
  text?: string
  thought?: boolean
  functionCall?: {
    id: string
    name: string
    args: Record<string, unknown>
  }
  functionResponse?: {
    id: string
    name: string
    response?: { output?: string }
  }
}

interface QwenRecord {
  type: 'user' | 'assistant' | 'tool_result' | 'system'
  message?: {
    role?: string
    parts?: QwenPart[]
  }
}

// ── Block parsers ─────────────────────────────────────────────────────────────

function parseAssistantParts(parts: QwenPart[]): HistoryBlock[] {
  const blocks: HistoryBlock[] = []
  for (const part of parts) {
    if (part.thought && typeof part.text === 'string' && part.text.trim()) {
      blocks.push({ type: 'thinking', thinking: part.text })
    } else if (!part.thought && typeof part.text === 'string' && part.text.trim()) {
      blocks.push({ type: 'text', text: part.text })
    } else if (part.functionCall) {
      blocks.push({
        type: 'tool_use',
        id: part.functionCall.id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {}
      })
    }
  }
  return blocks
}

function parseUserParts(parts: QwenPart[]): HistoryBlock[] {
  const blocks: HistoryBlock[] = []
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.trim()) {
      blocks.push({ type: 'text', text: part.text })
    }
  }
  return blocks
}

function parseToolResultParts(parts: QwenPart[]): HistoryBlock[] {
  const blocks: HistoryBlock[] = []
  for (const part of parts) {
    if (part.functionResponse) {
      const output = part.functionResponse.response?.output ?? ''
      blocks.push({
        type: 'tool_result',
        tool_use_id: part.functionResponse.id,
        content: output
      })
    }
  }
  return blocks
}

// ── Public parser ─────────────────────────────────────────────────────────────

/** Parse a single Qwen JSONL line into a HistoryEntry, or null if it should be skipped. */
export function parseQwenHistoryLine(line: string): HistoryEntry | null {
  let obj: QwenRecord
  try {
    obj = JSON.parse(line) as QwenRecord
  } catch {
    return null
  }

  const parts = obj.message?.parts ?? []

  if (obj.type === 'assistant') {
    const blocks = parseAssistantParts(parts)
    if (blocks.length === 0) return null
    return { role: 'assistant', blocks }
  }

  if (obj.type === 'user') {
    const blocks = parseUserParts(parts)
    if (blocks.length === 0) return null
    return { role: 'user', blocks }
  }

  if (obj.type === 'tool_result') {
    const blocks = parseToolResultParts(parts)
    if (blocks.length === 0) return null
    return { role: 'user', blocks }
  }

  return null
}

// ── File readers ──────────────────────────────────────────────────────────────

/** Read the full conversation history from a Qwen session JSONL file. */
export async function readQwenSessionHistory(filePath: string): Promise<HistoryEntry[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  const entries: HistoryEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = parseQwenHistoryLine(trimmed)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Watch a Qwen session JSONL file for new entries.
 *  Calls `onEntry` for each new HistoryEntry appended to the file.
 *  Returns a cleanup function.
 */
export function watchQwenSessionFile(
  filePath: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  let stopped = false
  let watcher: FSWatcher | null = null

  // Track current file size so we only read new content
  let offset = 0
  if (existsSync(filePath)) {
    try {
      const fd = openSync(filePath, 'r')
      offset = fstatSync(fd).size
      closeSync(fd)
    } catch { /* ignore */ }
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
      const stat = fstatSync(fd)
      if (stat.size <= offset) return

      const len = stat.size - offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      offset = stat.size

      const text = buf.toString('utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry = parseQwenHistoryLine(trimmed)
        if (entry && !stopped) onEntry(entry)
      }
    } finally {
      closeSync(fd)
    }
  }

  try {
    watcher = watch(filePath, () => readNewEntries())
  } catch { /* ignore */ }

  return () => {
    stopped = true
    watcher?.close()
  }
}
