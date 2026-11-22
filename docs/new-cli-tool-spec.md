# Adding a New CLI Tool to AIDE

This document is a complete guide for implementing a new AI CLI Tool (e.g. Antigravity, Aider, Gemini CLI, Codex, etc.) in AIDE. Following it, you can integrate both interactive terminal sessions and all AIDE capabilities (AIDE's MCP server, deterministic hook binding, history/thinking/remote viewers, accounts & account pool, and headless pipeline/plan execution).

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [CliTool Interface — Complete Reference](#2-clitool-interface--complete-reference)
3. [Minimal Implementation](#3-minimal-implementation)
4. [Session Storage on Disk & SQLite](#4-session-storage-on-disk--sqlite)
5. [Full Implementation — Every Method](#5-full-implementation--every-method)
6. [Headless Execution (Pipelines & Plans)](#6-headless-execution-pipelines--plans)
7. [Registering the Tool & Touchpoints](#7-registering-the-tool--touchpoints)
8. [Settings](#8-settings)
9. [Accounts, Usage & Pipeline Account Pool](#9-accounts-usage--pipeline-account-pool)
10. [Implementation Checklist](#10-implementation-checklist)

---

## 1. System Architecture

### How it works

Each CLI Tool is an object implementing the `CliTool` interface (`src/main/pty/cliTools/types.ts`). AIDE manages tools through a single registry (`src/main/pty/cliTools/registry.ts`). Users activate tools via **Tools → Manage CLI Tools**, after which AIDE uses them for:

- **Interactive PTY tabs** (`PtyManager`) — new sessions, resuming saved sessions, prompt injection, file context insertion, completion signals, and Strategist event relay.
- **Session Picker, History Viewer, Thinking Panel, and Remote Access** — scanning sessions, previews, full structured transcripts with CLI-neutral `ToolView`, live updates, and reasoning blocks.
- **AIDE's MCP server (`aide`)** — injected per launch via `prepareLaunch` so agents in tabs can drive plans, pipelines, the task tracker, and the file viewer without mutating CLI configs.
- **Accounts & Pipeline Account Pool** — saving/switching credentials, status bar usage display, and automatic account rotation on pipeline usage limits.
- **Headless execution** (`CliTool.headless`) — non-interactive pipeline steps and plan Orchestrator calls.

### New session lifecycle

```
User clicks "New Session"
    │
    ▼
PtyManager.createNewSessionTab(toolId)
    │
    ├─ tool.prepareProject(projectPath)            // one-time setup (e.g. trust config)
    │
    ├─ tool.prepareLaunch(ctx)                     // per-launch args/env: hooks (ctx.hook) + AIDE MCP (ctx.mcpServers)
    │
    ├─ tool.registerSignalHandler(tabId, handler)  // wire 'completeAndWait' → tabActivity.markIdle + UI sound
    │
    ├─ spawn shell PTY via defaultShell(command)   // env: AIDE_TAB_ID, PWD, getEnvOverrides(), prepareLaunch.env
    │                                              // command: newSessionCommand() + prepareLaunch.args
    ├─ tool.checkStartupHealth(accumulated)        // monitor readiness ('ok' | 'dead' | 'pending')
    │
    ├─ tool.onPtyActivity(tabId)                   // called on every PTY data chunk
    │
    └─ session binding:
         ├─ HookServer POST /hook (deterministic, via prepareLaunch ctx.hook)
         └─ OR tool.watchForNewSessions() (sole waiting tab fast path)
                │
                └─ sessionId → tab.sessionId assigned → ThinkingWatcher.startWatching(...)
```

### Session resume lifecycle

```
Project opened (saved sessions exist) or user picks a session in Session Picker
    │
    ▼
PtyManager.createInitialTabs / resumeSessionTab
    │
    └─ for each entry:
         tool = getToolById(entry.toolId)
         │
         ├─ tool.prepareProject(projectPath)
         │
         ├─ tool.prepareLaunch(ctx)                // hooks + AIDE MCP also injected on resume
         │
         ├─ spawn shell PTY with resumeCommand(sessionId) + prepareLaunch.args
         │
         ├─ onSessionAssigned(tabId, sessionId, tool)
         │
         └─ tool.checkStartupHealth(accumulated)   // if 'dead' on restore, closes tab (or opens fresh tab if all dead)
```

On tab close or window dispose, `PtyManager` calls `tool.deregisterTab?.(tabId)` and unregisters the tab from `HookServer` and `tabActivity`.

### File structure

```
src/main/pty/cliTools/
  types.ts                    — CliTool, CliSession, LaunchContext, LaunchMcpServer, ToolView, HistoryEntry, UsageInfo
  registry.ts                 — cliToolRegistry, getRegisteredTools(), getToolById(), getDefaultTool()
  launchFiles.ts              — tabLaunchPath(), writeLaunchFile(), removeLaunchPath(), shellLiteral()
  startupHealth.ts            — tuiReadyForInput() helper for full-screen ConPTY TUIs
  toolViews.ts                — per-CLI native tool call → neutral ToolView mappers
  sessionMetaCache.ts         — persistent mtime/size-validated transcript metadata cache
  cliLogger.ts                — logging utility (routes to Log Panel UI)
  plainShell.ts               — built-in fallback (plain terminal)

  claudeCode.ts / claudeCodeScanner.ts / claudeHooks.ts
  codex.ts / codexScanner.ts / codexUsage.ts
  cursorAgent.ts / cursorAgentScanner.ts / cursorAgentStoreScanner.ts
  devin.ts / devinScanner.ts / devinHooks.ts / devinMcp.ts
  openCode.ts / openCodeScanner.ts / openCodeAuth.ts / openCodeParts.ts
  qwenCode.ts / qwenCodeScanner.ts (legacy)

  yourTool.ts                 ← NEW FILE (your implementation)
  yourToolScanner.ts          ← optional, separate session/history parser

src/main/pipeline/headless/
  types.ts                    — HeadlessCapability, HeadlessRunOptions, HeadlessResult, ResultTool
  index.ts                    — startHeadless(tool, options)
  common.ts                   — resolveExecutable(), classifyFailure(), processError(), promptWithRoleAndSchema(), parseFinalJson()
  claudeHeadless.ts / codexHeadless.ts / cursorHeadless.ts / devinHeadless.ts / openCodeHeadless.ts

  yourToolHeadless.ts         ← NEW FILE (if the CLI supports headless execution)
  yourTool.live.test.ts       ← optional opt-in live test (AIDE_LIVE_<TOOL>=1)
```

Reference implementations illustrate the main patterns:
- **Claude Code** (`claudeCode.ts`, `claudeHeadless.ts`) — JSONL sessions, per-tab `--settings` hooks + `--mcp-config`, OSC title `✳` completion signal, OAuth account switching (`accountSwitchNeedsRestart() → false`), shared SQLite usage cache, native headless `--json-schema`.
- **Codex** (`codex.ts`, `codexHeadless.ts`) — global flat JSONL directory with `sessionMetaCache.ts`, `-c` TOML MCP overrides via `shellLiteral()`, `tuiReadyForInput`, shared app-server daemon handling on account switch, headless `--output-schema` with strict schemas.
- **OpenCode 2** (`openCode.ts`, `openCodeHeadless.ts`) — `installProblem()` version gate (requires 2.x), SQLite session storage, `OPENCODE_CONFIG_CONTENT` env-based MCP injection, PTY inactivity completion timer, `refreshAccountState()` / `accountHint()`, headless `ResultTool` (`submit_result` MCP endpoint).
- **Cursor Agent** (`cursorAgent.ts`, `cursorHeadless.ts`) — SQLite `store.db` + JSONL fallback, per-tab `--plugin-dir` MCP injection, isolated `CURSOR_CONFIG_DIR` per permission profile with shared `chats` junction for headless.
- **Devin** (`devin.ts`, `devinHeadless.ts`) — read-only SQLite scanning (`sessions.db`), Claude-format hooks via merged `--config`, project-local `.devin/mcp_config.local.json` MCP fallback (with `.git/info/exclude`), ATIF export in headless mode.

---

## 2. CliTool Interface — Complete Reference

Full interface in `src/main/pty/cliTools/types.ts`:

### Required fields & methods

| Member | Signature / Type | Description |
|--------|------------------|-------------|
| `id` | `readonly string` | Stable machine identifier. Stored in `aide-state.json`, project settings, account storage, and pipeline definitions. **Never change after publishing.** Examples: `'antigravity'`, `'claude-code'`, `'codex'`. |
| `name` | `readonly string` | Human-readable name shown in the UI. Examples: `'Google Antigravity'`, `'Claude Code'`. |
| `isInstalled` | `() => Promise<boolean>` | Checks that the CLI binary is present and usable. Called when activating the tool. **Do not cache.** Prefer `findExecutable()` from `src/main/platform`. |
| `newSessionCommand` | `() => string` | Shell command passed to `defaultShell(command)` to start a new session. |
| `resumeCommand` | `(sessionId: string) => string` | Shell command to resume an existing session by its ID. Validate/quote `sessionId` defensively. |
| `scanSessions` | `(projectPath: string) => Promise<CliSession[]>` | Scans disk/DB and returns existing sessions for the project, sorted newest first. |
| `watchForNewSessions` | `(projectPath, onNew) => () => void` | Watches for new sessions appearing for the project. Returns an unsubscribe function. |
| `hasAccountSystem` | `() => boolean` | **Required.** Return `false` only when the CLI has its own built-in account switching or credential management is technically impossible. Return `true` otherwise. See [section 9](#9-accounts-usage--pipeline-account-pool). |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `installUrl` | `readonly string` | Link to installation instructions. Shown in CLI Tools Manager. |
| `aideMcp` | `readonly { supported: boolean; note?: string }` | Declares whether the CLI accepts AIDE's MCP server via `prepareLaunch`. Automatically adds the per-CLI setting *Give AIDE's MCP server to this CLI* (on by default; disabled with `note` when `supported: false`). See [`prepareLaunch`](#preparelaunch-and-aidemcp). |
| `headless` | `readonly HeadlessCapability` | Non-interactive execution adapter for pipeline nodes and plan Orchestrator calls. See [section 6](#6-headless-execution-pipelines--plans). |

### Optional methods — installation, launch & startup

| Method | Signature | Description |
|--------|-----------|-------------|
| `installProblem` | `() => Promise<string \| null>` | Returns a human-readable reason why the CLI cannot be used (e.g. unsupported version), or `null` when usable. Used by CLI Tools Manager and `pipeline_smoke`; without it, a false `isInstalled()` reports `"Not found in PATH"`. |
| `prepareProject` | `(projectPath: string) => Promise<void>` | One-time setup before starting/resuming sessions (e.g. marking workspace trusted to skip confirmation prompts). |
| `prepareLaunch` | `(ctx: LaunchContext) => LaunchAdditions` | Returns extra `{ args?, env? }` for each launch: hook server wiring (`ctx.hook`) and AIDE's MCP servers (`ctx.mcpServers`). Called before every new and resumed tab spawn. |
| `getEnvOverrides` | `() => Record<string, string>` | Synchronous env vars merged into both PTY shells and headless runs (e.g. proxy + `NO_PROXY`). Reads in-memory config only. |
| `checkStartupHealth` | `(accumulated: string) => 'ok' \| 'dead' \| 'pending'` | Inspects accumulated PTY output. Return `'ok'` when ready for input, `'dead'` on fatal/invalid-session error, `'pending'` otherwise. **Never decide by elapsed time.** |
| `interactiveSubmitSequence` | `() => string` | Terminal key sequence sent to submit a pasted prompt (default `'\r'`). Used by prompt injection, File Viewer Send, and Pipeline `EventRelay`. |
| `exitCommand` | `() => string` | Optional convention for the interactive command that exits the CLI (e.g. `'/exit'`). Currently has no core caller. |

### Optional methods — runtime signals, activity & tab lifecycle

| Method | Signature | Description |
|--------|-----------|-------------|
| `registerSignalHandler` | `(tabId: string, handler: (event: string) => void) => void` | Called by `PtyManager` on spawn. Store the callback to emit tab events (notably `'completeAndWait'`, which triggers completion sounds and marks the tab idle for Pipeline `EventRelay`). |
| `onHookEvent` | `(binding: HookBinding) => string \| void` | Optional callback invoked when `HookServer` receives a POST for a tab of this tool (alongside session/transcript binding). Returning a string sends it as the HTTP 200 response body (used e.g. by Antigravity's `title.command` hook). |
| `detectTitleEvent` | `(tabId: string, prevTitle: string \| null, newTitle: string) => void` | Called on every OSC title change. Emit events via the registered signal handler. |
| `onPtyActivity` | `(tabId: string) => void` | Called on every PTY data chunk. Used by CLIs without idle OSC titles to run an inactivity timer that emits `'completeAndWait'`. |
| `deregisterTab` | `(tabId: string) => void` | Called when a PTY tab closes or disposes. Clean up signal handlers, inactivity timers, and per-tab launch files. |
| `contextInsert` | `(relPath: string) => string \| null` | Text pasted into the terminal for "Add to context" (desktop file tree and Remote Access). Return `null` to hide the menu item. |

### Optional methods — sessions, history & thinking

| Method | Signature | Description |
|--------|-----------|-------------|
| `getSessionPreview` | `(projectPath, sessionId) => Promise<Array<{ role: 'user' \| 'assistant'; text: string }>>` | Last few messages for the Session Picker hover preview. |
| `getSessionHistory` | `(projectPath, sessionId) => Promise<HistoryEntry[]>` | Full conversation history for History Viewer, Remote Access, and history-based Thinking Panel. |
| `subscribeToSessionHistory` | `(projectPath, sessionId, onEntry) => () => void` | Live subscription to new `HistoryEntry` items (used by History Viewer, Remote Access, and history-based Thinking Panel). |
| `getSessionFilePath` | `(projectPath, sessionId) => string \| null` | Path to an appendable session file for file-based `ThinkingWatcher`. Return `null` for DB-backed or non-appendable stores. |
| `parseThinkingBlocks` | `(line: string) => string[]` | Parses one JSONL line from `getSessionFilePath()` and returns thinking block texts. |
| `watchSessionLabel` | `(projectPath, sessionId, onLabel) => () => void` | Optional stream of title updates for a running session. Currently has no core caller. |
| `resolveOwnerPid` | `(candidatePids: number[]) => Promise<number \| null>` | **Legacy / optional.** No longer called by `PtyManager.assignNewSession` (replaced by deterministic hooks). |

### Optional methods — settings

| Method | Signature | Description |
|--------|-----------|-------------|
| `settingsFields` | `() => SettingsField[]` | Per-tool field descriptors rendered in Settings → CLI Settings. |
| `getSettings` | `() => Promise<Record<string, unknown>>` | Loads current tool setting values. |
| `updateSettings` | `(values: Record<string, unknown>) => Promise<void>` | Persists updated tool setting values. |

### Optional methods — accounts & usage

| Method | Signature | Description |
|--------|-----------|-------------|
| `isLoggedIn` | `() => Promise<boolean>` | Whether the user is currently authenticated. |
| `getLoginIdentifier` | `() => Promise<string \| null>` | Current account email, username, or label (shown in Account Manager, Settings, and status bar). |
| `exportCredentials` | `() => Promise<Record<string, unknown> \| null>` | Exports current credentials as a serialisable object. |
| `importCredentials` | `(credentials: Record<string, unknown>) => Promise<void>` | Restores previously exported credentials. |
| `clearCredentials` | `() => Promise<void>` | Clears local credentials without revoking tokens server-side. |
| `accountHint` | `() => Promise<string \| null>` | Optional note shown in Account Manager explaining edge cases (e.g. why there is nothing to save even though the CLI works). |
| `refreshAccountState` | `() => Promise<void>` | Refreshes cached/derived account state when Account Manager displays the tool. |
| `accountSwitchNeedsRestart` | `() => boolean` | Whether open PTY tabs must be restarted after `importCredentials`/`clearCredentials`. Defaults to `true` when omitted; return `false` if live sessions re-read credentials on their own. |
| `getUsageInfo` | `(cacheMaxAgeMs?: number) => Promise<UsageInfo \| null>` | Returns quota/usage data for the desktop status bar and Remote Access. |

---

## 3. Minimal Implementation

The minimum compilable set of required members for a working interactive tool:

```typescript
// src/main/pty/cliTools/myTool.ts
import { findExecutable } from '../../platform'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import type { CliTool, CliSession, SettingsField } from './types'

const TOOL_ID = 'my-tool'
const TOOL_NAME = 'My Tool'

export const myTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,
  installUrl: 'https://example.com/install',

  async isInstalled(): Promise<boolean> {
    return findExecutable('mytool')
  },

  newSessionCommand(): string {
    return 'mytool'
  },

  resumeCommand(sessionId: string): string {
    if (!sessionId || /[^a-zA-Z0-9_-]/.test(sessionId)) {
      throw new Error('Invalid session ID')
    }
    return `mytool --resume ${sessionId}`
  },

  async scanSessions(_projectPath: string): Promise<CliSession[]> {
    return []
  },

  watchForNewSessions(_projectPath: string, _onNew: (session: CliSession) => void): () => void {
    return () => {}
  },

  hasAccountSystem(): boolean {
    return false
  },

  settingsFields(): SettingsField[] {
    return [
      {
        key: 'proxy',
        label: 'Proxy address',
        description: 'Leave empty to use no proxy (e.g. http://127.0.0.1:1080)',
        type: 'string',
        default: ''
      }
    ]
  },

  async getSettings(): Promise<Record<string, unknown>> {
    return getToolConfig(TOOL_ID)
  },

  async updateSettings(values: Record<string, unknown>): Promise<void> {
    updateToolConfig(TOOL_ID, values)
  },

  getEnvOverrides(): Record<string, string> {
    const proxy = ((getToolConfig(TOOL_ID).proxy as string) ?? '').trim()
    if (!proxy) return {}
    const bypass = 'localhost,127.0.0.1,::1'
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: bypass,
      no_proxy: bypass
    }
  }
}
```

Then register `myTool` in `src/main/pty/cliTools/registry.ts` (see [section 7](#7-registering-the-tool--touchpoints)).

> **Windows PATH note:** If a CLI installs to a known per-user folder (e.g. `%LOCALAPPDATA%\<tool>\bin\...`), check that path directly in addition to `findExecutable()` so a running AIDE instance finds newly installed binaries without restarting.

---

## 4. Session Storage on Disk & SQLite

### Scenario A: tool does NOT expose sessions on disk

```typescript
async scanSessions(_projectPath: string): Promise<CliSession[]> {
  return []
},

watchForNewSessions(_projectPath, _onNew) {
  return () => {}
},

resumeCommand(_sessionId: string): string {
  return 'mytool'
}
```

### Scenario B: per-project session files (JSON / JSONL)

```typescript
import { existsSync, readdirSync, statSync, watch } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

function getSessionsDir(projectPath: string): string {
  const encoded = projectPath.replace(/[:\\\/]/g, '-')
  return join(homedir(), '.mytool', 'sessions', encoded)
}

async scanSessions(projectPath: string): Promise<CliSession[]> {
  const dir = getSessionsDir(projectPath)
  if (!existsSync(dir)) return []

  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  const sessions: CliSession[] = []

  for (const file of files) {
    const filePath = join(dir, file)
    const stat = statSync(filePath)
    sessions.push({
      sessionId: file.replace(/\.jsonl$/, ''),
      slug: TOOL_NAME,
      lastModified: stat.mtime
    })
  }

  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
},

watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
  const dir = getSessionsDir(projectPath)
  if (!existsSync(dir)) return () => {}

  // Build baseline synchronously before attaching the watcher so a session
  // created right after spawn is never absorbed into an async baseline scan.
  const known = new Set(readdirSync(dir).filter((f) => f.endsWith('.jsonl')))

  const watcher = watch(dir, (_event, filename) => {
    if (!filename || !filename.endsWith('.jsonl') || known.has(filename)) return
    if (!existsSync(join(dir, filename))) return
    known.add(filename)
    onNew({
      sessionId: filename.replace(/\.jsonl$/, ''),
      slug: TOOL_NAME,
      lastModified: new Date()
    })
  })

  return () => watcher.close()
}
```

### Scenario C: global flat directory or SQLite database

- **Global flat directory (all projects mixed together, e.g. Codex):** reading every file's header on cold start is slow. Use `src/main/pty/cliTools/sessionMetaCache.ts` (`getCachedMeta`, `setCachedMeta`, `pruneCache`) keyed by namespace + absolute file path and validated against `mtimeMs` and `size`. Pass `scopePrefix` to `pruneCache` if your scanner only enumerates one project directory; omit it only when scanning the entire global store.
- **SQLite database (e.g. Devin `sessions.db`, OpenCode `opencode.db`, Cursor `store.db`):** open read-only with `better-sqlite3` (`new Database(dbPath, { readonly: true, fileMustExist: true })`) and always close in `finally`. Seed `knownIds` synchronously before watching the DB/WAL files for changes.

### `CliSession` type & Session Picker display

```typescript
interface CliSession {
  sessionId: string        // unique ID (passed to resumeCommand)
  slug: string             // fallback / last-message label
  summary?: string         // optional AI-generated title
  firstMessage?: string    // optional first user message (primary line in Session Picker)
  lastModified: Date       // used for newest-first sorting
}
```

Session Picker renders each row in three lines:
1. Primary: `firstMessage ?? slug`
2. Secondary (small): `slug` (hidden if equal to `firstMessage` or if `firstMessage` is absent)
3. Footer (smaller): `toolName`

---

## 5. Full Implementation — Every Method

### `installProblem`

Use when binary presence alone is not enough (e.g. minimum version check, missing runtime). Called by CLI Tools Manager during activation and by `pipeline_smoke`:

```typescript
async installProblem(): Promise<string | null> {
  const exe = resolveMyToolExecutable()
  if (!exe) return 'Not found in PATH'
  const version = await readMyToolVersion(exe)
  if (!version) return `Could not read the version of ${exe}`
  if (version.major < 2) return `My Tool ${version.raw} is installed; AIDE requires v2+`
  return null
},

async isInstalled(): Promise<boolean> {
  return (await this.installProblem!()) === null
}
```

### `prepareProject`

Called once before spawning new or resumed tabs for a project. Use it to pre-trust the workspace or prepare required directories so the CLI does not stall on interactive confirmation dialogs. Prefer atomic writes (write to temp sibling + `renameSync`) when modifying files the CLI itself may read concurrently.

### `prepareLaunch` and `aideMcp`

Called before every PTY spawn (both new and resumed tabs). Returns `{ args?, env? }` appended to the launch command and merged into the PTY environment.

`ctx: LaunchContext` provides:
- `tabId: string` — AIDE's tab ID (also injected automatically as `AIDE_TAB_ID` in PTY env).
- `projectPath: string` — project root (also injected automatically as `PWD` in PTY env).
- `hook: { port: number; token: string } | null` — AIDE's app-wide `HookServer` (`src/main/hooks/hookServer.ts`) for deterministic `tabId → { sessionId, transcriptPath }` binding.
- `mcpServers: LaunchMcpServer[]` — stdio MCP servers AIDE gives this launch (`name`, `command`, `args`, `env`, `tabEnv` with `AIDE_TAB_ID`/`AIDE_PROJECT`, and `toolTimeoutSec`, currently `3100` s because `pipeline_wait` can block up to 50 min). Empty when the user disabled *Give AIDE's MCP server to this CLI* or AIDE's server is down.

#### Wiring AIDE's MCP server

1. Declare `aideMcp: { supported: true }` (or `{ supported: false, note: 'Why not supported' }`) on `CliTool`. AIDE automatically adds the per-CLI checkbox in Settings (`aideMcpField` in `src/main/aideMcp/launch.ts`).
2. Pass `ctx.mcpServers` using a per-launch mechanism whenever the CLI supports one — **never mutate the user's global CLI config**:
   - Per-tab JSON file + flag (Claude Code `--mcp-config "<file>"`, Cursor `--plugin-dir "<dir>"`), using `tabLaunchPath` / `writeLaunchFile` from `launchFiles.ts` and removing it in `deregisterTab` via `removeLaunchPath`.
   - Command-line config overrides (Codex `-c ...`), using `shellLiteral()` from `launchFiles.ts` (note: Windows PowerShell 5.1 mangles embedded double quotes).
   - Launch environment variable (OpenCode `OPENCODE_CONFIG_CONTENT`, merged over any existing value).
   - Only if the CLI has no per-launch MCP mechanism at all: a non-committed project-local file (Devin `.devin/mcp_config.local.json`), keeping user entries, omitting `tabEnv` (relying on inherited `AIDE_TAB_ID`), adding to `.git/info/exclude`, removing AIDE's entry when `ctx.mcpServers` is empty, and explaining this in `aideMcp.note`.
3. Merge `{ ...server.env, ...server.tabEnv }` for per-tab configs; omit `tabEnv` only for configs shared across tabs.
4. Add unit tests in `src/main/pty/cliTools/launchMcp.test.ts` and update `docs/aide-mcp-launch.md` after verifying live that AIDE's server loads without approval prompts and receives `AIDE_TAB_ID`.

#### Wiring deterministic hooks (`ctx.hook`)

When the CLI supports lifecycle hooks (such as `SessionStart` and `Stop`), wire them in `prepareLaunch` so they POST stdin JSON (`{ session_id, transcript_path }`) to:

```
http://127.0.0.1:<ctx.hook.port>/hook?tab=<encodeURIComponent(ctx.tabId)>&event=<event>&token=<ctx.hook.token>
```

Use the OS-bundled `curl` (`%SystemRoot%\System32\curl.exe` on Windows, `/usr/bin/curl` on POSIX) with `-s -m 2 -X POST "<url>" --data-binary @-` so hooks never block a turn and never depend on Node or PowerShell env expansion. See `claudeHooks.ts` and `devinHooks.ts` for reference, and remove per-tab hook files in `deregisterTab`.

### `checkStartupHealth`

Inspects accumulated PTY output and returns `'ok'`, `'dead'`, or `'pending'`:

```typescript
import { tuiReadyForInput } from './startupHealth'

checkStartupHealth(accumulated: string): 'ok' | 'dead' | 'pending' {
  if (
    accumulated.includes('command not found') ||
    accumulated.includes('is not recognized') ||
    accumulated.includes('No conversation found')
  ) {
    return 'dead'
  }

  // For full-screen TUIs on ConPTY: wait for alternate screen + cursor shown.
  // (Or check a specific CLI readiness banner/prompt.)
  return tuiReadyForInput(accumulated) ? 'ok' : 'pending'
}
```

**Important rules:**
- **Never decide readiness by elapsed time.** `PtyManager` enforces the 15 s upper bound itself and reports `'unknown'` (not `'ok'`) if no verdict arrives — prompts are not blindly pasted into an unready shell.
- Do **not** treat any bare CSI escape sequence (`\x1b[`) as ready on Windows ConPTY; PowerShell emits CSI sequences before the CLI even launches. Prefer `tuiReadyForInput(accumulated)` (`\x1b[?1049h` followed by `\x1b[?25h`) or a CLI-specific banner/prompt marker.
- `checkStartupHealth` drives three features: dead-session cleanup on restore, `createNewSessionWithPrompt`, and `submitWhenReady` (used by Pipeline `EventRelay`).

### `interactiveSubmitSequence` (and `exitCommand`)

When AIDE sends text to a running tab (`createNewSessionWithPrompt`, File Viewer "Send", Pipeline `EventRelay`), `PtyManager.submitPastedInput` writes bracketed paste (`\x1b[200~<text>\x1b[201~`), waits for the next PTY output chunk (so the TUI renders the paste before Enter arrives), and then writes `tool.interactiveSubmitSequence?.() ?? '\r'`. Override `interactiveSubmitSequence()` if the CLI's keyboard protocol requires a different submit sequence.

`exitCommand()` is an optional convention returning the slash command that exits the CLI cleanly (e.g. `'/exit'`).

### Tab signals, idle detection, and `deregisterTab`

`PtyManager` wires `registerSignalHandler(tabId, handler)` at spawn time. Emitting `'completeAndWait'` does **two critical things**:
1. Marks the tab idle in `tabActivity` (`src/main/pty/tabActivity.ts`), allowing **Pipeline / Plan `EventRelay`** to deliver missed Strategist events into the tab.
2. Emits `terminal:tab-event` to the renderer (completion sound / UI indicator).

Choose the best mechanism your CLI supports:

- **Option A — OSC title transition (`detectTitleEvent`)** (preferred when the CLI updates its terminal title on busy ↔ idle, like Claude Code `✳` or Codex braille spinners):

```typescript
const signalByTab = new Map<string, (event: string) => void>()

detectTitleEvent(tabId: string, prevTitle: string | null, newTitle: string): void {
  if (prevTitle === null) return
  if (isBusyTitle(prevTitle) && !isBusyTitle(newTitle)) {
    signalByTab.get(tabId)?.('completeAndWait')
  }
},

registerSignalHandler(tabId: string, handler: (event: string) => void): void {
  signalByTab.set(tabId, handler)
},

deregisterTab(tabId: string): void {
  signalByTab.delete(tabId)
  // Also remove any per-tab launch files created in prepareLaunch
}
```

- **Option B — PTY silence timer (`onPtyActivity`)** (fallback when the CLI emits no idle OSC titles, as in Devin, OpenCode, and Cursor — resets a 5 s countdown on every PTY chunk and emits `'completeAndWait'` once when it reaches 0; clear the interval in `deregisterTab`).

### `getEnvOverrides`

Called synchronously at PTY spawn time **and** by `startHeadless()` for pipeline runs. Always set `NO_PROXY` / `no_proxy` alongside `HTTP_PROXY` / `HTTPS_PROXY` so local AIDE servers (MCP, pipeline, hooks) bypass the proxy:

```typescript
getEnvOverrides(): Record<string, string> {
  const proxy = ((getToolConfig(TOOL_ID).proxy as string) ?? '').trim()
  if (!proxy) return {}
  const bypass = 'localhost,127.0.0.1,::1'
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: bypass,
    no_proxy: bypass
  }
}
```

### `contextInsert`

Returns the text inserted into the terminal when the user picks **Add to context** in the desktop file tree or Remote Access (e.g. `` `@${relPath}` ``). Return `null` if unsupported.

### `getSessionPreview`, `getSessionHistory`, `subscribeToSessionHistory`, and `ToolView`

- `getSessionPreview` — lightweight last few messages for the Session Picker hover card.
- `getSessionHistory` — full structured `HistoryEntry[]` consumed by History Viewer, Remote Access history pages, and history-based Thinking Panel.
- `subscribeToSessionHistory` — live stream of new `HistoryEntry` items (offset-based file watch or DB/WAL watch) consumed by History Viewer, Remote Access WebSocket subscriptions, and history-based Thinking Panel.

#### CLI-neutral `ToolView` (`src/main/pty/cliTools/toolViews.ts`)

Every `tool_use` block in `HistoryEntry` (from both interactive session scanners and headless adapters) can attach an optional `view?: ToolView` so the History Viewer, Pipeline transcript viewer, and Remote page render edits, patches, reads, shell commands, and searches cleanly without knowing CLI-specific tool names:

```typescript
export type ToolView =
  | { kind: 'edit'; path: string; edits: Array<{ oldText: string; newText: string }> }
  | { kind: 'patch'; paths: string[]; patch: string }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'read'; path: string; range?: string }
  | { kind: 'shell'; command: string }
  | { kind: 'search'; pattern: string; path?: string }
  | { kind: 'script'; language: string; code: string; summary: string }
```

Add a mapper function `<tool>ToolView(name, input)` in `src/main/pty/cliTools/toolViews.ts` and cover it in `src/main/pty/cliTools/toolViews.test.ts`. Unrecognised tools return `undefined` and fall back to generic rendering. When a CLI supports both interactive history and headless streaming, factor block normalization into a shared helper (as `openCodeParts.ts` does) so both paths render identically.

### Logging (`cliLogger.ts`)

Never use `console.log`/`warn`/`error` inside a CLI tool module. Use `cliLog(channel, message)` from `src/main/pty/cliTools/cliLogger.ts`, which automatically masks emails (when privacy masking is on) and broadcasts to the Log Panel UI and Remote Access log stream.

### Thinking Panel (`getSessionFilePath`, `parseThinkingBlocks`, or history stream)

`ThinkingWatcher` (`src/main/thinking/thinkingWatcher.ts`) supports two modes:

1. **Appendable JSONL file mode** (Claude Code, Codex, Qwen): implement `getSessionFilePath(projectPath, sessionId)` and `parseThinkingBlocks(line)`. If the tool uses hooks, `ThinkingWatcher` automatically prefers the authoritative `transcript_path` from the hook payload over `getSessionFilePath()`.
2. **History-stream mode** (SQLite or non-appendable transcripts — Cursor, Devin, OpenCode): thinking blocks arrive as `{ type: 'thinking', thinking: string }` inside `getSessionHistory` and `subscribeToSessionHistory`.
   - **Important:** `ThinkingWatcher.startWatching` (`src/main/thinking/thinkingWatcher.ts`) currently checks an explicit list of tool IDs (`cursor-agent`, `devin`, `open-code`) for `viaHistory`. If your tool streams thinking via history entries instead of an appendable JSONL file, add your tool ID there (or generalize the condition when `filePath` is absent / non-JSONL).

### `resolveOwnerPid` (legacy)

`PtyManager.assignNewSession` no longer walks the OS process tree — concurrent tab binding is handled by deterministic hooks (`HookServer`). You do not need to implement `resolveOwnerPid` for new tools. (If you ever need process-tree lookup, use the cross-platform `listProcesses()` + `resolveOwnerPidFromSnapshot()` in `src/main/platform` rather than raw PowerShell.)

---

## 6. Headless Execution (Pipelines & Plans)

To let a CLI run pipeline `agent` steps and plan Orchestrator calls, attach `headless: HeadlessCapability` (`src/main/pipeline/headless/types.ts`) to your `CliTool`.

`pipelineManager` automatically discovers every registered tool with `tool.headless` set (`src/main/pipeline/index.ts`), and `startHeadless(tool, options)` (`src/main/pipeline/headless/index.ts`) automatically:
- Merges `process.env`, `options.env`, and `tool.getEnvOverrides()` (including the per-CLI proxy and `NO_PROXY`), matching PTY sessions.
- Sets `options.stateDir` to `<userData>/headless/<tool.id>` for adapters that maintain persistent config homes.

### Adapter contract (`src/main/pipeline/headless/<tool>Headless.ts`)

Implement `HeadlessCapability`:

```typescript
export interface HeadlessCapability {
  run(options: HeadlessRunOptions): HeadlessRun
  /** Set true if the adapter accepts the final answer via options.resultTool (MCP submit_result). */
  readonly resultTool?: boolean
}
```

Key requirements for every headless adapter:

1. **Resolve the executable without a shell:** `runProcess()` spawns directly (`shell: false`). Use `resolveExecutable(name, options.env)` from `src/main/pipeline/headless/common.ts` (and check known per-user install paths if needed). On Windows, `.cmd`/`.bat`/`.ps1` shims cannot be spawned without a shell — resolve the real `.exe` or `node.exe + script` directly (see `openCodeHeadless.ts` and `cursorHeadless.ts`). Always honour `options.executable` so unit tests can inject a fake CLI.
2. **Isolate from user MCP servers, rules, and connectors:** pipeline steps must run with only their role prompt and workspace context — never the user's personal MCP servers or IDE connectors (which can contradict role instructions).
3. **Enforce `options.permissions`:**
   - `'read-only'`: allow file reads and read-only git inspection (`git status`, `git diff`, `git log`, `git show`); **enforce** denial of file edits/writes and arbitrary shell commands (prompt-only instructions are not sufficient).
   - `'write'`: non-interactive workspace read/write/shell access without confirmation prompts.
4. **System prompt (`options.systemAppend`) & prompt (`options.prompt`):** use a native append-system-prompt flag when available (never a flag that *replaces* the CLI's base system prompt); otherwise prepend role instructions to the prompt via `promptWithRoleAndSchema()`.
5. **Structured output (`options.outputSchema`):** use the strongest mechanism the CLI supports:
   - **Native JSON Schema mode** (best — Claude `--json-schema`, Codex `--output-schema`): return parsed JSON in `HeadlessResult.structured`.
   - **AIDE `ResultTool`** (`resultTool: true` — OpenCode 2): when `options.outputSchema` is set and AIDE's pipeline server is up, AIDE opens a per-visit remote HTTP MCP endpoint and passes `options.resultTool` (`{ serverName, url, headers, submitted() }`). Wire it into the run's isolated config and instruct the agent to call `submit_result`; the endpoint validates against the schema so the agent can self-correct in the same turn. Fall back to `promptWithRoleAndSchema` + `parseFinalJson` when `resultTool` is absent.
   - **Prompt instruction fallback** (Cursor, Devin): append the schema via `promptWithRoleAndSchema()` and parse the final message with `parseFinalJson()`.
6. **Session ID & Resume:** call `options.onSessionId?.(id)` as soon as the session ID is known, return it in `HeadlessResult.sessionId`, and support `options.resumeSessionId` (ideally across both `'read-only'` and `'write'` profiles).
7. **Live transcript streaming:** parse the CLI's JSON event stream in `onStdoutLine` and emit normalized `HistoryEntry` objects via `options.onEntry?.(entry)`, attaching `ToolView` from `toolViews.ts`.
8. **Model & Effort (`options.model`, `options.effort`):**
   - Pass `options.model` when given (and be careful that config-isolation flags do not silently drop the user's default model/effort).
   - If the CLI supports `effort`, add your tool ID and accepted effort values to **`EFFORTS` in `src/main/pipeline/engine/validate.ts`** (`string[]` for a fixed list, `null` for model-dependent variants). Without an entry in `EFFORTS`, `validateMachine()` rejects `"effort"` for your CLI.
   - If your CLI has JSON Schema restrictions (like Codex's strict-schema requirement), add validation in `validate.ts` too.
9. **Error classification (`HeadlessErrorCode`):**
   - Use `processError()`, `classifyFailure()`, and `isClassifiedFailure()` from `common.ts`.
   - Map quota/rate limits to `code: 'limit'` (this triggers the **Pipeline Account Pool**!). Preserve reset time text (e.g. `"try again in N minutes"` or ISO timestamp) in the error message when the CLI reports it, so AIDE can schedule automatic resume.
   - Map transient overload/network errors to `code: 'unavailable'` (the engine retries these automatically).
10. **Cost & warnings:** populate `costUsd` if available (else `null`) and non-fatal `warnings[]`.
11. **Cancellation & timeouts:** forward `options.timeoutMs` and `options.label` to `runProcess()`, and wire `cancel: () => handle.cancel()`.
12. **Tests & docs:**
    - Add unit tests in `src/main/pipeline/headless/` testing arg building, config isolation, event/transcript parsing, error classification, and fake-process runs.
    - Add an opt-in live test (`<tool>.live.test.ts`, gated by `AIDE_LIVE_<TOOL>=1`) verifying: (a) read-only + structured output + `ToolView`, (b) session resume preserving context, (c) read-only blocks writes while write allows them, and (d) cleanup of test sessions/temp dirs.
    - Verify with `pipeline_smoke` (`src/main/pipeline/smoke.ts`) and document verified live facts in `docs/headless-cli-matrix.md` and `resources/docs/pipeline-authoring.md`.

---

## 7. Registering the Tool & Touchpoints

### Primary registration: `src/main/pty/cliTools/registry.ts`

```typescript
import type { CliTool } from './types'
import { claudeCodeTool } from './claudeCode'
import { qwenCodeTool } from './qwenCode'
import { openCodeTool } from './openCode'
import { cursorAgentTool } from './cursorAgent'
import { codexTool } from './codex'
import { devinTool } from './devin'
import { antigravityTool } from './antigravity'
import { myTool } from './myTool'           // ← add import
import { plainShellTool } from './plainShell'

const cliToolRegistry: CliTool[] = [
  claudeCodeTool, qwenCodeTool, openCodeTool, cursorAgentTool,
  codexTool, devinTool, antigravityTool, myTool
]
```

Once registered, the tool automatically appears in:
- **CLI Tools Manager** (Tools → Manage CLI Tools)
- **New Session** dropdown and Remote Access tool picker (once activated)
- **Settings → CLI Settings** (once activated)
- **Account Manager** and **Load Account** menu (once activated, if `hasAccountSystem() === true`)
- **Pipeline headless CLI list** (if `headless` is defined)

### Additional touchpoints (only when applicable)

| File | When to update |
|------|----------------|
| `src/main/pipeline/engine/validate.ts` | Add tool ID to `EFFORTS` if headless supports `effort` (or add schema checks if the CLI restricts JSON Schema). |
| `src/main/pipeline/engine/machineSchema.ts` | Update schema descriptions listing headless CLI IDs and effort values. |
| `src/main/thinking/thinkingWatcher.ts` | Update `viaHistory` if the tool streams thinking via `getSessionHistory`/`subscribeToSessionHistory` instead of an appendable JSONL file. |
| `src/main/pty/cliTools/toolViews.ts` | Add `<tool>ToolView()` mapper for CLI-neutral transcript rendering (+ `toolViews.test.ts`). |
| `src/main/pty/cliTools/launchMcp.test.ts` | Add unit tests for `prepareLaunch` MCP injection. |
| `docs/aide-mcp-launch.md` | Document how AIDE's MCP server is passed and what was verified live. |
| `docs/headless-cli-matrix.md` | Add a column + live-verified notes for the headless adapter. |
| `resources/docs/pipeline-authoring.md` | Document headless capabilities (effort, structured output, isolation) for pipeline authors. |
| `docs/account-pool.md` | Update if the CLI participates in the Pipeline Account Pool with special notes. |

---

## 8. Settings

Implement `settingsFields`, `getSettings`, and `updateSettings` to render a tool section under **Settings → CLI Settings**.

### Automatic common settings

AIDE automatically appends two common settings to every activated tool in `src/main/ipc/index.ts` (`tool-settings:get-all` / `tool-settings:update`):
1. **`aideMcpServer`** (*Give AIDE's MCP server to this CLI*) — added automatically whenever `tool.aideMcp` is declared (`aideMcpField()` in `src/main/aideMcp/launch.ts`).
2. **`pipelineEventMessages`** (*Send pipeline events to the orchestrator as messages*) — added automatically to every activated tool (`EVENT_MESSAGES_FIELD` in `src/main/pipeline/eventRelay.ts`).

AIDE strips these keys before calling `tool.updateSettings(own)` and merges them back afterward, so `tool.updateSettings` only needs to persist its own fields via `updateToolConfig(TOOL_ID, values)`.

### Storage

```typescript
import { getToolConfig, updateToolConfig } from '../../config/appConfig'

const TOOL_ID = 'my-tool'

async getSettings(): Promise<Record<string, unknown>> {
  return getToolConfig(TOOL_ID) // stored in aide-config.json under tools['my-tool']
},

async updateSettings(values: Record<string, unknown>): Promise<void> {
  updateToolConfig(TOOL_ID, values)
}
```

### Field descriptors (`src/shared/settingsTypes.ts`)

```typescript
export interface SettingsField {
  key: string
  label: string
  description?: string
  type: 'string' | 'boolean' | 'number' | 'password' | 'select'
  options?: Array<{ value: string; label: string }>
  default?: unknown
  /** Shown greyed out and non-editable (explain why in description). */
  disabled?: boolean
  /** Only render when sibling key equals value. */
  visibleWhen?: { key: string; value: unknown }
}
```

| Type | Rendered as | Notes |
|------|-------------|-------|
| `'string'` | Text input | |
| `'password'` | Password input | Value is masked |
| `'boolean'` | Checkbox | Supports `disabled: true` (currently applied to checkboxes only) |
| `'number'` | Number input | |
| `'select'` | Dropdown | Requires `options` |

---

## 9. Accounts, Usage & Pipeline Account Pool

### When to implement vs. when to skip

`hasAccountSystem(): boolean` is **required** on `CliTool`.

**Implement account management (`return true`)** whenever the CLI stores credentials in files/DBs that AIDE can read and write, and there is no built-in, convenient account-switching mechanism in the CLI itself.

**Return `false`** only when:
1. The CLI already has its own built-in account switching that makes AIDE-level management redundant or conflicting, OR
2. Credential export/import is technically impossible (e.g. opaque OS-only credentials or inaccessible auth flow).

When `hasAccountSystem()` returns `false`:
- The tool is hidden from the "Load Account" menu and excluded from the Pipeline Account Pool.
- Its tab in Account Manager shows the current login identifier from `getLoginIdentifier()` (if known) and its `accountUnsupportedReason` explanation, with no save/switch/pool controls.
- `getLoginIdentifier()` is still called for the status bar (static label, no "not saved" warning).

### Core account methods

- `isLoggedIn()` — whether valid credentials exist locally.
- `getLoginIdentifier()` — email, username, or label of the active login (used for UI display and for matching the active login to saved accounts in `accountSwitch.ts`).
- `exportCredentials()` — returns a JSON-serialisable snapshot of current credentials, or `null` if not logged in.
- `importCredentials(credentials)` — restores a saved snapshot (stop/restart any shared CLI auth daemon first if needed, as Codex does).
- `clearCredentials()` — deletes local credentials without revoking tokens server-side.

### Extended account lifecycle methods

- **`accountSwitchNeedsRestart?(): boolean`** — defaults to `true` when omitted. Controls whether AIDE offers to restart open PTY tabs after an interactive account switch (`offerRestartAfterAccountChange` in `src/main/pty/registry.ts`) and whether `AccountPool` automatically restarts tabs after a pool rotation (`src/main/pipeline/accountPool.ts`). Return `false` if live sessions re-read credentials from disk on their own (e.g. Claude Code).
- **`accountHint?(): Promise<string | null>`** — optional explanatory text shown in Account Manager (e.g. OpenCode explains when API keys live in `opencode.json` rather than stored credentials).
- **`refreshAccountState?(): Promise<void>`** — called by Account Manager whenever it opens or switches to this tool, so derived/cached auth state is up to date.

### Pipeline Account Pool

Any CLI with `hasAccountSystem() === true`, `importCredentials`, and a `headless` adapter participates automatically in the **Pipeline Account Pool** (`docs/account-pool.md`):
- When a headless step returns `error.code === 'limit'`, AIDE marks the active saved account exhausted (until the parsed reset time, if present), saves any rotated tokens back to its record (matching by `getLoginIdentifier()`), loads the next checked pool account, restarts tabs if `accountSwitchNeedsRestart() !== false`, and resumes the pipeline run automatically.

### Usage info (`getUsageInfo`)

```typescript
async getUsageInfo(cacheMaxAgeMs = 20 * 60_000): Promise<UsageInfo | null>
```

`UsageInfo`:
- `summary: string` — short status bar text (e.g. `"37% / 26%"`)
- `tooltip: string` — detailed hover text
- `level: 'normal' | 'warn' | 'critical'` — color hint
- `fetchedAt: number` — epoch ms when fetched
- `hasLimit?: boolean` — set `false` when there is no quota limit so callers skip warning colors

**Recommendations:**
- Respect `cacheMaxAgeMs` (`usage:get-info` passes `5 * 60_000` when the editor window is focused and `20 * 60_000` when unfocused) and implement exponential backoff on HTTP 429.
- Use `Electron.session.fromPartition(...)` with `setProxy()` so usage requests honour the tool's proxy setting.
- For multi-window / multi-instance coordination, use the shared SQLite usage cache and refresh lease helpers in `src/main/config/accountStorage.ts` (`getSubscriptionUsageCache`, `setSubscriptionUsageCache`, `tryAcquireSubscriptionUsageRefresh`, `releaseSubscriptionUsageRefresh`), as in `claudeCode.ts` and `cursorAgent.ts`.

---

## 10. Implementation Checklist

### Required minimum

- [ ] Created `src/main/pty/cliTools/yourTool.ts`
- [ ] Implemented all required members: `id`, `name`, `isInstalled` (using `findExecutable`), `newSessionCommand`, `resumeCommand`, `scanSessions`, `watchForNewSessions`, `hasAccountSystem`
- [ ] Registered tool in `cliToolRegistry` (`src/main/pty/cliTools/registry.ts`)
- [ ] `npm run typecheck` and `npm test` pass

### Interactive UX & startup

- [ ] Added `installUrl` (and `installProblem` if version/runtime validation is needed)
- [ ] Implemented `prepareProject` if workspace trust / first-run setup is needed
- [ ] Implemented `checkStartupHealth` without any elapsed-time heuristics (use `tuiReadyForInput` for full-screen TUIs)
- [ ] Implemented `interactiveSubmitSequence` (if different from `'\r'`) and `exitCommand`
- [ ] Implemented `contextInsert` for desktop file tree and Remote Access
- [ ] Added `proxy` setting and `getEnvOverrides()` with `HTTP_PROXY`/`HTTPS_PROXY` **and** `NO_PROXY`/`no_proxy` (`localhost,127.0.0.1,::1`)

### Completion signals & Strategist EventRelay

- [ ] Implemented `registerSignalHandler` and `deregisterTab`
- [ ] Emit `'completeAndWait'` via `detectTitleEvent` (OSC title) or `onPtyActivity` (inactivity timer) so toolbar sounds and `tabActivity` / Pipeline `EventRelay` work

### AIDE MCP server & deterministic hooks

- [ ] Declared `aideMcp: { supported: true | false, note? }`
- [ ] Implemented `prepareLaunch(ctx)` to inject `ctx.mcpServers` (without mutating global user config) and wire `ctx.hook` (if the CLI supports lifecycle hooks)
- [ ] Cleaned up per-tab launch files in `deregisterTab(tabId)`
- [ ] Added unit test in `src/main/pty/cliTools/launchMcp.test.ts`
- [ ] Verified live that AIDE's MCP server loads without approval prompt and receives `AIDE_TAB_ID`; updated `docs/aide-mcp-launch.md`

### Sessions, History Viewer, Remote Access & Thinking Panel

- [ ] `scanSessions` returns sorted `CliSession[]` (`firstMessage`, `slug`, `summary`, `lastModified`); uses `sessionMetaCache.ts` if scanning a global flat directory
- [ ] `watchForNewSessions` builds its baseline synchronously before attaching watchers
- [ ] Implemented `getSessionPreview`, `getSessionHistory`, and `subscribeToSessionHistory`
- [ ] Added `<tool>ToolView` in `src/main/pty/cliTools/toolViews.ts` and tests in `toolViews.test.ts`
- [ ] Thinking Panel wired via either:
  - `getSessionFilePath` + `parseThinkingBlocks` (appendable JSONL), OR
  - `thinking` blocks in `getSessionHistory` / `subscribeToSessionHistory` + `viaHistory` in `src/main/thinking/thinkingWatcher.ts`

### Headless execution (Pipelines & Plans)

- [ ] Implemented `src/main/pipeline/headless/yourToolHeadless.ts` and attached `headless` to `CliTool`
- [ ] Resolves native executable directly (no `.cmd`/`.bat` shell required); honours `options.executable`
- [ ] Isolates runs from user MCP servers, rules, and connectors
- [ ] Enforces `read-only` (reads + git inspection only, writes/arbitrary shell denied) and `write` profiles
- [ ] Supports `outputSchema` (native schema, `resultTool: true`, or `promptWithRoleAndSchema` + `parseFinalJson`)
- [ ] Emits `onSessionId`, supports `resumeSessionId` (across permission profiles), streams `onEntry` with `ToolView`
- [ ] Classifies errors cleanly (`limit`, `unavailable`, `timeout`, `cancelled`, `no_output`, `failed`), preserving limit reset times
- [ ] Added tool ID to `EFFORTS` in `src/main/pipeline/engine/validate.ts` (if `effort` is supported)
- [ ] Added unit tests and opt-in live test (`yourTool.live.test.ts`, `AIDE_LIVE_<TOOL>=1`)
- [ ] Updated `docs/headless-cli-matrix.md` and `resources/docs/pipeline-authoring.md`

### Settings

- [ ] Implemented `settingsFields`, `getSettings`, `updateSettings` (using `visibleWhen` / `disabled` where appropriate)
- [ ] Verified Settings UI renders tool fields plus auto-injected `aideMcpServer` and `pipelineEventMessages`

### Accounts, Usage & Account Pool

- [ ] Implemented `isLoggedIn`, `getLoginIdentifier`, `exportCredentials`, `importCredentials`, `clearCredentials`
- [ ] Implemented `accountSwitchNeedsRestart`, `accountHint`, `refreshAccountState` if applicable
- [ ] Implemented `getUsageInfo(cacheMaxAgeMs)` with caching, 429 backoff, proxy support, and `hasLimit`
- [ ] Updated `docs/account-pool.md` if the CLI has pool-specific behavior
