import http from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { networkInterfaces } from 'os'
import { app, BrowserWindow } from 'electron'
import QRCode from 'qrcode'
import type { PtyManager } from '../pty/ptyManager'
import { loadOrGeneratePin, regeneratePin, validatePin } from './auth'
import { PtyBridge } from './ptyBridge'

const DEFAULT_PORT = 3847

interface KeyboardButton {
  label: string
  send: string
}

interface KeyboardConfig {
  buttons: KeyboardButton[]
}

// Default control buttons for mobile terminal.
// Override by placing remote-keyboard.json in %APPDATA%/AIDE/ (userData dir).
// Use Unicode escapes for control chars in the JSON file, e.g. "" for Ctrl+C.
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
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private bridge: PtyBridge
  private pin = ''
  private port: number
  private pinPath: string

  constructor(
    private ptyRegistry: Map<BrowserWindow, PtyManager>,
    private openProjects: Map<string, BrowserWindow>,
    port = DEFAULT_PORT
  ) {
    this.port = port
    this.pinPath = join(app.getPath('userData'), 'remote-pin.txt')
    this.bridge = new PtyBridge(ptyRegistry)
    this.bridge.onLockChanged = (tabId, locked) => {
      for (const win of openProjects.values()) {
        if (!win.isDestroyed()) win.webContents.send('remote:tab-lock-changed', { tabId, locked })
      }
    }
  }

  start(): void {
    this.pin = loadOrGeneratePin(this.pinPath)
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws) => this.handleConnection(ws))
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Another AIDE instance is already serving remote access on this port.
        this.server = null
        this.wss = null
      }
    })
    this.server.listen(this.port)
  }

  stop(): void {
    this.wss?.close()
    this.server?.close()
    this.server = null
    this.wss = null
  }

  getConnectionUrls(): string[] {
    const ips = getLocalIps()
    const hosts = ips.length > 0 ? ips : ['localhost']
    return hosts.map((ip) => `http://${ip}:${this.port}/?token=${this.pin}`)
  }

  getPin(): string { return this.pin }
  getPort(): number { return this.port }

  forceReleaseTab(tabId: string): void {
    this.bridge.forceRelease(tabId)
  }

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

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/'

    if (url === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

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
      const urls = this.getConnectionUrls()
      Promise.all(
        urls.map((u) => QRCode.toDataURL(u, { width: 220, margin: 1, color: { dark: '#000000', light: '#ffffff' } }))
      ).then((qrDataUrls) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(makeConnectHtml(urls, this.pin, qrDataUrls))
      }).catch(() => {
        res.writeHead(500)
        res.end('QR generation failed')
      })
      return
    }

    if (url === '/' || url.startsWith('/?') || url.startsWith('/terminal')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(TERMINAL_HTML)
      return
    }

    res.writeHead(404)
    res.end()
  }

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

function makeConnectHtml(urls: string[], pin: string, qrDataUrls: string[]): string {
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
  </style>
</head>
<body>
  <h3>Open on your mobile device:</h3>
  <div id="qr-wrap"><img id="qr-img" alt="QR code" style="display:block;width:220px;height:220px;"></div>
  <div class="pin" id="pin-el"></div>
  <div class="urls" id="url-list"></div>
  <div class="hint">PIN is embedded in the URL — just tap the link</div>
  <button class="regen-btn" id="regen-btn">New PIN</button>
  <script>
    var d = ${data}
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
    #status { flex-shrink: 0; padding: 5px 12px; font: 11px/1.4 monospace; color: #858585; background: #2d2d2d; border-bottom: 1px solid #3d3d3d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  <div id="status">Connecting...</div>
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

    var statusEl = document.getElementById('status')
    var ctrlBar = document.getElementById('ctrl-bar')
    function setStatus(t) { statusEl.textContent = t }

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
      } else if (msg.type === 'output') {
        term.write(msg.data)
      } else if (msg.type === 'error') {
        setStatus('Error: ' + msg.message)
      } else if (msg.type === 'tab-closed') {
        if (msg.tabId === activeTabId) setStatus('Session closed')
      }
    }

    ws.onclose = function() { setStatus('Disconnected — reload to reconnect') }
    ws.onerror = function() { setStatus('Connection error') }

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
