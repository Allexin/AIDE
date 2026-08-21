import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Persistent cache of per-transcript metadata.
 *
 * Answering "which sessions belong to this project?" means knowing each
 * transcript's session id and working directory. Those live in the file's first
 * record and never change afterwards, but finding them still costs a read per
 * file — and Codex keeps every session for every project in one flat directory
 * (277 files on this machine, and each `/compact` adds another).
 *
 * Caching in memory only helps within a single run. Persisting means a cold
 * start examines just the files it has never seen: everything else is answered
 * by a `stat`.
 *
 * Entries are keyed by absolute path and validated against mtime and size, so a
 * rewritten file is re-read rather than trusted.
 */

interface CacheEntry {
  mtimeMs: number
  size: number
  data: Record<string, string>
}

/** namespace -> filePath -> entry. The namespace keeps tools from colliding. */
type CacheShape = Record<string, Record<string, CacheEntry>>

const PERSIST_DEBOUNCE_MS = 2000

let cache: CacheShape | null = null
let cachePath = ''
let dirty = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

function resolvePath(): string {
  if (!cachePath) {
    cachePath = join(app.getPath('userData'), 'session-meta-cache.json')
  }
  return cachePath
}

function load(): CacheShape {
  if (cache) return cache
  const path = resolvePath()
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        cache = parsed as CacheShape
        return cache
      }
    }
  } catch {
    // A corrupt cache is not worth failing over — start clean.
  }
  cache = {}
  return cache
}

function schedulePersist(): void {
  dirty = true
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    flush()
  }, PERSIST_DEBOUNCE_MS)
  persistTimer.unref?.()
}

/** Write the cache out now. Safe to call at any time. */
export function flush(): void {
  if (!dirty || !cache) return
  dirty = false
  const path = resolvePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Write via a temp file so a crash mid-write cannot leave a truncated cache.
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(cache), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // Losing the cache costs a slow scan, nothing more.
  }
}

/**
 * Look up metadata for a file. Returns null when the file has never been seen
 * or has changed since it was recorded.
 */
export function getCachedMeta(
  namespace: string,
  filePath: string,
  mtimeMs: number,
  size: number
): Record<string, string> | null {
  const entry = load()[namespace]?.[filePath]
  if (!entry) return null
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) return null
  return entry.data
}

export function setCachedMeta(
  namespace: string,
  filePath: string,
  mtimeMs: number,
  size: number,
  data: Record<string, string>
): void {
  const root = load()
  if (!root[namespace]) root[namespace] = {}
  root[namespace][filePath] = { mtimeMs, size, data }
  schedulePersist()
}

/**
 * Drop entries for files that no longer exist.
 *
 * `scopePrefix` bounds what the caller is claiming to have enumerated. A tool
 * that keeps every session in one global directory scans all of it and can pass
 * no prefix; a tool with a directory per project has only enumerated that
 * project, and pruning without a scope would delete every other project's
 * entries. Getting this wrong is silent — it just makes the cache useless.
 */
export function pruneCache(namespace: string, livePaths: Set<string>, scopePrefix?: string): void {
  const root = load()
  const ns = root[namespace]
  if (!ns) return
  const prefix = scopePrefix ? normalize(scopePrefix) : null
  let removed = 0
  for (const path of Object.keys(ns)) {
    if (prefix && !normalize(path).startsWith(prefix)) continue
    if (!livePaths.has(path)) {
      delete ns[path]
      removed += 1
    }
  }
  if (removed > 0) schedulePersist()
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}
