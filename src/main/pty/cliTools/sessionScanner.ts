import { existsSync, readdirSync, watch, FSWatcher, openSync, readSync, fstatSync, closeSync } from 'fs'
import { stat as fsStat, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export interface DiskSession {
  sessionId: string
  summary: string // CC-generated session title (from type:"summary" entry), or empty
  title: string   // last real user message from JSONL, or empty
  mtime: number   // ms since epoch
}

/** Encode project path for use as ~/.claude/projects/<encoded>/ directory name.
 *  E:\Projects\AIDE\AIDE → E--Projects-AIDE-AIDE
 *  Replaces drive-letter+colon+separator with DriveLetter-- then remaining separators with -.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath
    .replace(/^([A-Za-z]):[/\\]/, '$1--') // E:\ → E--
    .replace(/[^A-Za-z0-9-]/g, '-') // any non-alphanumeric char (spaces, underscores, etc.) → -
}

export function getSessionsDir(projectPath: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectPath(projectPath))
}

/** Extract the user-defined title from parsed JSONL lines (type:"custom-title" entry). */
function extractSummary(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i])
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
        return obj.customTitle.trim().slice(0, 100)
      }
    } catch {}
  }
  return ''
}

/** Extract the last real user message from parsed JSONL lines. */
function extractLastUserMessage(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i])
      if (obj.type !== 'user' || obj.isMeta) continue
      const raw = obj?.message?.content
      let text = ''
      if (typeof raw === 'string') {
        text = raw
      } else if (Array.isArray(raw)) {
        text = raw
          .filter((b: unknown) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
          .map((b: unknown) => (b as { text: string }).text)
          .join(' ')
      }
      text = text.trim()
      if (text && !text.startsWith('<command') && !text.startsWith('<local-command') && !text.startsWith('<tool')) {
        return text.slice(0, 80)
      }
    } catch {}
  }
  return ''
}

/** Scan ~/.claude/projects/<encoded>/ for session JSONL files, sorted by mtime (newest first).
 *  All file I/O is async and parallelised across sessions.
 */
export async function scanSessions(projectPath: string): Promise<DiskSession[]> {
  const sessionsDir = getSessionsDir(projectPath)
  if (!existsSync(sessionsDir)) return []

  let jsonlFiles: string[]
  try {
    jsonlFiles = readdirSync(sessionsDir).filter((e) => e.endsWith('.jsonl'))
  } catch {
    return []
  }

  const sessions = await Promise.all(
    jsonlFiles.map(async (filename) => {
      const sessionId = filename.slice(0, -6)
      const fullPath = join(sessionsDir, filename)
      let mtime = 0
      let summary = ''
      let title = ''
      try {
        const [fileStat, content] = await Promise.all([
          fsStat(fullPath),
          readFile(fullPath, 'utf-8')
        ])
        mtime = fileStat.mtimeMs
        const lines = content.split('\n').filter((l) => l.trim())
        summary = extractSummary(lines)
        title = extractLastUserMessage(lines)
      } catch {}
      return { sessionId, summary, title, mtime }
    })
  )

  sessions.sort((a, b) => b.mtime - a.mtime)
  return sessions
}

export interface PreviewMessage {
  role: 'user' | 'assistant'
  text: string
}

/** Read the last few conversation messages from a session JSONL for preview.
 *  Reads up to 64 KB from the end of the file to collect text messages.
 *  Skips tool_use/tool_result-only entries and meta lines.
 */
export function readSessionPreview(sessionsDir: string, sessionId: string): PreviewMessage[] {
  const filePath = join(sessionsDir, `${sessionId}.jsonl`)
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }

  try {
    const fileSize = fstatSync(fd).size
    if (fileSize === 0) return []

    // Read up to 64 KB from the end; enough to capture several real messages
    // even if the tail is dominated by tool_use/tool_result entries.
    const MAX_CHUNK = Math.min(fileSize, 65536)
    const startOffset = fileSize - MAX_CHUNK
    const buf = Buffer.alloc(MAX_CHUNK)
    readSync(fd, buf, 0, MAX_CHUNK, startOffset)
    const raw = buf.toString('utf-8')

    const lines = raw.split('\n').filter((l) => l.trim())
    // Drop first line if we started mid-file (likely partial)
    if (startOffset > 0) lines.shift()

    const messages: PreviewMessage[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'user' && obj.type !== 'assistant') continue
        if (obj.isMeta) continue

        const rawContent = obj?.message?.content
        let text = ''
        if (typeof rawContent === 'string') {
          text = rawContent
        } else if (Array.isArray(rawContent)) {
          text = rawContent
            .filter((b: unknown) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
            .map((b: unknown) => (b as { text: string }).text)
            .join('\n')
        }
        text = text.trim()
        if (!text) continue
        if (text.startsWith('<command') || text.startsWith('<local-command') || text.startsWith('<tool')) continue

        messages.push({ role: obj.type as 'user' | 'assistant', text })
      } catch {
        // skip unparseable lines
      }
    }
    return messages
  } finally {
    closeSync(fd)
  }
}

/** Watch a directory for new .jsonl files.
 *  Calls onNewFile(sessionId) when a new .jsonl appears.
 *  Returns a cleanup function.
 */
export function watchSessionsDir(
  sessionsDir: string,
  onNewFile: (sessionId: string) => void
): () => void {
  let stopped = false
  let watcher: FSWatcher | null = null
  const knownFiles = new Set<string>()

  const startWatcher = () => {
    if (stopped || !existsSync(sessionsDir)) return
    try {
      // Snapshot existing files so we only report genuinely new ones
      readdirSync(sessionsDir)
        .filter((e) => e.endsWith('.jsonl'))
        .forEach((f) => knownFiles.add(f))

      watcher = watch(sessionsDir, (_event, filename) => {
        if (stopped || !filename || !filename.endsWith('.jsonl')) return
        if (!knownFiles.has(filename)) {
          knownFiles.add(filename)
          const sessionId = filename.slice(0, -6) // remove .jsonl (6 chars)
          // Small delay to let claude write the initial data
          setTimeout(() => {
            if (!stopped) onNewFile(sessionId)
          }, 300)
        }
      })
    } catch {}
  }

  if (existsSync(sessionsDir)) {
    startWatcher()
    return () => {
      stopped = true
      watcher?.close()
    }
  }

  // Directory doesn't exist yet (first time running claude for this project).
  // Poll until it appears.
  const interval = setInterval(() => {
    if (stopped) {
      clearInterval(interval)
      return
    }
    if (existsSync(sessionsDir)) {
      clearInterval(interval)
      startWatcher()
    }
  }, 500)

  return () => {
    stopped = true
    clearInterval(interval)
    watcher?.close()
  }
}
