import http from 'http'
import { randomBytes } from 'crypto'
import { logEvent } from '../diagnostics'

/** A single binding fact reported by a Claude Code hook. */
export interface HookBinding {
  tabId: string
  event: string
  sessionId: string | null
  transcriptPath: string | null
}

/**
 * App-wide localhost HTTP receiver for Claude Code hook callbacks.
 *
 * Each PTY tab launches `claude` with a per-tab settings file whose hooks POST to
 * `http://127.0.0.1:<port>/hook?tab=<tabId>&event=<name>&token=<token>` with the
 * raw hook payload (JSON) as the body. This gives AIDE an authoritative
 * `tabId -> transcript_path` binding on every lifecycle event, replacing the
 * PowerShell process-tree heuristic.
 *
 * Deliberately independent of the optional remote feature (that server is gated
 * by `remote.enabled`); binding must work regardless.
 */
class HookServer {
  private server: http.Server | null = null
  private port = 0
  private token = ''
  private readonly handlers = new Map<string, (b: HookBinding) => void>()

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomBytes(16).toString('hex')
    this.server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      const srv = this.server!
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        this.port = (srv.address() as { port: number }).port
        srv.removeListener('error', reject)
        // The listen-time handler above is removed on success, which would leave
        // the server with no `'error'` listener for the rest of the app's life.
        // An `'error'` event on an EventEmitter with no listener is thrown, and
        // in the main process that kills every window at once. Keep a permanent
        // handler so a socket-level failure degrades hook binding instead.
        srv.on('error', (err: NodeJS.ErrnoException) => {
          logEvent('hook-server-error', { code: err?.code ?? null, message: err?.message ?? String(err) }, 'warn')
        })
        // Malformed or aborted client connections arrive here; Node's default
        // handler destroys the socket, but we want it visible in diagnostics.
        srv.on('clientError', (err: NodeJS.ErrnoException, socket) => {
          logEvent('hook-server-client-error', { code: err?.code ?? null, message: err?.message ?? String(err) }, 'warn')
          socket.destroy()
        })
        resolve()
      })
    })
  }

  getPort(): number {
    return this.port
  }

  getToken(): string {
    return this.token
  }

  /** Register a per-tab handler. Called by PtyManager when a tab is spawned. */
  register(tabId: string, handler: (b: HookBinding) => void): void {
    this.handlers.set(tabId, handler)
  }

  /** Remove a tab handler. Called when a tab closes. */
  unregister(tabId: string): void {
    this.handlers.delete(tabId)
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.handlers.clear()
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const url = new URL(req.url ?? '', 'http://127.0.0.1')
    if (url.pathname !== '/hook') {
      res.statusCode = 404
      res.end()
      return
    }

    const tabId = url.searchParams.get('tab') ?? ''
    const event = url.searchParams.get('event') ?? ''
    const token = url.searchParams.get('token') ?? ''

    let body = ''
    let aborted = false
    req.on('data', (c) => {
      body += c
      if (body.length > 1_000_000) {
        aborted = true
        req.destroy()
      }
    })
    req.on('error', () => {
      try {
        res.end()
      } catch {}
    })
    req.on('end', () => {
      // Respond immediately so the hook (and thus the turn) is never blocked.
      res.statusCode = 200
      res.end('ok')
      if (aborted || token !== this.token) return
      const handler = this.handlers.get(tabId)
      if (!handler) return

      let sessionId: string | null = null
      let transcriptPath: string | null = null
      try {
        const payload = JSON.parse(body)
        sessionId = typeof payload.session_id === 'string' ? payload.session_id : null
        transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null
      } catch {
        // Malformed payload — still fire with what we have (query params).
      }
      handler({ tabId, event, sessionId, transcriptPath })
    })
  }
}

let instance: HookServer | null = null

/** Start (idempotent) the app-wide hook server. Resolves once it is listening. */
export async function startHookServer(): Promise<HookServer> {
  if (!instance) {
    instance = new HookServer()
    await instance.start()
  }
  return instance
}

/** Returns the running hook server, or null if it has not been started. */
export function getHookServer(): HookServer | null {
  return instance
}
