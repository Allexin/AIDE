import { existsSync, readdirSync, readFileSync, statSync, watch, FSWatcher } from 'fs'
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

    const sessions: DiskSession[] = jsonlFiles.map((filename) => {
      const sessionId = filename.slice(0, -6) // remove .jsonl (6 chars)
      const fullPath = join(sessionsDir, filename)
      let mtime = 0
      try {
        mtime = statSync(fullPath).mtimeMs
      } catch {}
      const msg = readLastUserMessage(sessionsDir, sessionId)
      return { sessionId, title: msg || 'Claude Code', mtime }
    })

    sessions.sort((a, b) => b.mtime - a.mtime)
    return sessions
  } catch {
    return []
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
