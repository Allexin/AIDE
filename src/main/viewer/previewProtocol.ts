import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { randomBytes } from 'crypto'
import { logEvent } from '../diagnostics'
import { contentType, isHtml, pageCsp, parseRange, resolvePreviewPath } from './previewFiles'

/**
 * `aide-preview://<token>/<project-relative path>`: project files for pages and documents
 * shown in the viewer (docs/file-viewer-spec.md, "HTML pages"). A token names one open
 * project, so a page can load files of its project and nothing else on disk. Each project
 * has two tokens: pages under the offline one get no network; the network one is only
 * handed to a page when the user allows it, so a page cannot switch the network on itself.
 */

export const PREVIEW_SCHEME = 'aide-preview'

interface Root {
  projectPath: string
  network: boolean
}

const roots = new Map<string, Root>()
const servedObservers: Array<(projectPath: string, absolute: string) => void> = []

/** Before app ready: a standard, secure scheme that fetch, CORS and media streaming work with. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }])
}

export interface PreviewTokens {
  offline: string
  network: string
}

export function registerPreviewRoot(projectPath: string): PreviewTokens {
  const offline = randomBytes(16).toString('hex')
  const network = randomBytes(16).toString('hex')
  roots.set(offline, { projectPath, network: false })
  roots.set(network, { projectPath, network: true })
  return { offline, network }
}

export function revokePreviewRoot(tokens: PreviewTokens): void {
  roots.delete(tokens.offline)
  roots.delete(tokens.network)
}

/** Every file the protocol serves: the viewer reloads a page when a file it loaded changes. */
export function addPreviewServedObserver(observer: (projectPath: string, absolute: string) => void): void {
  servedObservers.push(observer)
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

function serve(request: Request): Response {
  const url = new URL(request.url)
  const root = roots.get(url.hostname)
  if (!root) return plain(404, 'Not found')
  const resolved = resolvePreviewPath(root.projectPath, url.pathname)
  if (!resolved.ok) {
    if (resolved.status === 403) logEvent('preview-denied', { path: url.pathname }, 'warn')
    return plain(resolved.status, resolved.status === 403 ? 'Forbidden' : 'Not found')
  }
  for (const observer of servedObservers) {
    try { observer(root.projectPath, resolved.absolute) } catch { /* an observer never breaks serving */ }
  }

  const size = statSync(resolved.absolute).size
  const headers: Record<string, string> = {
    'Content-Type': contentType(resolved.absolute),
    // Pages have an opaque origin (sandboxed iframe): module scripts and fetch are cross-origin.
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    // Always the file as it is on disk now: the viewer reloads pages on changes.
    'Cache-Control': 'no-store'
  }
  if (isHtml(resolved.absolute)) headers['Content-Security-Policy'] = pageCsp(root.network)

  const range = parseRange(request.headers.get('range'), size)
  if (range === 'bad') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  if (range) {
    const body = Readable.toWeb(createReadStream(resolved.absolute, { start: range.start, end: range.end })) as ReadableStream
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) }
    })
  }
  const body = size === 0 ? null : (Readable.toWeb(createReadStream(resolved.absolute)) as ReadableStream)
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}

/** The handler; once, when the app is ready. */
export function installPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      return serve(request)
    } catch (err) {
      logEvent('preview-serve-failed', { url: request.url, message: err instanceof Error ? err.message : String(err) }, 'warn')
      return plain(500, 'Cannot read the file')
    }
  })
}

/** Base URL of a project's files: `aide-preview://<token>/`. */
export function previewBase(token: string): string {
  return `${PREVIEW_SCHEME}://${token}/`
}

/** URL of a project-relative path under a token, each segment escaped. */
export function previewUrl(token: string, relPath: string): string {
  return previewBase(token) + relPath.split('/').map(encodeURIComponent).join('/')
}
