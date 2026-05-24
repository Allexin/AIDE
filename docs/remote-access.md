# Remote Access — Design Document

## Overview

Allow a mobile device (phone/tablet) to connect to a running AIDE instance and work with terminal sessions through a browser. The mobile client is the primary display target; the desktop PC remains running and visible but yields terminal control.

---

## Use Case

Primary scenario: user starts AIDE on PC, leaves it running, continues working from a phone while away. The PC stays on. Mobile is the active operator; desktop is an observer.

---

## Design Decisions

### Terminal streaming — raw PTY over WebSocket

Raw PTY data (VT100/ANSI escape sequences) is streamed to the mobile client via WebSocket. The mobile client runs xterm.js in the browser and renders the terminal natively.

**Rejected alternatives:**
- History-only stream: loses interactive UI (y/n prompts, option pickers, progress bars)
- Screenshot streaming: heavy, high latency, not touch-friendly

### PTY size — mobile is master

When a mobile client connects and takes control of a tab, the PTY is resized to the mobile client's reported cols/rows. The desktop renderer shows the tab as read-only and does not interfere with sizing.

**Default PTY spawn size** remains 80×24. Mobile reports its actual xterm.js viewport size on connect; PTY resizes to match.

### Exclusive access — one master per tab

A tab has exactly one active writer at a time. When mobile takes a tab, the desktop side becomes read-only for that tab. When mobile disconnects, the tab reverts to normal desktop control.

PC is authoritative: a "Take back" button on the desktop forces the tab back regardless of remote connection state. This handles stuck/zombie connections.

### Session flow — mobile uses Session Picker

Mobile sees our existing Session Picker UI (web version). Options:
- **Select open session** → mobile takes exclusive control of that tab; desktop tab shows 📱 indicator and blocks input
- **Resume closed session or new session** → new tab is created, mobile takes exclusive control

On mobile disconnect: tab becomes normal again (writable, no indicator). PTY continues running — session is not killed.

### Desktop experience during remote session

The tab remains visible in the desktop tab bar with a 📱 indicator. The terminal content is shown (live, read-only). No modal blocking the desktop — the user can freely work in other tabs. "Take back" button is always accessible in the locked tab.

### Web client — minimal, vanilla

No React, no build step on the client side. Plain HTML + vanilla JS + xterm.js loaded from a local static bundle served by the embedded HTTP server.

xterm.js is ~500KB, loaded once, cached by the browser. There are no viable alternatives for correct VT100 rendering in a browser.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  AIDE Main Process                              │
│                                                 │
│  ┌──────────────────┐   ┌────────────────────┐  │
│  │  RemoteServer    │   │  PtyManager        │  │
│  │  HTTP + WS       │◄──│  (existing)        │  │
│  │  port: 3847      │   │  + subscribeToOutput│  │
│  └──────────────────┘   └────────────────────┘  │
│          │                                      │
│  ┌───────┴──────────┐                           │
│  │  Static files    │  Session Picker API       │
│  │  (web client)    │  File tree API            │
│  └──────────────────┘  Log stream API           │
└─────────────────────────────────────────────────┘
         │ HTTP/WebSocket
┌────────▼────────────────┐
│  Mobile Browser         │
│  Session Picker → HTML  │
│  Terminal → xterm.js    │
│  Logs → plain HTML      │
└─────────────────────────┘
```

### WebSocket message protocol

```
Client → Server:
  { type: 'auth',       token: string }
  { type: 'list-tabs' }
  { type: 'take-tab',   tabId: string, cols: number, rows: number }
  { type: 'input',      tabId: string, data: string }
  { type: 'resize',     tabId: string, cols: number, rows: number }
  { type: 'release-tab', tabId: string }

Server → Client:
  { type: 'auth-ok' }
  { type: 'auth-fail' }
  { type: 'tabs',       tabs: SessionTabInfo[] }
  { type: 'output',     tabId: string, data: string }
  { type: 'tab-locked', tabId: string }          ← sent to desktop renderer
  { type: 'tab-unlocked', tabId: string }        ← sent to desktop renderer
  { type: 'tab-closed', tabId: string }
```

---

## Module Structure

All new code lives under `src/main/remote/`. Zero new files in existing directories except for the two integration points listed below.

```
src/main/remote/
  index.ts          — RemoteServer class: starts HTTP + WebSocket, handles auth
  ptyBridge.ts      — subscribes to PtyManager output, routes input/resize
  sessionApi.ts     — serves session list, resume/new session logic
  fileApi.ts        — serves file tree and git diff endpoints
  logApi.ts         — streams log entries over WebSocket
  auth.ts           — token generation and validation
  static/           — web client files (served as-is)
    index.html      — session picker page
    terminal.html   — terminal page
    xterm/          — xterm.js + addon bundles (vendored)
    app.js          — vanilla JS glue
```

### HTTP endpoints

```
GET  /                   → session picker (index.html)
GET  /terminal           → terminal page (terminal.html)
GET  /api/sessions       → session list JSON
GET  /api/filetree       → directory listing JSON
GET  /api/diff?path=...  → git diff for file
WS   /ws                 → WebSocket connection
```

---

## Integration Points (changes to existing code)

Exactly two changes to existing files:

### 1. `src/main/pty/ptyManager.ts` — add `subscribeToOutput`

```typescript
// New public method — ~8 lines
subscribeToOutput(tabId: string, cb: (data: string) => void): () => void {
  // Attach a listener to the raw PTY onData event for this tab
  // Returns an unsubscribe function
}
```

The PTY data event currently only calls `this.send(...)`. This method lets RemoteServer tap the same stream without touching `spawnPty`.

**Input and resize** require no changes — `write(tabId, data)` and `resize(tabId, cols, rows)` are already public methods. RemoteServer calls them directly when the mobile client sends input or reports a viewport resize.

### 2. `src/main/index.ts` — start RemoteServer

```typescript
// One call during app init, after ptyRegistry is ready
import { RemoteServer } from './remote'
const remoteServer = new RemoteServer(ptyRegistry, openProjects)
remoteServer.start()   // no-op if disabled in settings
```

### 3. Renderer — tab locked indicator

`useSessionStore` gains a `remoteLockedTabs: Set<string>` field, updated via a new IPC event `remote:tab-lock-changed`. The terminal tab header checks this set to show the 📱 indicator and disable keyboard input. This is isolated to the tab header and input handler — no other component changes.

---

## Security

### Token authentication

On server start, a random 6-digit PIN is generated. The mobile client must provide this PIN in the WebSocket `auth` message before any other messages are accepted. Invalid or missing auth closes the connection immediately.

The PIN is embedded in the connection URL and shown as a QR code in the "Remote Connect" window. Mobile opens the URL in a browser — the page reads the token from the query string and authenticates automatically.

The PIN regenerates on each app launch (or on manual regeneration from settings).

### Transport

Local network: plain WebSocket (ws://) is acceptable — the PIN prevents unauthorized access.

Internet access: the embedded server does not need to handle TLS directly. External tools (Tailscale, Cloudflare Tunnel) terminate TLS at the edge. AIDE's server always listens on localhost or LAN IP only; it never self-exposes to the public internet.

---

## Connection URL Generation

### Local network (default, works out of the box)

On server start, AIDE reads local network interfaces via `os.networkInterfaces()` and picks the first private IPv4 address (192.168.x.x, 10.x.x.x, 172.16–31.x.x). The connection URL is assembled immediately:

```
http://192.168.1.47:3847/?token=482931
```

This URL is shown as QR code and plain text in the "Remote Connect" window. If the phone is on the same WiFi network, it opens and connects with no additional setup.

If multiple network interfaces are found (e.g. Ethernet + WiFi), all candidate URLs are listed so the user can pick the right one.

### Internet access

AIDE has no way to know its public IP or whether the router allows incoming connections. The embedded server never self-exposes to the internet — a tunnel tool must be set up externally. The "View tunnel setup guide" button in Settings handles this case.

## Internet Access / NAT Traversal

AIDE does not implement NAT traversal. Instead, it guides the user through established tools.

### Recommended: Tailscale

Install Tailscale on PC and phone → devices share a private mesh network → phone connects to PC's Tailscale IP as if on LAN. No port forwarding, works from anywhere.

Setup effort: ~5 minutes, no technical knowledge required.

### Alternative: Cloudflare Tunnel

Run `cloudflared tunnel --url localhost:3847` on the PC → get a public HTTPS URL → share with phone. Cloudflare Access can add email-based OTP authentication on top.

No app required on the phone — any browser works.

---

## Desktop UI Integration

### Menu — "Remote Connect"

A new top-level menu item **"Remote Connect"** is added directly in `src/main/menu/index.ts` inside `rebuildMenu()` — no submenu, one click opens it immediately:

```
File | Edit | CLI | Remote Connect
```

**Click behavior:**

- Remote server is **disabled** (default) →
  `dialog.showMessageBox` with:
  - Message: "Remote access is not enabled."
  - Detail: "Enable it in Settings first."
  - Buttons: ["Open Settings", "Cancel"]
  - "Open Settings" → `createSettingsWindow(parent)`

- Remote server is **enabled** →
  Open a small dedicated BrowserWindow ("Remote Connect" window) showing:
  - QR code encoding the full connection URL
  - Connection URL as plain text (selectable, copyable)
  - Token displayed separately for manual entry

**Connection URL format:** `http://<local-ip>:<port>/?token=<pin>`

This URL is ready to open on mobile — the web client reads the token from the query string and authenticates automatically.

The "Remote Connect" window is a minimal BrowserWindow (similar to the session picker), not a `dialog.showMessageBox` — because native dialogs cannot render a QR code canvas.

### Settings — "Remote Access" section

New section in `SettingsApp.tsx`:

```
Remote Access
  [ ] Enable remote server
  Port: [3847]
  External address (optional): [________________________]
    e.g. my.tailscale.ip:3847 or abc123.trycloudflare.com

  [View tunnel setup guide]
```

If "External address" is filled, the "Remote Connect" window shows **two** QR codes / URLs:
- Local: `http://192.168.1.47:3847/?token=...`
- External: `http://my.tailscale.ip:3847/?token=...`

If empty, only the local URL is shown.

**"View tunnel setup guide" button** calls `terminal:create-with-prompt` (existing IPC handler) with a carefully constructed prompt that includes:
- The task: help the user set up a web tunnel for AIDE remote access
- Context: how AIDE Remote Connect works (HTTP server on configurable port, WebSocket PTY streaming, token auth)
- Options: Tailscale (recommended, mesh VPN, app on both devices) vs Cloudflare Tunnel (public HTTPS URL, browser-only on mobile)
- What the user needs to do after tunnel is set up: update the connection URL in AIDE settings or just use the tunnel URL directly

The prompt is sent to whichever CLI tool is currently the default (Claude Code, Qwen Code, etc.) — same as `createNewSessionWithPrompt`. No hardcoding of tool ID.

The prompt explicitly includes as a final step: "After the tunnel is running, copy the external address (host:port or full URL) and paste it into the **External address** field in AIDE Settings → Remote Access. This is required for the Remote Connect window to generate the correct QR code for internet access."

The button is disabled (greyed out) if no CLI tool is activated.

---

## Implementation Phases

### Phase 1 — PTY streaming (foundation)

- RemoteServer: HTTP + WebSocket server, token auth
- `subscribeToOutput` in PtyManager
- Mobile terminal page: xterm.js, connects via WS, displays output, sends input
- Tab lock state: IPC event → useSessionStore → tab header indicator + "Take back"

### Phase 2 — Session Picker

- `/api/sessions` endpoint (reuses existing scan logic)
- Mobile session picker page: list sessions, new/resume actions
- Session creation/resume through RemoteServer → PtyManager

### Phase 3 — Logs and File Tree

- `/api/filetree` endpoint + WS push on changes
- `/api/diff` endpoint
- Mobile log page: channel list, live stream
- Simple mobile file tree view (read-only)

### Phase 4 — Settings UI

- Remote Access settings panel in AIDE
- QR code generation
- Setup guides for Tailscale / Cloudflare

---

## Implementation Status

### Done (Phase 1 — AIDE side)

**New files:**
- `src/main/remote/auth.ts` — 6-digit PIN generation and validation
- `src/main/remote/ptyBridge.ts` — tab lock management, input/output routing between WS clients and PtyManager
- `src/main/remote/index.ts` — RemoteServer (HTTP + WebSocket on port 3847); serves `/connect` (QR window) and `/terminal` (web client); QR code generated server-side via `qrcode` npm package (no CDN dependency)
- `src/main/windows/remoteConnect.ts` — BrowserWindow showing QR code + all local IPs, clickable to switch between interfaces

**Modified files:**
- `src/main/pty/ptyManager.ts` — added `subscribeToOutput(tabId, cb): () => void`, cleanup in `closeTab`/`disposeAll`
- `src/main/index.ts` — RemoteServer starts on app launch (port 3847)
- `src/main/menu/index.ts` — "Remote Connect" top-level menu item (opens QR window)
- `src/main/ipc/index.ts` — `remote:take-back` handler
- `src/renderer/src/store/useSessionStore.ts` — `remoteLockedTabs: Set<string>`, `setRemoteLocked()`
- `src/renderer/src/components/layout/TerminalPanel.tsx` — 📱 indicator on locked tabs, "Take back" button, input blocked when tab is remotely locked
- `src/preload/editor.ts` + `src/renderer/src/env.d.ts` — `onRemoteTabLockChanged`, `remoteTakeBack`

**What works:**
- RemoteServer starts automatically, generates PIN on each launch
- "Remote Connect" menu → BrowserWindow with QR code + all local IPs, click to switch interface
- Mobile browser opens URL, authenticates via PIN embedded in URL, connects to first free tab
- PTY output streams to mobile browser (xterm.js display)
- Desktop tab shows 📱 indicator, input blocked
- "Take back" button on desktop forcibly releases the tab
- QR code generated server-side (no CDN, works offline)

**Dependencies added:** `ws`, `qrcode`, `@types/ws`, `@types/qrcode`

---

### Pending — Mobile terminal input

**Problem:** Android soft keyboard uses IME composition events. xterm.js receives both the composition preview and the final character, causing doubled/corrupted input in the PTY. This breaks both the mobile display and the PC view (same PTY state).

**Decided approach:** Input bar at the bottom of terminal.html. The Android keyboard types into a plain `<input>` field (which handles IME composition correctly natively). On Enter → send complete line to PTY. xterm.js becomes display-only (its internal textarea disabled for input).

**Input bar layout:**
```
┌──────────────────────────────────────────────┐
│  [Ctrl+C]  [Esc]  [↑]  [↓]  [Tab]           │  ← quick-action buttons
├──────────────────────────────────────────────┤
│  [_________________input_______________] [↵]  │  ← Android native input
└──────────────────────────────────────────────┘
```

**Open questions before implementing:**
- Arrow ↑↓: send `\x1b[A`/`\x1b[B` directly to PTY (simplest), OR maintain local client-side history of sent commands?
- Quick buttons: `y` / `n` for prompts, or Ctrl+C sufficient?

**Implementation:** update `TERMINAL_HTML` constant in `src/main/remote/index.ts`:
1. Wrap layout in flex column: status bar → terminal (flex:1) → input bar (shrink:0)
2. After `term.open()`, find `.xterm-helper-textarea` and set `inputmode="none"` + `pointerEvents="none"` to disable xterm's own input
3. Clicking terminal area focuses the `<input>` field instead of xterm textarea
4. `sk(data)` function for quick-action buttons sending raw escape sequences
5. `sendInput()` sends `input.value + '\r'` then clears the field
6. ResizeObserver on terminal div → `fitAddon.fit()` + resize WS message (handles keyboard popup shrinking viewport)
7. Use `100dvh` for body height to account for virtual keyboard

---

### Not yet started

- Phase 2: Session Picker web page (`/api/sessions`, select/resume/new session from mobile)
- Phase 3: Logs and file tree endpoints
- Phase 4: Settings UI (enable/disable toggle, port config, external address for QR)
- Security: currently server always starts; needs settings gate (default disabled)
- Production packaging: static files path resolution for built app

---

## Multi-Instance Architecture (next to implement)

### Problem

When multiple AIDE projects are open simultaneously, each instance starts its own
`RemoteServer`. The second instance to start gets `EADDRINUSE` on port 3847 and
currently silently skips starting — its tabs are invisible to the mobile client.

### Solution: Aggregator-in-winner pattern

One AIDE instance acts as the **aggregator** (whichever wins port 3847). Other
instances register themselves with the aggregator via HTTP. The mobile browser
connects to port 3847 and sees a project picker listing all running instances.
When the user picks a project, the browser is redirected to that instance's own
port for the actual terminal session.

Each non-master instance runs its own HTTP server on an **OS-assigned port**
(`server.listen(0)`, then read `server.address().port`). This avoids any manual
port management.

```
Mobile browser
     │
     ▼ http://192.168.x.x:3847/          (aggregator — project picker)
┌────────────────────────────────────────────────────────┐
│  AIDE-1 (aggregator, port 3847)                        │
│  Serves: / → project list HTML                         │
│  Stores: [{port, project, pin, lastSeen}, ...]         │
└────────────────────────────────────────────────────────┘
     ▲  POST /api/register (heartbeat every 10s)
     │
     ├── AIDE-2 (port 51234, project "MyApp")
     └── AIDE-3 (port 51891, project "Backend")

User picks "MyApp" → browser navigates to:
  http://192.168.x.x:51234/?token=482931
  (full terminal session served by AIDE-2 directly, no proxy)
```

### Registration protocol

**AIDE on startup:**
```
1. Start own HTTP server on port 0 (OS assigns free port)
2. POST http://127.0.0.1:3847/api/register
   body: { port, projectPath, projectName, pin }
   → 200 OK:  aggregator is alive, start heartbeat loop
   → ECONNREFUSED: no aggregator yet
       → try server.listen(3847) on own server
           → success:  become aggregator
           → EADDRINUSE: race lost, wait 500ms, goto 2
```

**Heartbeat loop (every 10 seconds):**
```
POST http://127.0.0.1:3847/api/register  (same body, refreshes lastSeen)
→ OK:    all good
→ fail:  aggregator died, goto startup flow above
```

### Race condition resolution

Two instances detecting a dead aggregator simultaneously both call
`server.listen(3847)`. Only one succeeds — the OS guarantees exactly one winner.
The loser gets `EADDRINUSE`, waits 500ms, and re-registers with the winner.

No distributed consensus, no election protocol. The OS is the arbiter.

**Convergence time after aggregator death:** at most 10 seconds (heartbeat
interval) before a survivor claims port 3847 and the others re-register.

### Aggregator responsibilities

```
POST /api/register  — accept/refresh registration, respond 200
GET  /api/projects  — return live project list as JSON
GET  /              — serve project picker HTML page

Cleanup loop (every 15s):
  remove entries where lastSeen > 30s (instance died without notice)
  if registry is empty: process.exit(0)  ← aggregator shuts down cleanly
```

**Project picker HTML** (served at `/`) lists all registered projects:

```html
AIDE Remote — choose a project:

  ● MyApp          http://192.168.x.x:51234/?token=482931   [Open]
  ● Backend        http://192.168.x.x:51891/?token=193847   [Open]
  ● AIDE (self)    http://192.168.x.x:3847/?token=291034    [Open]
```

Each "Open" link navigates directly to that instance's terminal/picker page.
No proxying of PTY data — the aggregator only serves the directory.

### PIN behaviour with multiple instances

Each instance has its own PIN (stored per-process, loaded from `remote-pin.txt`
which is shared). Since all instances load from the same file, they share one
PIN by default. If any instance regenerates the PIN, all others will use the
stale in-memory value until their next restart.

**Acceptable for now.** Full multi-instance PIN sync can be added later if needed
(e.g. aggregator broadcasts new PIN to all registered instances via a
`POST /api/pin-updated` push).

### Implementation plan

Files to change:

**`src/main/remote/index.ts`**
- `start()`: bind on port 0 first, then attempt aggregator registration
- Add `tryBecomeAggregator()`: `server.listen(3847)` on a second server instance
- Add `startHeartbeat()`: `setInterval` calling `POST /api/register`
- When own server is the aggregator: add `/api/register`, `/api/projects`, `/`
  (project picker HTML) handlers
- Add registry map: `Map<string, {port, projectName, pin, lastSeen}>`
- Add cleanup interval

**`src/main/remote/index.ts` — aggregator HTML**
- Simple vanilla JS page, auto-refreshes project list every 10s via
  `GET /api/projects` (no WebSocket needed)
- Shows project name, link with embedded token, "Open" button

**`src/main/windows/remoteConnect.ts`**
- QR code always points to `http://{ip}:3847/` (aggregator picker)
- Even if this instance is not the aggregator, the QR still works as long as
  any AIDE instance is running

**No changes needed** to `ptyBridge.ts`, `auth.ts`, or renderer code — the
terminal session flow is unchanged once the user picks a project.

### Startup sequence diagram

```
AIDE-1 starts:
  listen(0) → port 51001
  POST 3847/api/register → ECONNREFUSED
  listen(3847) → SUCCESS → aggregator
  registry: [{port:51001, project:"AIDE", ...}]

AIDE-2 starts:
  listen(0) → port 51234
  POST 3847/api/register → 200 OK
  registry: [{51001,"AIDE"}, {51234,"MyApp"}]

AIDE-1 closes:
  port 3847 freed, port 51001 freed

AIDE-2 heartbeat fires:
  POST 3847/api/register → ECONNREFUSED
  listen(3847) → SUCCESS → AIDE-2 is now aggregator
  registry: [{51234,"MyApp"}]  ← only knows itself initially

AIDE-3 heartbeat fires (was registered with old aggregator):
  POST 3847/api/register → 200 OK (new aggregator)
  registry: [{51234,"MyApp"}, {51891,"Backend"}]
  ← fully converged, <10s after AIDE-1 died
```
