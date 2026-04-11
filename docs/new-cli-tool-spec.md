# Adding a New CLI Tool to AIDE

This document is a complete guide for implementing a new AI CLI Tool (e.g. Aider, Gemini CLI, Codex, etc.) from scratch. Following it, you can add support for any tool without modifying existing AIDE logic.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [CliTool Interface — Complete Reference](#2-clitool-interface--complete-reference)
3. [Minimal Implementation](#3-minimal-implementation)
4. [Session Storage on Disk](#4-session-storage-on-disk)
5. [Full Implementation — Every Method](#5-full-implementation--every-method)
6. [Registering the Tool](#6-registering-the-tool)
7. [Settings](#7-settings)
8. [Accounts](#8-accounts)
9. [Implementation Checklist](#9-implementation-checklist)

---

## 1. System Architecture

### How it works

Each CLI Tool is an object implementing the `CliTool` interface (`src/main/pty/cliTools/types.ts`). AIDE manages these objects through a single registry (`registry.ts`). Users activate tools via the UI (Tools → Manage CLI Tools), after which AIDE uses them to create PTY sessions in terminal tabs.

### New session lifecycle

```
User clicks "New Session"
    │
    ▼
PtyManager.createNewSessionTab(toolId)
    │
    ├─ tool.prepareProject(projectPath)   // one-time setup (if needed)
    │
    ├─ spawn PowerShell PTY
    │
    ├─ write tool.newSessionCommand()     // start the CLI in the PTY
    │
    ├─ tool.checkStartupHealth(output)    // monitor readiness
    │
    └─ tool.watchForNewSessions()         // wait for a session file on disk
           │
           └─ sessionId → tab.sessionId assigned
```

### Session resume lifecycle

```
Project opened, saved sessions exist
    │
    ▼
PtyManager.createInitialTabs(saved[])
    │
    └─ for each saved[i]:
         tool = getToolById(saved[i].toolId)
         │
         ├─ tool.prepareProject(projectPath)
         │
         ├─ spawn PowerShell PTY
         │
         └─ write tool.resumeCommand(saved[i].sessionId)
```

### File structure

```
src/main/pty/cliTools/
  types.ts              — CliTool interface, SettingsField, UsageInfo, HistoryEntry
  registry.ts           — tool registry, getDefaultTool()
  claudeCode.ts         — reference implementation (Claude Code)
  claudeCodeScanner.ts  — disk session scanner (Claude Code-specific)
  qwenCode.ts           — second reference implementation (Qwen Code)
  qwenCodeScanner.ts    — disk session scanner (Qwen Code-specific)
  plainShell.ts         — built-in fallback (plain terminal)
  cliLogger.ts          — logging utility

  yourTool.ts           ← NEW FILE (your implementation)
  yourToolScanner.ts    ← optional, if you need a separate parser file
```

Both `claudeCode.ts` and `qwenCode.ts` are complete reference implementations — read them before starting. They illustrate two distinct patterns: OAuth-based auth with cloud API usage tracking (Claude Code) and local file-based usage counting (Qwen Code).

---

## 2. CliTool Interface — Complete Reference

Full interface (`src/main/pty/cliTools/types.ts`):

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable machine identifier. Stored in `aide-state.json` and `.aide/settings.json`. **Never change after publishing.** Examples: `'aider'`, `'gemini-cli'` |
| `name` | `string` | Human-readable name shown in the UI. Examples: `'Aider'`, `'Gemini CLI'` |

### Required methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `isInstalled` | `() => Promise<boolean>` | Checks that the CLI binary is present on the system. Called when the user activates the tool in the UI. **Do not cache.** |
| `newSessionCommand` | `() => string` | Command written to PTY stdin to start a new session. Example: `'aider'`. |
| `resumeCommand` | `(sessionId: string) => string` | Command to resume an existing session by its ID. |
| `scanSessions` | `(projectPath: string) => Promise<CliSession[]>` | Scans disk and returns existing sessions for the project. Sort newest first. |
| `watchForNewSessions` | `(projectPath, onNew) => () => void` | Subscribes to new session files appearing on disk. Returns an unsubscribe function. |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `installUrl` | `string` | Link to installation instructions. Shown in CLI Tools Manager next to the Activate button. |

### Optional methods — startup and runtime

| Method | Signature | Description |
|--------|-----------|-------------|
| `prepareProject` | `(projectPath) => Promise<void>` | One-time setup before the first session. Example: write a config file so the CLI skips permission prompts. |
| `checkStartupHealth` | `(accumulated, elapsedMs) => 'ok' \| 'dead' \| 'pending'` | Inspects accumulated PTY output. Return `'ok'` when the CLI is ready, `'dead'` on a fatal error. |
| `getEnvOverrides` | `() => Record<string, string>` | Environment variables merged into the PTY environment at every spawn. |
| `resolveOwnerPid` | `(candidatePids: number[]) => Promise<number \| null>` | When multiple tabs exist, determines which PTY spawned the new session file. |
| `watchSessionLabel` | `(projectPath, sessionId, onLabel) => () => void` | Streams title updates for a running session. Returns unsubscribe. |
| `detectTitleEvent` | `(prevTitle, newTitle) => string \| null` | Returns an event name when an OSC title transition is notable. |
| `contextInsert` | `(relPath: string) => string \| null` | Returns the text to paste into the terminal when adding a file to AI context. If `null`, the menu item is hidden. |
| `getSessionPreview` | `(projectPath, sessionId) => Promise<[{role, text}]>` | Last few messages for the hover preview in Session Picker. |
| `getSessionHistory` | `(projectPath, sessionId) => Promise<HistoryEntry[]>` | Full conversation history for the History Viewer (☰ button in Session Picker). |
| `subscribeToSessionHistory` | `(projectPath, sessionId, onEntry) => () => void` | Live subscription to new history entries. |
| `getSessionFilePath` | `(projectPath, sessionId) => string \| null` | Path to the session data file. Used by `ThinkingWatcher`. |
| `parseThinkingBlocks` | `(line: string) => string[]` | Parses a JSONL line and returns thinking block texts. |

### Optional methods — settings

| Method | Signature | Description |
|--------|-----------|-------------|
| `settingsFields` | `() => SettingsField[]` | Field descriptors rendered in the Settings UI. |
| `getSettings` | `() => Promise<Record<string, unknown>>` | Loads current setting values. |
| `updateSettings` | `(values) => Promise<void>` | Persists updated setting values. |

### Optional methods — accounts

| Method | Signature | Description |
|--------|-----------|-------------|
| `isLoggedIn` | `() => Promise<boolean>` | Checks whether the user is authenticated. |
| `getLoginIdentifier` | `() => Promise<string \| null>` | Returns the email or username of the current user. |
| `exportCredentials` | `() => Promise<Record<string, unknown> \| null>` | Exports current credentials as a serialisable object. |
| `importCredentials` | `(credentials) => Promise<void>` | Restores previously exported credentials. |
| `clearCredentials` | `() => Promise<void>` | Deletes local credentials (does not revoke tokens server-side). |
| `getUsageInfo` | `() => Promise<UsageInfo \| null>` | Returns usage data for the status bar. |

---

## 3. Minimal Implementation

The minimum required set for a fully working tool — only mandatory members. Example for a hypothetical `mytool`:

```typescript
// src/main/pty/cliTools/myTool.ts
import { execFile } from 'child_process'
import type { CliTool, CliSession } from './types'

const TOOL_ID = 'my-tool'
const TOOL_NAME = 'My Tool'

export const myTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,

  installUrl: 'https://example.com/install',

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      // Use 'where' (Windows) to find the binary in PATH
      execFile('where', ['mytool'], { timeout: 3000 }, (err) => resolve(!err))
    })
  },

  newSessionCommand(): string {
    return 'mytool'
  },

  resumeCommand(sessionId: string): string {
    return `mytool --resume ${sessionId}`
  },

  async scanSessions(_projectPath: string): Promise<CliSession[]> {
    // If the tool does not store sessions on disk — return []
    return []
  },

  watchForNewSessions(_projectPath: string, _onNew: (session: CliSession) => void): () => void {
    // If sessions are not stored — return a no-op
    return () => {}
  }
}
```

After creating the file — **register** it in `registry.ts` (see [section 6](#6-registering-the-tool)).

---

## 4. Session Storage on Disk

Most CLIs store sessions as files. Below are implementation patterns for two scenarios.

### Scenario A: tool does NOT store sessions (stateless)

If the CLI has no concept of "sessions" or resumable conversations:

```typescript
async scanSessions(_projectPath: string): Promise<CliSession[]> {
  return []
},

watchForNewSessions(_projectPath, _onNew) {
  return () => {}
},

resumeCommand(_sessionId: string): string {
  // Ignore sessionId — always start fresh
  return 'mytool'
}
```

### Scenario B: tool stores sessions in files

Typical pattern: files at `~/.mytool/sessions/<sessionId>.json` or similar.

```typescript
import { existsSync, readdirSync, statSync, watch } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function getSessionsDir(projectPath: string): string {
  // Project-specific directory
  const encoded = projectPath.replace(/[:\\\/]/g, '-')
  return join(homedir(), '.mytool', 'sessions', encoded)
}

async scanSessions(projectPath: string): Promise<CliSession[]> {
  const dir = getSessionsDir(projectPath)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  const sessions: CliSession[] = []

  for (const file of files) {
    const filePath = join(dir, file)
    const stat = statSync(filePath)
    const sessionId = file.replace('.json', '')

    sessions.push({
      sessionId,
      slug: TOOL_NAME,           // fallback title until an OSC title arrives
      // firstMessage: '...',    // optional: first user message (line 1 in Session Picker)
      lastModified: stat.mtime
    })
  }

  // Sort: newest first
  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
},

watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
  const dir = getSessionsDir(projectPath)

  // Directory may not exist yet before the first session
  if (!existsSync(dir)) {
    // Return no-op; AIDE will call scanSessions again later
    return () => {}
  }

  const watcher = watch(dir, (event, filename) => {
    if (event !== 'rename' || !filename?.endsWith('.json')) return
    const filePath = join(dir, filename)
    if (!existsSync(filePath)) return // file was deleted, not created

    const sessionId = filename.replace('.json', '')
    onNew({
      sessionId,
      slug: TOOL_NAME,
      lastModified: new Date()
    })
  })

  return () => watcher.close()
}
```

### CliSession type

```typescript
interface CliSession {
  sessionId: string        // unique ID (passed to resumeCommand)
  slug: string             // initial tab title; for Claude Code — last user message
  summary?: string         // AI-generated title (optional)
  firstMessage?: string    // first user message in the session (optional)
  lastModified: Date       // used for sorting
}
```

#### Session Picker display

Session Picker renders each session in three lines:

| Line | Source | Description |
|------|--------|-------------|
| 1 (primary) | `firstMessage ?? slug` | First user message — identifies the session topic |
| 2 (small) | `slug` (if ≠ `firstMessage`) | Last user message — shows where you left off |
| 3 (smaller) | `toolName` | Name of the CLI tool for this session |

If `firstMessage` is not set, line 1 shows `slug` and line 2 is hidden.

---

## 5. Full Implementation — Every Method

### `prepareProject`

Called **once** before the first session for a project (and again on session resume). Used to:
- Write a config file so the CLI skips confirmation dialogs
- Create required directories

```typescript
async prepareProject(projectPath: string): Promise<void> {
  const configPath = join(homedir(), '.mytool', 'trustedProjects.json')
  let config: Record<string, boolean> = {}

  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  }

  if (config[projectPath] !== true) {
    config[projectPath] = true
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }
}
```

### `checkStartupHealth`

Inspects accumulated PTY output. AIDE calls this method periodically while the status is `'pending'`.

```typescript
checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
  // Detect fatal error from output
  if (accumulated.includes('command not found')) return 'dead'
  if (accumulated.includes('Error: ')) return 'dead'

  // Detect readiness from output
  if (accumulated.includes('> ')) return 'ok'          // prompt appeared
  if (accumulated.includes('My Tool v')) return 'ok'   // banner parsed

  // Timeout — assume ready after 15 seconds
  if (elapsedMs > 15000) return 'ok'

  return 'pending'
}
```

**Important:** Return `'dead'` only on clear error signals. When in doubt, return `'pending'` until the timeout.

### `getEnvOverrides`

Returns environment variables merged into the PTY environment at every spawn.

```typescript
getEnvOverrides(): Record<string, string> {
  const proxy = getToolConfig(TOOL_ID).proxy as string
  if (!proxy) return {}
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy
  }
}
```

### `resolveOwnerPid`

Only needed when multiple tabs can simultaneously wait for a new session. Determines which PTY process spawned the new session file.

```typescript
async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
  if (candidatePids.length === 0) return null

  const json = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command',
       'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { timeout: 5000 },
      (err, stdout) => err ? reject(err) : resolve(stdout.trim())
    )
  })

  const parsed = JSON.parse(json)
  const allProcs: Array<{ ProcessId: number; ParentProcessId: number; Name: string }> =
    Array.isArray(parsed) ? parsed : [parsed]

  const parentMap = new Map(allProcs.map(p => [p.ProcessId, p.ParentProcessId]))
  const pidSet = new Set(candidatePids)

  const findAncestor = (startPid: number): number | null => {
    let pid = startPid
    const visited = new Set<number>()
    while (pid && !visited.has(pid)) {
      if (pidSet.has(pid)) return pid
      visited.add(pid)
      pid = parentMap.get(pid) ?? 0
    }
    return null
  }

  const matches: Array<{ pid: number; ancestor: number }> = []
  for (const proc of allProcs) {
    if (!(proc.Name ?? '').toLowerCase().startsWith('mytool')) continue
    const ancestor = findAncestor(proc.ParentProcessId)
    if (ancestor !== null) matches.push({ pid: proc.ProcessId, ancestor })
  }

  if (matches.length === 0) return null

  // Pick the highest PID (most recently started) so each new session file
  // is matched to the tab that just launched it.
  matches.sort((a, b) => b.pid - a.pid)
  return matches[0].ancestor
}
```

### `detectTitleEvent`

Called on every OSC title change. Used for sound notifications and completion indicators.

```typescript
detectTitleEvent(prevTitle: string | null, newTitle: string): string | null {
  // prevTitle === null means first assignment at startup — ignore
  if (prevTitle === null) return null

  // Example: tool shows "✓ Ready" when it finishes
  if (!prevTitle.startsWith('✓') && newTitle.startsWith('✓')) {
    return 'completeAndWait'   // standard event name — triggers toolbar sound
  }
  return null
}
```

**Standard event names:** `'completeAndWait'` triggers the toolbar completion sound. Any other string is logged but not handled specially.

### `contextInsert`

Returns the text to paste into the terminal when the user picks "Add to context" from the file tree.

```typescript
contextInsert(relPath: string): string | null {
  // Claude Code: "@src/file.ts"
  // Aider:       "/add src/file.ts"
  // Return null if the tool does not support this — the menu item is hidden
  return `/add ${relPath}`
}
```

### `getSessionPreview`

Returns the last few messages for the hover preview in Session Picker.

```typescript
async getSessionPreview(
  projectPath: string,
  sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const filePath = join(getSessionsDir(projectPath), `${sessionId}.json`)
  if (!existsSync(filePath)) return []

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    return (data.messages ?? []).slice(-3).map((m: { role: string; content: string }) => ({
      role: m.role as 'user' | 'assistant',
      text: m.content.slice(0, 200)
    }))
  } catch {
    return []
  }
}
```

### `getSessionHistory`

Returns the **full conversation history** for the History Viewer — a separate window opened via ☰ in Session Picker.

Difference from `getSessionPreview`: preview reads the last ~64 KB for a quick hover card; history reads the entire file and returns structured blocks supporting `tool_use`, `tool_result`, and `thinking`.

```typescript
async getSessionHistory(
  projectPath: string,
  sessionId: string
): Promise<HistoryEntry[]> {
  // HistoryEntry = { role: 'user' | 'assistant'; blocks: HistoryBlock[] }
  // HistoryBlock = text | tool_use | tool_result | thinking
  return readSessionHistory(getSessionsDir(projectPath), sessionId)
}
```

If the tool does not support history viewing — simply omit this method. The ☰ button will still appear, but History Viewer will open empty.

**Architecture:** each tool implements its own JSONL parser in a separate file (`claudeCodeScanner.ts`, `qwenCodeScanner.ts`). History Viewer delegates file reading to the tool via `subscribeToSessionHistory`, making the system tool-agnostic.

### `getSessionFilePath`

Path to the session file. Used by `ThinkingWatcher` to track AI thinking state.

```typescript
getSessionFilePath(projectPath: string, sessionId: string): string | null {
  return join(getSessionsDir(projectPath), `${sessionId}.jsonl`)
  // Return null if the tool does not use file-based storage
}
```

### `subscribeToSessionHistory`

Live subscription to new history entries. Called by History Viewer after `did-finish-load` to avoid race conditions with IPC listeners.

```typescript
subscribeToSessionHistory(
  projectPath: string,
  sessionId: string,
  onEntry: (entry: HistoryEntry) => void
): () => void {
  const filePath = join(getSessionsDir(projectPath), `${sessionId}.jsonl`)
  if (!existsSync(filePath)) return () => {}

  let stopped = false
  let watcher: FSWatcher | null = null

  // Track file size to read only new data
  let offset = 0
  try {
    const fd = openSync(filePath, 'r')
    offset = fstatSync(fd).size
    closeSync(fd)
  } catch { /* ignore */ }

  const readNewEntries = () => {
    if (stopped || !existsSync(filePath)) return

    let fd: number
    try {
      fd = openSync(filePath, 'r')
    } catch {
      return
    }

    try {
      const fileSize = fstatSync(fd)
      if (fileSize.size <= offset) return

      const len = fileSize.size - offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, offset)
      offset = fileSize.size

      const text = buf.toString('utf-8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const entry = parseHistoryLine(trimmed)  // tool-specific parser
        if (entry && !stopped) onEntry(entry)
      }
    } finally {
      closeSync(fd)
    }
  }

  try {
    watcher = watch(filePath, () => readNewEntries())
  } catch { /* ignore */ }

  return () => {
    stopped = true
    watcher?.close()
  }
}
```

**Notes:**
- Use offset-based reading to avoid duplicating already-read entries
- Return a cleanup function that sets `stopped = true` and closes the watcher
- Call `onEntry` for each new entry — History Viewer appends them to the UI
- If the tool does not support live updates — simply omit this method

### `parseThinkingBlocks`

Parses a single JSONL line and returns an array of thinking block texts. Each tool knows its own data format.

**For Claude Code** (format: `message.content[]` with `type: 'thinking'`):

```typescript
parseThinkingBlocks(line: string): string[] {
  try {
    const obj = JSON.parse(line)
    if (obj.type !== 'assistant') return []
    const content = obj?.message?.content
    if (!Array.isArray(content)) return []
    return content
      .filter((b: unknown) =>
        typeof b === 'object' && b !== null &&
        (b as { type?: string }).type === 'thinking' &&
        typeof (b as { thinking?: unknown }).thinking === 'string' &&
        (b as { thinking: string }).thinking.length > 0
      )
      .map((b: unknown) => (b as { thinking: string }).thinking)
  } catch {
    return []
  }
}
```

**For Qwen Code** (format: `message.parts[]` with `thought: true`):

```typescript
parseThinkingBlocks(line: string): string[] {
  try {
    const obj = JSON.parse(line)
    if (obj.type !== 'user' && obj.type !== 'assistant') return []
    const parts = obj?.message?.parts
    if (!Array.isArray(parts)) return []
    return parts
      .filter((p: unknown) =>
        typeof p === 'object' && p !== null &&
        (p as { thought?: boolean }).thought === true &&
        typeof (p as { text?: string }).text === 'string' &&
        (p as { text: string }).text.length > 0
      )
      .map((p: unknown) => (p as { text: string }).text)
  } catch {
    return []
  }
}
```

**How it is used:** `ThinkingWatcher` calls this method when reading new lines from the session file. If the method is not implemented — thinking blocks will not be displayed, but nothing else breaks.

---

## 6. Registering the Tool

The only place where the new tool needs to be registered:

**`src/main/pty/cliTools/registry.ts`**

```typescript
import type { CliTool } from './types'
import { claudeCodeTool } from './claudeCode'
import { qwenCodeTool } from './qwenCode'
import { myTool } from './myTool'           // ← add import
import { plainShellTool } from './plainShell'

/** AI CLI tools that users can activate (shown in settings, require install). */
const cliToolRegistry: CliTool[] = [
  claudeCodeTool,
  qwenCodeTool,
  myTool,           // ← add to array
]

/** Always-available built-in tools (not user-activatable, used as fallback). */
const builtinTools: CliTool[] = [plainShellTool]

export function getRegisteredTools(): CliTool[] {
  return cliToolRegistry
}

export function getToolById(id: string): CliTool | undefined {
  return [...cliToolRegistry, ...builtinTools].find((t) => t.id === id)
}

export function getDefaultTool(activatedTools: string[]): CliTool {
  const first = cliToolRegistry.find((t) => activatedTools.includes(t.id))
  return first ?? plainShellTool
}
```

After registering, the tool appears in CLI Tools Manager (Tools → Manage CLI Tools) and becomes available for activation.

---

## 7. Settings

If the tool has configurable parameters, implement three methods: `settingsFields`, `getSettings`, `updateSettings`. AIDE will render a section in the Settings UI automatically.

### Storage

Use the built-in tool configuration system:

```typescript
// src/main/config/appConfig.ts — already exists
import { getToolConfig, updateToolConfig } from '../../config/appConfig'

const TOOL_ID = 'my-tool'

async getSettings(): Promise<Record<string, unknown>> {
  return getToolConfig(TOOL_ID)
  // Data is stored in aide-config.json (Electron userData) under tools['my-tool']
},

async updateSettings(values: Record<string, unknown>): Promise<void> {
  updateToolConfig(TOOL_ID, values)
}
```

### Field descriptors

```typescript
import type { SettingsField } from './types'

settingsFields(): SettingsField[] {
  return [
    {
      key: 'apiKey',
      label: 'API Key',
      description: 'Your My Tool API key from https://example.com/settings',
      type: 'password',          // hides the value in the UI
    },
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      options: [
        { value: 'model-fast', label: 'Fast (cheaper)' },
        { value: 'model-smart', label: 'Smart (more capable)' },
      ],
      default: 'model-fast'
    },
    {
      key: 'proxy',
      label: 'Proxy address',
      description: 'Leave empty to use no proxy (e.g. http://127.0.0.1:1080)',
      type: 'string',
      default: ''
    },
    {
      key: 'verbose',
      label: 'Verbose output',
      type: 'boolean',
      default: false
    },
    {
      key: 'maxTokens',
      label: 'Max tokens',
      type: 'number',
      default: 4096,
      // Only show this field when model is 'model-smart'
      visibleWhen: { key: 'model', value: 'model-smart' }
    }
  ]
}
```

### Field types (`SettingsField.type`)

| Type | Rendered as | Notes |
|------|-------------|-------|
| `'string'` | Text input | |
| `'password'` | Password input | Value is masked |
| `'boolean'` | Checkbox | |
| `'number'` | Number input | |
| `'select'` | Dropdown | Requires `options` |

### `visibleWhen`

The optional `visibleWhen` property conditionally shows a field based on another field's value:

```typescript
{
  key: 'advancedOption',
  label: 'Advanced option',
  type: 'string',
  visibleWhen: { key: 'mode', value: 'advanced' }
  // This field is only rendered when the 'mode' field equals 'advanced'
}
```

### Using settings in `getEnvOverrides`

```typescript
getEnvOverrides(): Record<string, string> {
  const config = getToolConfig(TOOL_ID)
  const env: Record<string, string> = {}

  const apiKey = config.apiKey as string
  if (apiKey) env['MYTOOL_API_KEY'] = apiKey

  const proxy = config.proxy as string
  if (proxy) {
    env['HTTP_PROXY'] = proxy
    env['HTTPS_PROXY'] = proxy
  }

  return env
}
```

---

## 8. Accounts

If the tool uses authentication, implement the accounts method group. They are displayed in Settings → Accounts.

### Minimum set

For basic auth status display:

```typescript
async isLoggedIn(): Promise<boolean> {
  const configPath = join(homedir(), '.mytool', 'auth.json')
  if (!existsSync(configPath)) return false
  try {
    const auth = JSON.parse(readFileSync(configPath, 'utf-8'))
    return !!auth.token
  } catch {
    return false
  }
},

async getLoginIdentifier(): Promise<string | null> {
  const configPath = join(homedir(), '.mytool', 'auth.json')
  if (!existsSync(configPath)) return null
  try {
    const auth = JSON.parse(readFileSync(configPath, 'utf-8'))
    return auth.email ?? auth.username ?? null
  } catch {
    return null
  }
}
```

### Full implementation with account switching

AIDE supports saving multiple accounts. Three methods are required:

```typescript
/** Keys from auth.json to persist as credentials */
const CREDENTIAL_KEYS = ['token', 'email', 'userId'] as const
const AUTH_PATH = join(homedir(), '.mytool', 'auth.json')

async exportCredentials(): Promise<Record<string, unknown> | null> {
  if (!existsSync(AUTH_PATH)) return null
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
    if (!auth.token) return null
    const creds: Record<string, unknown> = {}
    for (const key of CREDENTIAL_KEYS) {
      if (auth[key] !== undefined) creds[key] = auth[key]
    }
    return creds
  } catch {
    return null
  }
},

async importCredentials(credentials: Record<string, unknown>): Promise<void> {
  let auth: Record<string, unknown> = {}
  if (existsSync(AUTH_PATH)) {
    try { auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8')) } catch {}
  }
  for (const key of CREDENTIAL_KEYS) {
    if (credentials[key] !== undefined) auth[key] = credentials[key]
  }
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), 'utf-8')
},

async clearCredentials(): Promise<void> {
  if (!existsSync(AUTH_PATH)) return
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
    for (const key of CREDENTIAL_KEYS) delete auth[key]
    writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), 'utf-8')
  } catch {}
}
```

### Usage info (status bar)

If the tool exposes an API for usage information:

```typescript
async getUsageInfo(): Promise<UsageInfo | null> {
  const configPath = join(homedir(), '.mytool', 'auth.json')
  if (!existsSync(configPath)) return null

  try {
    const auth = JSON.parse(readFileSync(configPath, 'utf-8'))
    const res = await fetch('https://api.example.com/usage', {
      headers: { Authorization: `Bearer ${auth.token}` }
    })
    if (!res.ok) return null

    const data = await res.json() as { used: number; limit: number }
    const percent = Math.round((data.used / data.limit) * 100)
    const level: UsageInfo['level'] = percent >= 90 ? 'critical' : percent >= 70 ? 'warn' : 'normal'

    return {
      summary: `${percent}%`,
      tooltip: `Used: ${data.used} / ${data.limit}`,
      level,
      fetchedAt: Date.now()
    }
  } catch {
    return null
  }
}
```

**Recommendation:** add caching (similar to `claudeCode.ts`) and backoff on 429 errors — this method is called frequently. See `claudeCode.ts` for a complete caching + backoff implementation using a local JSON file and `Electron.session` for proxy-aware requests.

---

## 9. Implementation Checklist

### Required minimum

- [ ] Created `src/main/pty/cliTools/yourTool.ts`
- [ ] Implemented all required members: `id`, `name`, `isInstalled`, `newSessionCommand`, `resumeCommand`, `scanSessions`, `watchForNewSessions`
- [ ] Tool added to `cliToolRegistry` in `registry.ts`
- [ ] `npm run typecheck` passes with no errors

### Recommended

- [ ] Added `installUrl` — link to installation instructions
- [ ] Implemented `checkStartupHealth` — so AIDE knows when the CLI is ready
- [ ] Implemented `prepareProject` — if the CLI requires confirmations on first run
- [ ] Implemented `contextInsert` — for adding files to context via right-click

### For tools with sessions on disk

- [ ] `scanSessions` returns real data
- [ ] `watchForNewSessions` reacts to new files appearing
- [ ] `resumeCommand` correctly builds the command from `sessionId`
- [ ] `getSessionFilePath` returns the path to the file (for `ThinkingWatcher`)

### For tools with history viewing

- [ ] Implemented `getSessionHistory` — returns full `HistoryEntry[]`
- [ ] Implemented `subscribeToSessionHistory` — for live updates in History Viewer
- [ ] Created a separate scanner file (e.g. `yourToolScanner.ts`) with JSONL parsers
- [ ] Implemented `parseThinkingBlocks` — for thinking display in ThinkingWatcher
- [ ] `HistoryEntry` includes all block types: `text`, `thinking`, `tool_use`, `tool_result`

### For tools with settings

- [ ] Implemented `settingsFields`, `getSettings`, `updateSettings`
- [ ] Settings are used in `getEnvOverrides` or `prepareProject`
- [ ] Used `visibleWhen` where fields depend on each other

### For tools with authentication

- [ ] Implemented `isLoggedIn`, `getLoginIdentifier`
- [ ] Implemented `exportCredentials`, `importCredentials`, `clearCredentials` (for account switching)
- [ ] Implemented `getUsageInfo` with caching and 429 backoff
