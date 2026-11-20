import { extname, isAbsolute, relative, resolve, sep } from 'path'
import { resolveProjectFile } from './viewerFiles'

/**
 * The pure part of the `aide-preview://` protocol (docs/file-viewer-spec.md, "HTML pages"):
 * URL path → project file, content types, byte ranges, the CSP of pages.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.vtt': 'text/vtt; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf'
}

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function isHtml(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return ext === '.html' || ext === '.htm'
}

/**
 * Pages run offline unless the user allows the network for the page: inline and eval'd
 * scripts are fine (generated pages use them), anything outside the project is not.
 */
export function pageCsp(network: boolean): string {
  const sources = `aide-preview: data: blob: 'unsafe-inline' 'unsafe-eval'${network ? ' https: wss:' : ''}`
  return `default-src ${sources}; form-action 'none'`
}

export type Resolved =
  | { ok: true; absolute: string; relPath: string }
  | { ok: false; status: 403 | 404; reason: string }

/**
 * The project file a URL path names. The URL parser already folds `..` and `%2e%2e`; the
 * real-path containment of resolveProjectFile refuses absolute paths, UNC paths, and links
 * or junctions that point out of the project.
 */
export function resolvePreviewPath(projectPath: string, urlPath: string): Resolved {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return { ok: false, status: 404, reason: 'bad escape' }
  }
  if (decoded.includes('\0')) return { ok: false, status: 404, reason: 'NUL in path' }
  const rel = decoded.replace(/^\/+/, '')
  if (!rel) return { ok: false, status: 404, reason: 'no path' }
  // Lexically first: a UNC or absolute path must not reach the disk (or the network) at all.
  const fold = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x)
  const lexical = relative(fold(resolve(projectPath)), fold(resolve(projectPath, rel)))
  if (lexical === '' || isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${sep}`)) {
    return { ok: false, status: 403, reason: 'outside the project' }
  }
  try {
    const { absolute, relPath } = resolveProjectFile(projectPath, rel)
    return { ok: true, absolute, relPath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return /outside the project/.test(message)
      ? { ok: false, status: 403, reason: message }
      : { ok: false, status: 404, reason: message }
  }
}

/** A `Range: bytes=…` header against a file size: the inclusive span, 'bad' when unsatisfiable, null when absent. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'bad' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix: the last N bytes.
    const n = Number(m[2])
    if (n === 0) return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'bad'
  return { start, end }
}
