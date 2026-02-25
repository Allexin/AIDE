import { existsSync, readdirSync, readFileSync, statSync, watch, FSWatcher } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface DiskSession {
  sessionId: string
  slug: string | null
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

/** Read the slug from a JSONL file by scanning for the first line with a "slug" field. */
export function readSlugFromJsonl(jsonlPath: string): string | null {
  try {
    const content = readFileSync(jsonlPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed)
        if (obj && typeof obj.slug === 'string' && obj.slug) return obj.slug
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File not readable
  }
  return null
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
      return { sessionId, slug: readSlugFromJsonl(fullPath), mtime }
    })

    sessions.sort((a, b) => b.mtime - a.mtime)
    return sessions
  } catch {
    return []
  }
}

/** Watch a directory for new .jsonl files.
 *  Calls onNewFile(sessionId, slug | null) when a new .jsonl appears.
 *  Returns a cleanup function.
 */
export function watchSessionsDir(
  sessionsDir: string,
  onNewFile: (sessionId: string, slug: string | null) => void
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
          const fullPath = join(sessionsDir, filename)
          // Small delay to let claude write the initial data
          setTimeout(() => {
            if (!stopped) onNewFile(sessionId, readSlugFromJsonl(fullPath))
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

/** Watch a specific .jsonl file for changes and call onSlugFound when a slug appears.
 *  Stops watching automatically once slug is found.
 *  Returns a cleanup function.
 */
export function watchJsonlFile(
  jsonlPath: string,
  onSlugFound: (slug: string) => void
): () => void {
  let stopped = false
  let watcher: FSWatcher | null = null

  const check = (): boolean => {
    const slug = readSlugFromJsonl(jsonlPath)
    if (slug) {
      onSlugFound(slug)
      return true
    }
    return false
  }

  // Check immediately
  if (check()) return () => {}

  if (!existsSync(jsonlPath)) {
    // File doesn't exist yet — poll until it does
    const interval = setInterval(() => {
      if (stopped) {
        clearInterval(interval)
        return
      }
      if (existsSync(jsonlPath) && check()) {
        stopped = true
        clearInterval(interval)
      }
    }, 1000)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }

  try {
    watcher = watch(jsonlPath, () => {
      if (stopped) return
      if (check()) {
        stopped = true
        watcher?.close()
      }
    })
  } catch {}

  return () => {
    stopped = true
    watcher?.close()
  }
}
