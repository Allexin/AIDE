import http from 'http'
import { readFileSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { app, BrowserWindow } from 'electron'
import QRCode from 'qrcode'
import type { PtyManager } from '../pty/ptyManager'
import { loadOrGeneratePin, regeneratePin, validatePin } from './auth'
import { PtyBridge } from './ptyBridge'
import { getAppConfig } from '../config/appConfig'
import { getToolById } from '../pty/cliTools/registry'

const AGGREGATOR_PORT = 3847
const SESSION_TTL = 24 * 60 * 60 * 1000  // 24 hours

interface KeyboardButton {
  label: string
  send: string
}

interface KeyboardConfig {
  buttons: KeyboardButton[]
}

// Default control buttons for mobile terminal.
// Override by placing remote-keyboard.json in %APPDATA%/AIDE/ (userData dir).
// Use Unicode escapes for control chars in the JSON file, e.g. "" for Ctrl+C.
const DEFAULT_KEYBOARD_CONFIG: KeyboardConfig = {
  buttons: [
    { label: 'Ctrl+C', send: '\x03' },
    { label: 'Esc',    send: '\x1b' },
    { label: '↑',      send: '\x1b[A' },
    { label: '↓',      send: '\x1b[B' },
    { label: 'Tab',    send: '\t' },
    { label: 'Del',    send: '\x1b[3~' },
    { label: '⌫',      send: '\x7f' },
    { label: '↵',      send: '\r' },
  ]
}

interface RegistryEntry {
  port: number
  projectName: string
  pin: string
  lastSeen: number
}

function getLocalIps(): string[] {
  const ips: string[] = []
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return ips
}

export class RemoteServer {
  // Own terminal server (OS-assigned port).
  private ownServer: http.Server | null = null
  private ownWss: WebSocketServer | null = null
  private ownPort = 0

  // Aggregator server (port 3847), only set when this instance wins the port.
  private aggregatorServer: http.Server | null = null
  private aggregatorWss: WebSocketServer | null = null
  private registry = new Map<string, RegistryEntry>()
  private sessions = new Map<string, number>()   // sessionToken → expiry timestamp
  private lastUnauthNotify = 0
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  private bridge: PtyBridge
  private pin = ''
  private pinPath: string

  constructor(
    private ptyRegistry: Map<BrowserWindow, PtyManager>,
    private openProjects: Map<string, BrowserWindow>
  ) {
    this.pinPath = join(app.getPath('userData'), 'remote-pin.txt')
    this.bridge = new PtyBridge(ptyRegistry)
    this.bridge.onLockChanged = (tabId, locked) => {
      for (const win of openProjects.values()) {
        if (!win.isDestroyed()) win.webContents.send('remote:tab-lock-changed', { tabId, locked })
      }
    }
  }

  start(): void {
    if (!getAppConfig().remote.enabled) return

    this.pin = loadOrGeneratePin(this.pinPath)

    this.ownServer = http.createServer((req, res) => this.handleTerminalHttp(req, res))
    this.ownWss = new WebSocketServer({ server: this.ownServer })
    this.ownWss.on('connection', (ws) => this.handleConnection(ws))

    this.ownServer.listen(0, () => {
      this.ownPort = (this.ownServer!.address() as { port: number }).port
      this.connectToAggregator()
    })
  }

  stop(): void {
    this.stopHeartbeat()
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    if (this.aggregatorServer === null && this.ownPort > 0) {
      this.postUnregister().catch(() => {})
    }
    this.ownWss?.close()
    this.ownServer?.close()
    this.ownServer = null
    this.ownWss = null
    this.aggregatorWss?.close()
    this.aggregatorWss = null
    this.aggregatorServer?.close()
    this.aggregatorServer = null
  }

  // Always returns aggregator picker URLs — works regardless of which instance is aggregator.
  getConnectionUrls(): string[] {
    const ips = getLocalIps()
    const hosts = ips.length > 0 ? ips : ['localhost']
    return hosts.map((ip) => `http://${ip}:${AGGREGATOR_PORT}/`)
  }

  getPin(): string { return this.pin }
  // Returns own terminal server port (used by the connect BrowserWindow to load /connect).
  getPort(): number { return this.ownPort }

  forceReleaseTab(tabId: string): void {
    this.bridge.forceRelease(tabId)
  }

  private getProjectName(): string {
    const keys = [...this.openProjects.keys()]
    if (keys.length === 0) return 'AIDE'
    return basename(keys[0]) || 'AIDE'
  }

  // --- Session management ---

  private isAuthenticated(req: http.IncomingMessage): boolean {
    const cookie = req.headers.cookie ?? ''
    const match = /aide-session=([^;]+)/.exec(cookie)
    if (!match) return false
    const expiry = this.sessions.get(match[1])
    if (expiry === undefined) return false
    if (Date.now() > expiry) { this.sessions.delete(match[1]); return false }
    return true
  }

  // --- Aggregator registration ---

  private connectToAggregator(): void {
    this.stopHeartbeat()
    this.postRegister()
      .then(() => { this.startHeartbeat() })
      .catch(() => { this.tryBecomeAggregator() })
  }

  private tryBecomeAggregator(): void {
    const aggServer = http.createServer((req, res) => this.handleAggregatorHttp(req, res))
    aggServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Another instance just won the port race — wait and register with it.
        setTimeout(() => this.connectToAggregator(), 500)
      }
    })
    aggServer.listen(AGGREGATOR_PORT, () => {
      this.aggregatorServer = aggServer
      const aggWss = new WebSocketServer({ server: aggServer })
      aggWss.on('connection', (ws, req) => this.handleAggWsConnection(ws, req))
      this.aggregatorWss = aggWss
      this.registerSelf()
      this.startCleanupLoop()
    })
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.postRegister().catch(() => {
        this.stopHeartbeat()
        this.connectToAggregator()
      })
    }, 10000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private startCleanupLoop(): void {
    this.cleanupInterval = setInterval(() => {
      this.registerSelf()  // keep own entry fresh
      const now = Date.now()
      for (const [key, entry] of this.registry) {
        if (now - entry.lastSeen > 30000) this.registry.delete(key)
      }
      for (const [token, expiry] of this.sessions) {
        if (now > expiry) this.sessions.delete(token)
      }
    }, 15000)
  }

  private registerSelf(): void {
    this.registry.set(`${this.ownPort}`, {
      port: this.ownPort,
      projectName: this.getProjectName(),
      pin: this.pin,
      lastSeen: Date.now()
    })
  }

  private postRegister(): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        port: this.ownPort,
        projectName: this.getProjectName(),
        pin: this.pin
      })
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: AGGREGATOR_PORT,
          path: '/api/register',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 2000
        },
        (res) => {
          res.resume()
          if (res.statusCode === 200) resolve()
          else reject(new Error(`HTTP ${res.statusCode}`))
        }
      )
      req.on('timeout', () => { req.destroy() })
      req.on('error', reject)
      req.end(body)
    })
  }

  private postUnregister(): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ port: this.ownPort })
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: AGGREGATOR_PORT,
          path: '/api/unregister',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 2000
        },
        (res) => { res.resume(); resolve() }
      )
      req.on('timeout', () => { req.destroy() })
      req.on('error', reject)
      req.end(body)
    })
  }

  // --- Aggregator HTTP handler (port 3847) ---

  private handleAggAuth(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as { pin?: string }
        if (validatePin(String(data.pin ?? ''))) {
          const token = randomUUID()
          this.sessions.set(token, Date.now() + SESSION_TTL)
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `aide-session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
          })
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false }))
        }
      } catch {
        res.writeHead(400); res.end()
      }
    })
  }

  private notifyUnauthAccess(): void {
    for (const win of this.openProjects.values()) {
      if (!win.isDestroyed()) win.webContents.send('remote:access-without-token')
    }
  }

  private proxyToInstance(port: number, path: string, res: http.ServerResponse): void {
    const proxyReq = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', timeout: 3000 },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, {
          'Content-Type': proxyRes.headers['content-type'] ?? 'application/octet-stream'
        })
        proxyRes.pipe(res)
      }
    )
    proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end() } })
    proxyReq.on('timeout', () => { proxyReq.destroy() })
    proxyReq.end()
  }

  private handleAggregatorHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlObj = new URL(req.url ?? '/', 'http://x')
    const path = urlObj.pathname

    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return }

    // Internal-only: called by local AIDE instances via 127.0.0.1, no auth needed.
    if (path === '/api/register' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as { port: number; projectName: string; pin: string }
          this.registry.set(`${data.port}`, {
            port: data.port,
            projectName: data.projectName,
            pin: data.pin,
            lastSeen: Date.now()
          })
          res.writeHead(200); res.end()
        } catch {
          res.writeHead(400); res.end()
        }
      })
      return
    }

    if (path === '/api/unregister' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as { port: number }
          this.registry.delete(`${data.port}`)
        } catch {}
        res.writeHead(200); res.end()
      })
      return
    }

    // Auth endpoint — no session required.
    if (path === '/api/auth' && req.method === 'POST') {
      this.handleAggAuth(req, res)
      return
    }

    // PIN in URL (from QR code) → create session and redirect to picker.
    const pinParam = urlObj.searchParams.get('pin')
    if (pinParam && validatePin(pinParam)) {
      const sessionToken = randomUUID()
      this.sessions.set(sessionToken, Date.now() + SESSION_TTL)
      res.writeHead(302, {
        'Set-Cookie': `aide-session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        'Location': '/'
      })
      res.end()
      return
    }

    // Gate all other routes behind session auth.
    if (!this.isAuthenticated(req)) {
      // Notify AIDE when someone opens the page without a PIN — rate-limited to 5s.
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/') {
        const now = Date.now()
        if (now - this.lastUnauthNotify > 5000) {
          this.lastUnauthNotify = now
          this.notifyUnauthAccess()
        }
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(LOGIN_HTML)
      } else {
        res.writeHead(401); res.end()
      }
      return
    }

    // --- Authenticated routes ---

    // Project list — port and name only, PIN never leaves the server.
    if (path === '/api/projects') {
      const projects = [...this.registry.values()].map((e) => ({
        port: e.port,
        projectName: e.projectName
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(projects))
      return
    }

    // Terminal page — proxied through aggregator so only port 3847 is needed externally.
    if (path === '/terminal') {
      const port = Number(urlObj.searchParams.get('port'))
      if (!port || !this.registry.has(String(port))) {
        res.writeHead(404); res.end('Project not found'); return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(makeAggTerminalHtml(port, DEFAULT_KEYBOARD_CONFIG))
      return
    }

    // Static assets — served directly, all instances share the same xterm files.
    if (path.startsWith('/static/')) {
      this.serveStatic(path.slice(8).split('?')[0], res)
      return
    }

    // Keyboard config — proxy to the specific instance.
    if (path === '/api/keyboard-config') {
      const port = Number(urlObj.searchParams.get('port'))
      if (!port) { res.writeHead(400); res.end(); return }
      this.proxyToInstance(port, '/api/keyboard-config', res)
      return
    }

    // Usage info — proxy to the specific instance.
    if (path.startsWith('/api/usage')) {
      const port = Number(urlObj.searchParams.get('port'))
      const tab = urlObj.searchParams.get('tab') ?? ''
      if (!port) { res.writeHead(400); res.end(); return }
      this.proxyToInstance(port, `/api/usage?tab=${encodeURIComponent(tab)}`, res)
      return
    }

    // Project picker — authenticated users land here.
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PICKER_HTML)
      return
    }

    res.writeHead(404); res.end()
  }

  // --- Aggregator WebSocket proxy ---

  private handleAggWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    if (!this.isAuthenticated(req)) { ws.close(1008, 'Unauthorized'); return }

    const urlObj = new URL(req.url ?? '/', 'http://x')
    const port = Number(urlObj.searchParams.get('port'))
    if (!port || !this.registry.has(String(port))) { ws.close(1008, 'Unknown project'); return }

    const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let upstreamAuthed = false
    let clientAuthPending = false
    const clientQueue: string[] = []

    const sendToClient = (data: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
    }

    upstream.on('open', () => {
      // Authenticate with the instance transparently — client never sees the PIN.
      upstream.send(JSON.stringify({ type: 'auth', token: this.pin }))
    })

    upstream.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string }
        if (msg.type === 'auth-ok') {
          upstreamAuthed = true
          if (clientAuthPending) {
            sendToClient({ type: 'auth-ok' })
            clientAuthPending = false
          }
          for (const queued of clientQueue) upstream.send(queued)
          clientQueue.length = 0
        } else if (msg.type === 'auth-fail') {
          ws.close(1011, 'Instance auth failed')
        } else {
          if (ws.readyState === WebSocket.OPEN) ws.send(data.toString())
        }
      } catch {}
    })

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string }
        if (msg.type === 'auth') {
          // Client is already authenticated via session cookie — respond without forwarding.
          if (upstreamAuthed) sendToClient({ type: 'auth-ok' })
          else clientAuthPending = true
          return
        }
      } catch {}
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstreamAuthed) upstream.send(data)
        else clientQueue.push(data.toString())
      }
    })

    upstream.on('close', () => { if (ws.readyState !== WebSocket.CLOSED) ws.close() })
    ws.on('close', () => { if (upstream.readyState !== WebSocket.CLOSED) upstream.close() })
    upstream.on('error', () => { if (ws.readyState !== WebSocket.CLOSED) ws.close() })
    ws.on('error', () => { if (upstream.readyState !== WebSocket.CLOSED) upstream.close() })
  }

  // --- Terminal HTTP handler (own server, OS-assigned port) ---

  private serveStatic(filename: string, res: http.ServerResponse): void {
    const STATIC_FILES: Record<string, { path: string; type: string }> = {
      'xterm.js':    { path: join(app.getAppPath(), 'node_modules/@xterm/xterm/lib/xterm.js'),        type: 'application/javascript' },
      'xterm.css':   { path: join(app.getAppPath(), 'node_modules/@xterm/xterm/css/xterm.css'),        type: 'text/css' },
      'addon-fit.js':{ path: join(app.getAppPath(), 'node_modules/@xterm/addon-fit/lib/addon-fit.js'), type: 'application/javascript' },
    }
    const file = STATIC_FILES[filename]
    if (!file) { res.writeHead(404); res.end(); return }
    try {
      const content = readFileSync(file.path)
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=86400' })
      res.end(content)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }

  private getKeyboardConfig(): KeyboardConfig {
    try {
      const configPath = join(app.getPath('userData'), 'remote-keyboard.json')
      const content = readFileSync(configPath, 'utf-8')
      return JSON.parse(content) as KeyboardConfig
    } catch {
      return DEFAULT_KEYBOARD_CONFIG
    }
  }

  private handleTerminalHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/'

    if (url === '/favicon.ico') { res.writeHead(204); res.end(); return }

    if (url.startsWith('/static/')) {
      this.serveStatic(url.slice(8).split('?')[0], res)
      return
    }

    if (url === '/api/keyboard-config') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.getKeyboardConfig()))
      return
    }

    if (url === '/api/regenerate-pin' && req.method === 'POST') {
      this.pin = regeneratePin(this.pinPath)
      const urls = this.getConnectionUrls()
      Promise.all(
        urls.map((u) => QRCode.toDataURL(u, { width: 220, margin: 1, color: { dark: '#000000', light: '#ffffff' } }))
      ).then((qrDataUrls) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ urls, pin: this.pin, qrDataUrls }))
      }).catch(() => {
        res.writeHead(500)
        res.end()
      })
      return
    }

    if (url === '/connect' || url.startsWith('/connect?')) {
      const remoteHost = getAppConfig().remote.remoteHost.trim()
      const localUrls = this.getConnectionUrls()
      const baseUrls = remoteHost
        ? [...localUrls, `http://${remoteHost}/`]
        : localUrls
      // Embed PIN in QR URLs so scanning creates a session automatically.
      const allUrls = baseUrls.map((u) => `${u}?pin=${encodeURIComponent(this.pin)}`)
      Promise.all(
        allUrls.map((u) => QRCode.toDataURL(u, { width: 220, margin: 1, color: { dark: '#000000', light: '#ffffff' } }))
      ).then((qrDataUrls) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(makeConnectHtml(allUrls, this.pin, qrDataUrls, remoteHost))
      }).catch(() => {
        res.writeHead(500)
        res.end('QR generation failed')
      })
      return
    }

    if (url.startsWith('/api/usage')) {
      const tabId = new URL(url, 'http://x').searchParams.get('tab') ?? ''
      const tabs = this.bridge.getAllTabs()
      const tab = tabs.find((t) => t.tabId === tabId) ?? tabs.find((t) => t.locked) ?? tabs[0]
      if (!tab) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ summary: null }))
        return
      }
      const tool = getToolById(tab.toolId)
      Promise.resolve(tool?.getUsageInfo?.() ?? null).then((info) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(info ? { summary: info.summary, tooltip: info.tooltip, level: info.level } : { summary: null }))
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ summary: null }))
      })
      return
    }

    if (url === '/' || url.startsWith('/?') || url === '/terminal' || url.startsWith('/terminal?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(TERMINAL_HTML)
      return
    }

    res.writeHead(404)
    res.end()
  }

  // --- WebSocket handler (own instance server) ---

  private handleConnection(ws: WebSocket): void {
    let authenticated = false
    let activeTabId: string | null = null

    const send = (data: object): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        if (!authenticated) {
          if (msg.type === 'auth' && validatePin(String(msg.token ?? ''))) {
            authenticated = true
            send({ type: 'auth-ok' })
          } else {
            send({ type: 'auth-fail' })
            ws.close()
          }
          return
        }

        switch (msg.type) {
          case 'list-tabs':
            send({ type: 'tabs', tabs: this.bridge.getAllTabs() })
            break
          case 'take-tab': {
            const tabId = String(msg.tabId ?? '')
            const cols = Number(msg.cols ?? 80)
            const rows = Number(msg.rows ?? 24)
            const ok = this.bridge.takeTab(ws, tabId, cols, rows)
            if (ok) { activeTabId = tabId } else { send({ type: 'error', message: 'Tab unavailable' }) }
            break
          }
          case 'input':
            this.bridge.writeToTab(ws, String(msg.tabId ?? activeTabId ?? ''), String(msg.data ?? ''))
            break
          case 'resize':
            this.bridge.resizeTab(ws, String(msg.tabId ?? activeTabId ?? ''), Number(msg.cols), Number(msg.rows))
            break
          case 'release-tab':
            this.bridge.releaseTab(ws, String(msg.tabId ?? ''))
            if (activeTabId === msg.tabId) activeTabId = null
            break
        }
      } catch {}
    })

    ws.on('close', () => {
      this.bridge.releaseAll(ws)
    })
  }
}

// --- HTML templates ---

function makeConnectHtml(urls: string[], pin: string, qrDataUrls: string[], remoteHost: string): string {
  const data = JSON.stringify({ urls, pin, qrDataUrls }).replace(/<\/script>/gi, '<\\/script>')
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Remote Connect</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1e1e1e; color: #d4d4d4;
      display: flex; flex-direction: column; align-items: center;
      padding: 20px 16px; gap: 14px;
    }
    h3 { font-size: 13px; font-weight: 400; color: #858585; }
    #qr-wrap { background: #fff; border-radius: 8px; padding: 10px; line-height: 0; }
    .pin { font-size: 26px; letter-spacing: 8px; color: #4fc3f7; font-weight: 300; }
    .url-item {
      font-family: monospace; font-size: 11px; color: #858585;
      background: #2d2d2d; border: 1px solid #3d3d3d; border-radius: 4px;
      padding: 6px 10px; word-break: break-all; cursor: pointer;
      width: 100%; text-align: left; transition: border-color .15s;
    }
    .url-item.active { border-color: #4fc3f7; color: #ccc; }
    .url-item:hover { border-color: #666; }
    .hint { font-size: 11px; color: #555; }
    .urls { display: flex; flex-direction: column; gap: 6px; width: 100%; }
    .regen-btn {
      font-size: 11px; color: #858585; background: none; border: 1px solid #3d3d3d;
      border-radius: 4px; padding: 5px 12px; cursor: pointer; transition: border-color .15s;
    }
    .regen-btn:hover { border-color: #666; color: #ccc; }
    .regen-btn:disabled { opacity: .4; cursor: default; }
    .no-host { font-size: 11px; color: #4fc3f7; cursor: pointer; text-decoration: underline; text-align: center; }
    .no-host:hover { color: #81d4fa; }
  </style>
</head>
<body>
  <h3>Scan QR to open the project picker:</h3>
  <div id="qr-wrap"><img id="qr-img" alt="QR code" style="display:block;width:220px;height:220px;"></div>
  <div class="pin" id="pin-el"></div>
  <div class="urls" id="url-list"></div>
  <div class="hint">Scan QR &#8594; pick project &#8594; terminal opens in browser</div>
  ${remoteHost ? '' : '<div class="no-host" id="no-host-msg">No external host configured &#8594; local network only.<br>Click to configure in Settings.</div>'}
  <button class="regen-btn" id="regen-btn">New PIN</button>
  <script>
    var d = ${data}
    var noHostEl = document.getElementById('no-host-msg')
    if (noHostEl) {
      noHostEl.addEventListener('click', function() {
        if (window.remoteConnectApi) window.remoteConnectApi.openSettings()
      })
    }
    var activeIdx = 0
    document.getElementById('pin-el').textContent = d.pin
    function renderQr(i) {
      document.getElementById('qr-img').src = d.qrDataUrls[i]
    }
    function renderUrls() {
      document.getElementById('url-list').innerHTML = d.urls.map(function(u, i) {
        return '<button class="url-item' + (i === activeIdx ? ' active' : '') + '" onclick="sel(' + i + ')">' + u + '</button>'
      }).join('')
    }
    function sel(i) {
      activeIdx = i; renderQr(i); renderUrls()
      if (navigator.clipboard) {
        navigator.clipboard.writeText(d.urls[i]).then(function() {
          var btn = document.querySelectorAll('.url-item')[i]
          if (!btn) return
          var prev = btn.textContent
          btn.textContent = '\\u2713 Copied'
          setTimeout(function() { btn.textContent = prev }, 1400)
        }).catch(function() {})
      }
    }
    renderQr(0); renderUrls()
    document.getElementById('regen-btn').addEventListener('click', function() {
      var btn = document.getElementById('regen-btn')
      btn.disabled = true
      btn.textContent = 'Generating...'
      fetch('/api/regenerate-pin', { method: 'POST' })
        .then(function(r) { return r.json() })
        .then(function(newData) {
          d = newData
          activeIdx = 0
          document.getElementById('pin-el').textContent = d.pin
          renderQr(0)
          renderUrls()
          btn.textContent = 'New PIN'
          btn.disabled = false
        })
        .catch(function() {
          btn.textContent = 'New PIN'
          btn.disabled = false
        })
    })
  </script>
</body>
</html>`
}

// JSON.stringify escapes U+0000-U+001F but leaves U+007F (DEL) as a raw byte.
// A raw 0x7F in a JS string literal is a SyntaxError in browsers.
// We use split/join computed at runtime — esbuild would strip a DEL byte from a regex literal.
function safeJsJson(obj: unknown): string {
  const del = String.fromCharCode(0x7f)
  return JSON.stringify(obj)
    .split(del).join('\\u007f')
    .replace(/<\/script>/gi, '<\\/script>')
}

// Login page served at the aggregator when the client has no valid session.
const LOGIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIDE Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1e1e1e; color: #d4d4d4;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; gap: 16px; padding: 24px;
    }
    h2 { font-size: 15px; font-weight: 400; color: #858585; }
    .form { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 260px; }
    input {
      padding: 10px 12px; font-size: 20px; letter-spacing: 6px; text-align: center;
      background: #2d2d2d; border: 1px solid #3d3d3d; border-radius: 6px;
      color: #d4d4d4; outline: none; width: 100%;
    }
    input:focus { border-color: #4fc3f7; }
    button {
      padding: 10px; font-size: 14px; background: #4fc3f7; color: #1e1e1e;
      border: none; border-radius: 6px; cursor: pointer; font-weight: 500;
    }
    button:hover { background: #81d4fa; }
    button:disabled { opacity: .5; cursor: default; }
    .err { font-size: 12px; color: #f44747; text-align: center; min-height: 16px; }
  </style>
</head>
<body>
  <h2>AIDE Remote</h2>
  <div class="form">
    <input type="text" id="pin" inputmode="numeric" placeholder="PIN" autocomplete="off" maxlength="6">
    <button id="btn">Connect</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    var pin = document.getElementById('pin')
    var btn = document.getElementById('btn')
    var err = document.getElementById('err')
    function submit() {
      var val = pin.value.trim()
      if (!val) return
      btn.disabled = true
      err.textContent = ''
      fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: val })
      }).then(function(r) { return r.json() }).then(function(d) {
        if (d.ok) { window.location.replace('/') }
        else { err.textContent = 'Wrong PIN'; btn.disabled = false; pin.select() }
      }).catch(function() {
        err.textContent = 'Connection error'
        btn.disabled = false
      })
    }
    btn.addEventListener('click', submit)
    pin.addEventListener('keydown', function(e) { if (e.key === 'Enter') submit() })
    pin.focus()
  </script>
</body>
</html>`

// Project picker served at port 3847 after authentication.
// PIN is never sent to the client — Open links route through the aggregator.
const PICKER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIDE Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #1e1e1e; color: #d4d4d4;
      padding: 28px 20px;
    }
    h2 { font-size: 15px; font-weight: 400; color: #858585; margin-bottom: 18px; }
    .list { display: flex; flex-direction: column; gap: 10px; }
    .item {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: #2d2d2d; border: 1px solid #3d3d3d; border-radius: 6px;
      padding: 14px 16px;
    }
    .name { font-size: 14px; color: #d4d4d4; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .open {
      padding: 7px 18px; font-size: 13px; color: #1e1e1e; background: #4fc3f7;
      border: none; border-radius: 4px; cursor: pointer; white-space: nowrap; flex-shrink: 0;
      text-decoration: none; display: inline-block;
    }
    .open:hover { background: #81d4fa; }
    .empty { color: #555; font-size: 14px; }
    .footer { color: #444; font-size: 11px; margin-top: 20px; }
  </style>
</head>
<body>
  <h2>AIDE Remote &mdash; choose a project:</h2>
  <div class="list" id="list"><div class="empty">Loading…</div></div>
  <div class="footer" id="footer"></div>
  <script>
    function load() {
      fetch('/api/projects')
        .then(function(r) {
          if (r.status === 401) { window.location.replace('/'); return null }
          return r.json()
        })
        .then(function(projects) {
          if (!projects) return
          var list = document.getElementById('list')
          if (!projects.length) {
            list.innerHTML = '<div class="empty">No projects available.</div>'
          } else {
            list.innerHTML = projects.map(function(p) {
              var url = '/terminal?port=' + p.port
              return '<div class="item">' +
                '<span class="name">' + p.projectName.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>' +
                '<a class="open" href="' + url + '">Open</a>' +
              '</div>'
            }).join('')
          }
          document.getElementById('footer').textContent = 'Updated ' + new Date().toLocaleTimeString()
        })
        .catch(function() {
          document.getElementById('footer').textContent = 'Failed to load — retrying…'
        })
    }
    load()
    setInterval(load, 10000)
  </script>
</body>
</html>`

// Terminal page served by the aggregator. All traffic goes through port 3847 —
// the client never needs direct access to the instance's random port.
function makeAggTerminalHtml(port: number, defaultKbConfig: KeyboardConfig): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>AIDE Terminal</title>
  <link rel="stylesheet" href="/static/xterm.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #1e1e1e; overflow: hidden; }
    body { display: flex; flex-direction: column; }
    #status { flex-shrink: 0; padding: 5px 12px; font: 11px/1.4 monospace; color: #858585; background: #2d2d2d; border-bottom: 1px solid #3d3d3d; display: flex; align-items: center; gap: 8px; overflow: hidden; }
    #status-main { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #status-usage { flex-shrink: 0; white-space: nowrap; }
    #terminal { flex: 1; overflow: hidden; min-height: 0; }
    .xterm { height: 100%; }
    .xterm-viewport { overflow-y: auto !important; }
    #ctrl-bar { flex-shrink: 0; display: flex; align-items: center; gap: 4px; padding: 5px 8px; background: #252526; border-top: 1px solid #3d3d3d; overflow-x: auto; overflow-y: hidden; }
    #ctrl-bar::-webkit-scrollbar { display: none; }
    .cbtn { padding: 5px 10px; font: 12px/1 monospace; color: #ccc; background: #3c3c3c; border: 1px solid #555; border-radius: 4px; cursor: pointer; white-space: nowrap; flex-shrink: 0; touch-action: manipulation; -webkit-user-select: none; user-select: none; }
    .cbtn:active { background: #505050; }
    .kb-btn { color: #4fc3f7; border-color: #4fc3f7; margin-left: auto; }
    #tinput { flex: 1; min-width: 0; padding: 5px 8px; font: 13px/1.4 monospace; color: #d4d4d4; background: #1e1e1e; border: 1px solid #555; border-radius: 4px; outline: none; resize: none; overflow-y: auto; }
    #tinput:focus { border-color: #4fc3f7; }
  </style>
</head>
<body>
  <div id="status"><span id="status-main">Connecting...</span><span id="status-usage"></span></div>
  <div id="terminal"></div>
  <div id="ctrl-bar"></div>
  <script src="/static/xterm.js"></script>
  <script src="/static/addon-fit.js"></script>
  <script>
    var port = ${port}
    var params = new URLSearchParams(location.search)
    var activeTabId = params.get('tab') || null
    var wsReady = false
    var inputMode = false
    var kbConfig = ${safeJsJson(defaultKbConfig)}

    var statusMainEl = document.getElementById('status-main')
    var statusUsageEl = document.getElementById('status-usage')
    var ctrlBar = document.getElementById('ctrl-bar')
    var usagePollTimer = null
    function setStatus(t) { statusMainEl.textContent = t }
    function fetchUsage() {
      if (!activeTabId) return
      fetch('/api/usage?port=' + port + '&tab=' + encodeURIComponent(activeTabId))
        .then(function(r) { return r.json() })
        .then(function(d) {
          if (!d.summary) { statusUsageEl.textContent = ''; return }
          var color = d.level === 'critical' ? '#f44747' : d.level === 'warn' ? '#cca700' : '#858585'
          statusUsageEl.textContent = d.summary
          statusUsageEl.style.color = color
          statusUsageEl.title = d.tooltip || ''
        })
        .catch(function() {})
    }
    function startUsagePoll() {
      fetchUsage()
      if (usagePollTimer) clearInterval(usagePollTimer)
      usagePollTimer = setInterval(fetchUsage, 10000)
    }
    function stopUsagePoll() {
      if (usagePollTimer) { clearInterval(usagePollTimer); usagePollTimer = null }
      statusUsageEl.textContent = ''
    }

    // --- Terminal ---
    var term = new Terminal({
      theme: {
        background: '#1e1e1e', foreground: '#d4d4d4',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
        brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
        brightCyan: '#29b8db', brightWhite: '#e5e5e5',
        cursor: '#d4d4d4', selectionBackground: '#264f78'
      },
      fontFamily: 'monospace', fontSize: 13, cursorBlink: true, scrollback: 10000
    })
    var fitAddon = new FitAddon.FitAddon()
    term.loadAddon(fitAddon)
    term.open(document.getElementById('terminal'))

    var xtermTA = document.querySelector('.xterm-helper-textarea')
    if (xtermTA) xtermTA.setAttribute('inputmode', 'none')

    ;(function() {
      var el = document.getElementById('terminal')
      var lastY = 0
      var acc = 0
      el.addEventListener('touchstart', function(e) {
        lastY = e.touches[0].clientY
        acc = 0
      }, { passive: true })
      el.addEventListener('touchmove', function(e) {
        var y = e.touches[0].clientY
        acc += lastY - y
        lastY = y
        var lineH = 16
        var lines = Math.trunc(acc / lineH)
        if (lines !== 0) { term.scrollLines(lines); acc -= lines * lineH }
      }, { passive: true })
    })()

    // --- WebSocket (through aggregator on same host/port) ---
    var proto = location.protocol === 'https:' ? 'wss' : 'ws'
    var ws = new WebSocket(proto + '://' + location.host + '/ws?port=' + port)

    function sk(data) {
      if (!activeTabId || !wsReady) return
      ws.send(JSON.stringify({ type: 'input', tabId: activeTabId, data: data }))
    }

    function makeKbBtn() {
      var b = document.createElement('button')
      b.className = 'cbtn kb-btn'
      b.textContent = '⌨'
      return b
    }

    function renderButtons() {
      inputMode = false
      ctrlBar.innerHTML = ''
      kbConfig.buttons.forEach(function(btn) {
        var b = document.createElement('button')
        b.className = 'cbtn'
        b.textContent = btn.label
        b.addEventListener('click', (function(s) { return function() { sk(s) } })(btn.send))
        ctrlBar.appendChild(b)
      })
      var kb = makeKbBtn()
      kb.addEventListener('click', switchToInput)
      ctrlBar.appendChild(kb)
    }

    function switchToInput() {
      inputMode = true
      ctrlBar.innerHTML = ''
      var inp = document.createElement('textarea')
      inp.id = 'tinput'
      inp.rows = 3
      inp.setAttribute('autocomplete', 'off')
      inp.setAttribute('autocorrect', 'off')
      inp.setAttribute('autocapitalize', 'off')
      inp.setAttribute('spellcheck', 'false')
      inp.placeholder = 'Type command... (Enter = newline, ⌨ = send)'
      inp.addEventListener('focus', function() {
        setTimeout(function() { ctrlBar.scrollIntoView(false) }, 350)
      })
      ctrlBar.appendChild(inp)
      var kb = makeKbBtn()
      kb.addEventListener('click', sendAndClose)
      ctrlBar.appendChild(kb)
      setTimeout(function() { inp.focus() }, 30)
    }

    function sendAndClose() {
      var inp = document.getElementById('tinput')
      var LF = String.fromCharCode(10)
      var CR = String.fromCharCode(13)
      if (inp && inp.value) sk(inp.value.split(LF).join(CR) + CR)
      renderButtons()
    }

    document.getElementById('terminal').addEventListener('click', function() {
      if (inputMode) {
        var inp = document.getElementById('tinput')
        if (inp) inp.focus()
      }
    })

    ws.onopen = function() { ws.send(JSON.stringify({ type: 'auth', token: '' })) }

    ws.onmessage = function(e) {
      var msg = JSON.parse(e.data)
      if (msg.type === 'auth-ok') {
        wsReady = true
        if (activeTabId) {
          fitAddon.fit()
          ws.send(JSON.stringify({ type: 'take-tab', tabId: activeTabId, cols: term.cols, rows: term.rows }))
          setStatus('Taking tab...')
          startUsagePoll()
        } else {
          ws.send(JSON.stringify({ type: 'list-tabs' }))
        }
      } else if (msg.type === 'auth-fail') {
        setStatus('Auth failed — session expired, reload the page')
      } else if (msg.type === 'tabs') {
        var available = msg.tabs.filter(function(t) { return !t.locked })
        var chosen = available[0] || msg.tabs[0]
        if (!chosen) { setStatus('No sessions available'); return }
        activeTabId = chosen.tabId
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'take-tab', tabId: activeTabId, cols: term.cols, rows: term.rows }))
        setStatus('Connected: ' + (chosen.toolName || chosen.tabId))
        startUsagePoll()
      } else if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'error') {
        setStatus('Error: ' + msg.message)
      } else if (msg.type === 'tab-closed') {
        if (msg.tabId === activeTabId) setStatus('Session closed')
      }
    }

    ws.onclose = function() { stopUsagePoll(); setStatus('Disconnected — reload to reconnect') }
    ws.onerror = function() { stopUsagePoll(); setStatus('Connection error') }

    term.onData(function(data) { sk(data) })

    function doResize() {
      fitAddon.fit()
      if (!activeTabId || ws.readyState !== 1) return
      ws.send(JSON.stringify({ type: 'resize', tabId: activeTabId, cols: term.cols, rows: term.rows }))
    }
    function applyViewport() {
      var h = window.visualViewport ? window.visualViewport.height : window.innerHeight
      document.body.style.height = h + 'px'
      doResize()
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', applyViewport)
      window.visualViewport.addEventListener('scroll', applyViewport)
    } else {
      window.addEventListener('resize', applyViewport)
    }
    new ResizeObserver(doResize).observe(document.getElementById('terminal'))
    applyViewport()

    fetch('/api/keyboard-config?port=' + port)
      .then(function(r) { return r.json() })
      .then(function(cfg) { kbConfig = cfg; renderButtons() })
      .catch(function() {})

    renderButtons()
  </script>
</body>
</html>`
}

const TERMINAL_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>AIDE Terminal</title>
  <link rel="stylesheet" href="/static/xterm.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #1e1e1e; overflow: hidden; }
    body { display: flex; flex-direction: column; }
    #status { flex-shrink: 0; padding: 5px 12px; font: 11px/1.4 monospace; color: #858585; background: #2d2d2d; border-bottom: 1px solid #3d3d3d; display: flex; align-items: center; gap: 8px; overflow: hidden; }
    #status-main { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #status-usage { flex-shrink: 0; white-space: nowrap; }
    #terminal { flex: 1; overflow: hidden; min-height: 0; }
    .xterm { height: 100%; }
    .xterm-viewport { overflow-y: auto !important; }
    #ctrl-bar { flex-shrink: 0; display: flex; align-items: center; gap: 4px; padding: 5px 8px; background: #252526; border-top: 1px solid #3d3d3d; overflow-x: auto; overflow-y: hidden; }
    #ctrl-bar::-webkit-scrollbar { display: none; }
    .cbtn { padding: 5px 10px; font: 12px/1 monospace; color: #ccc; background: #3c3c3c; border: 1px solid #555; border-radius: 4px; cursor: pointer; white-space: nowrap; flex-shrink: 0; touch-action: manipulation; -webkit-user-select: none; user-select: none; }
    .cbtn:active { background: #505050; }
    .kb-btn { color: #4fc3f7; border-color: #4fc3f7; margin-left: auto; }
    #tinput { flex: 1; min-width: 0; padding: 5px 8px; font: 13px/1.4 monospace; color: #d4d4d4; background: #1e1e1e; border: 1px solid #555; border-radius: 4px; outline: none; resize: none; overflow-y: auto; }
    #tinput:focus { border-color: #4fc3f7; }
  </style>
</head>
<body>
  <div id="status"><span id="status-main">Connecting...</span><span id="status-usage"></span></div>
  <div id="terminal"></div>
  <div id="ctrl-bar"></div>
  <script src="/static/xterm.js"></script>
  <script src="/static/addon-fit.js"></script>
  <script>
    var params = new URLSearchParams(location.search)
    var token = params.get('token') || ''
    var activeTabId = params.get('tab') || null
    var wsReady = false
    var inputMode = false
    var kbConfig = ${safeJsJson(DEFAULT_KEYBOARD_CONFIG)}

    var statusMainEl = document.getElementById('status-main')
    var statusUsageEl = document.getElementById('status-usage')
    var ctrlBar = document.getElementById('ctrl-bar')
    var usagePollTimer = null
    function setStatus(t) { statusMainEl.textContent = t }
    function fetchUsage() {
      if (!activeTabId) return
      fetch('/api/usage?tab=' + encodeURIComponent(activeTabId))
        .then(function(r) { return r.json() })
        .then(function(d) {
          if (!d.summary) { statusUsageEl.textContent = ''; return }
          var color = d.level === 'critical' ? '#f44747' : d.level === 'warn' ? '#cca700' : '#858585'
          statusUsageEl.textContent = d.summary
          statusUsageEl.style.color = color
          statusUsageEl.title = d.tooltip || ''
        })
        .catch(function() {})
    }
    function startUsagePoll() {
      fetchUsage()
      if (usagePollTimer) clearInterval(usagePollTimer)
      usagePollTimer = setInterval(fetchUsage, 10000)
    }
    function stopUsagePoll() {
      if (usagePollTimer) { clearInterval(usagePollTimer); usagePollTimer = null }
      statusUsageEl.textContent = ''
    }

    // --- Terminal ---
    var term = new Terminal({
      theme: {
        background: '#1e1e1e', foreground: '#d4d4d4',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
        brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
        brightCyan: '#29b8db', brightWhite: '#e5e5e5',
        cursor: '#d4d4d4', selectionBackground: '#264f78'
      },
      fontFamily: 'monospace', fontSize: 13, cursorBlink: true, scrollback: 10000
    })
    var fitAddon = new FitAddon.FitAddon()
    term.loadAddon(fitAddon)
    term.open(document.getElementById('terminal'))

    // Prevent Android soft keyboard from popping when tapping the terminal
    var xtermTA = document.querySelector('.xterm-helper-textarea')
    if (xtermTA) xtermTA.setAttribute('inputmode', 'none')

    // Touch scroll: xterm captures touch events and blocks native scroll,
    // so we translate swipe delta into term.scrollLines() calls manually.
    ;(function() {
      var el = document.getElementById('terminal')
      var lastY = 0
      var acc = 0
      el.addEventListener('touchstart', function(e) {
        lastY = e.touches[0].clientY
        acc = 0
      }, { passive: true })
      el.addEventListener('touchmove', function(e) {
        var y = e.touches[0].clientY
        acc += lastY - y
        lastY = y
        var lineH = 16
        var lines = Math.trunc(acc / lineH)
        if (lines !== 0) { term.scrollLines(lines); acc -= lines * lineH }
      }, { passive: true })
    })()

    // --- WebSocket ---
    var proto = location.protocol === 'https:' ? 'wss' : 'ws'
    var ws = new WebSocket(proto + '://' + location.host + '/ws')

    function sk(data) {
      if (!activeTabId || !wsReady) return
      ws.send(JSON.stringify({ type: 'input', tabId: activeTabId, data: data }))
    }

    // --- Control bar ---
    function makeKbBtn() {
      var b = document.createElement('button')
      b.className = 'cbtn kb-btn'
      b.textContent = '⌨'
      return b
    }

    function renderButtons() {
      inputMode = false
      ctrlBar.innerHTML = ''
      kbConfig.buttons.forEach(function(btn) {
        var b = document.createElement('button')
        b.className = 'cbtn'
        b.textContent = btn.label
        b.addEventListener('click', (function(s) { return function() { sk(s) } })(btn.send))
        ctrlBar.appendChild(b)
      })
      var kb = makeKbBtn()
      kb.addEventListener('click', switchToInput)
      ctrlBar.appendChild(kb)
    }

    function switchToInput() {
      inputMode = true
      ctrlBar.innerHTML = ''
      var inp = document.createElement('textarea')
      inp.id = 'tinput'
      inp.rows = 3
      inp.setAttribute('autocomplete', 'off')
      inp.setAttribute('autocorrect', 'off')
      inp.setAttribute('autocapitalize', 'off')
      inp.setAttribute('spellcheck', 'false')
      inp.placeholder = 'Type command... (Enter = newline, ⌨ = send)'
      inp.addEventListener('focus', function() {
        setTimeout(function() { ctrlBar.scrollIntoView(false) }, 350)
      })
      ctrlBar.appendChild(inp)
      var kb = makeKbBtn()
      kb.addEventListener('click', sendAndClose)
      ctrlBar.appendChild(kb)
      setTimeout(function() { inp.focus() }, 30)
    }

    function sendAndClose() {
      var inp = document.getElementById('tinput')
      var LF = String.fromCharCode(10)
      var CR = String.fromCharCode(13)
      if (inp && inp.value) sk(inp.value.split(LF).join(CR) + CR)
      renderButtons()
    }

    // Tapping terminal while in input mode re-focuses the input
    document.getElementById('terminal').addEventListener('click', function() {
      if (inputMode) {
        var inp = document.getElementById('tinput')
        if (inp) inp.focus()
      }
    })

    // --- WS handlers ---
    ws.onopen = function() { ws.send(JSON.stringify({ type: 'auth', token: token })) }

    ws.onmessage = function(e) {
      var msg = JSON.parse(e.data)
      if (msg.type === 'auth-ok') {
        wsReady = true
        if (activeTabId) {
          fitAddon.fit()
          ws.send(JSON.stringify({ type: 'take-tab', tabId: activeTabId, cols: term.cols, rows: term.rows }))
          setStatus('Taking tab...')
          startUsagePoll()
        } else {
          ws.send(JSON.stringify({ type: 'list-tabs' }))
        }
      } else if (msg.type === 'auth-fail') {
        setStatus('Auth failed — check the URL and token')
      } else if (msg.type === 'tabs') {
        var available = msg.tabs.filter(function(t) { return !t.locked })
        var chosen = available[0] || msg.tabs[0]
        if (!chosen) { setStatus('No sessions available'); return }
        activeTabId = chosen.tabId
        fitAddon.fit()
        ws.send(JSON.stringify({ type: 'take-tab', tabId: activeTabId, cols: term.cols, rows: term.rows }))
        setStatus('Connected: ' + (chosen.toolName || chosen.tabId))
        startUsagePoll()
      } else if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'error') {
        setStatus('Error: ' + msg.message)
      } else if (msg.type === 'tab-closed') {
        if (msg.tabId === activeTabId) setStatus('Session closed')
      }
    }

    ws.onclose = function() { stopUsagePoll(); setStatus('Disconnected — reload to reconnect') }
    ws.onerror = function() { stopUsagePoll(); setStatus('Connection error') }

    // Desktop physical keyboard still works via xterm.onData
    term.onData(function(data) { sk(data) })

    // Refit terminal and notify server when visible area changes.
    // visualViewport tracks the real visible area on mobile (accounts for virtual keyboard).
    function doResize() {
      fitAddon.fit()
      if (!activeTabId || ws.readyState !== 1) return
      ws.send(JSON.stringify({ type: 'resize', tabId: activeTabId, cols: term.cols, rows: term.rows }))
    }
    function applyViewport() {
      var h = window.visualViewport ? window.visualViewport.height : window.innerHeight
      document.body.style.height = h + 'px'
      doResize()
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', applyViewport)
      window.visualViewport.addEventListener('scroll', applyViewport)
    } else {
      window.addEventListener('resize', applyViewport)
    }
    new ResizeObserver(doResize).observe(document.getElementById('terminal'))
    applyViewport()

    // Load keyboard config from server — may override defaults if user has custom file
    fetch('/api/keyboard-config')
      .then(function(r) { return r.json() })
      .then(function(cfg) { kbConfig = cfg; renderButtons() })
      .catch(function() {})

    renderButtons()
  </script>
</body>
</html>`
