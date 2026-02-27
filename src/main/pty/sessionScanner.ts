import { existsSync, readdirSync, readFileSync, statSync, watch, FSWatcher, openSync, readSync, fstatSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface DiskSession {
  sessionId: string
  title: string // last real user message from JSONL, or 'Claude Code' fallback
  mtime: number // ms since epoch
}

/** Encode project path for use as ~/.claude/projects/<encoded>/ directory name.
 *  E:\Projects\AIDE\AIDE → E--Projects-AIDE-AIDE
 *  Replaces drive-letter+colon+separator with DriveLetter-- then remaining separators with -.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath
    .replace(/^([A-Za-z]):[/\\]/, '$1--') // E:\ → E--
    .replace(/[/\\]/g, '-') // remaining separators → -
}

export function getSessionsDir(projectPath: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectPath(projectPath))
}

/** Read the last real user message from a session's JSONL file.
 *  Skips meta entries, slash-commands, and tool-result wrappers.
 *  Returns truncated text or empty string if none found.
 */
function readLastUserMessage(sessionsDir: string, sessionId: string): string {
  const filePath = join(sessionsDir, `${sessionId}.jsonl`)
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim())
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
        if (
          text &&
          !text.startsWith('<command') &&
          !text.startsWith('<local-command') &&
          !text.startsWith('<tool')
        ) {
          return text.slice(0, 80)
        }
      } catch {}
    }
  } catch {}
  return ''
}

/** Scan ~/.claude/projects/<encoded>/ for session JSONL files, sorted by mtime (newest first). */
export async function scanSessions(projectPath: string): Promise<DiskSession[]> {
  const sessionsDir = getSessionsDir(projectPath)
  if (!existsSync(sessionsDir)) return []

  try {
    const entries = readdirSync(sessionsDir)
    const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'))

    const sessions: DiskSession[] = []
    for (const filename of jsonlFiles) {
      const sessionId = filename.slice(0, -6) // remove .jsonl (6 chars)
      const fullPath = join(sessionsDir, filename)
      let mtime = 0
      try {
        mtime = statSync(fullPath).mtimeMs
      } catch {}
      const msg = readLastUserMessage(sessionsDir, sessionId)
      // Skip empty/dead sessions with no real user messages
      if (!msg) continue
      sessions.push({ sessionId, title: msg, mtime })
    }

    sessions.sort((a, b) => b.mtime - a.mtime)
    return sessions
  } catch {
    return []
  }
}

export interface PreviewMessage {
  role: 'user' | 'assistant'
  text: string
}

/** Read the last few conversation messages from a session JSONL for preview.
 *  Reads ~5 KB from the end of the file as a starting window.
 *  If the earliest message in that window is cut off, expands backwards
 *  until the full message boundary is found.
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

    const INITIAL_CHUNK = 5120 // 5 KB
    let startOffset = Math.max(0, fileSize - INITIAL_CHUNK)

    // Read from startOffset to end
    const readTail = (offset: number): string => {
      const len = fileSize - offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      return buf.toString('utf-8')
    }

    let raw = readTail(startOffset)

    // Split into lines, drop first (likely partial) line if we didn't start at 0
    let lines = raw.split('\n').filter((l) => l.trim())
    if (startOffset > 0) {
      lines.shift() // remove partial first line
    }

    // Parse lines into messages, collecting user/assistant text
    const parseLines = (lns: string[]): PreviewMessage[] => {
      const msgs: PreviewMessage[] = []
      for (const line of lns) {
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
          // Skip tool/command wrappers
          if (text.startsWith('<command') || text.startsWith('<local-command') || text.startsWith('<tool')) continue

          msgs.push({ role: obj.type as 'user' | 'assistant', text })
        } catch {
          // skip unparseable lines
        }
      }
      return msgs
    }

    let messages = parseLines(lines)

    // If we started mid-file and got messages, check if the first message
    // might be from a partial line we discarded. Expand backwards to ensure
    // we capture the full earliest message boundary.
    if (startOffset > 0 && messages.length > 0) {
      // Expand backwards in 4 KB steps until we find a complete message boundary
      // (i.e., the line count doesn't change for the first message)
      const firstMsgText = messages[0].text
      let expandAttempts = 0
      while (startOffset > 0 && expandAttempts < 5) {
        const prevOffset = startOffset
        startOffset = Math.max(0, startOffset - 4096)
        raw = readTail(startOffset)
        lines = raw.split('\n').filter((l) => l.trim())
        if (startOffset > 0) lines.shift()
        const expanded = parseLines(lines)
        if (expanded.length === 0) break
        // If the first message text changed, it was indeed cut off — keep expanding
        if (expanded[0].text === firstMsgText) {
          messages = expanded
          break
        }
        messages = expanded
        expandAttempts++
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
