# Multi-CLI Architecture

AIDE supports multiple AI CLI tools (Claude Code, Aider, Gemini CLI, etc.) running as terminal
sessions inside the editor. This document describes the full architecture for registering,
activating, and running CLI tools.

---

## Core Concepts

### CliTool Interface

Every CLI tool is described by a single object implementing `CliTool`
(`src/main/pty/cliTools/types.ts`). The interface is split into required and optional methods.

**Required:**

| Member | Description |
|--------|-------------|
| `id: string` | Stable machine identifier, e.g. `'claude-code'` |
| `name: string` | Human-readable name shown in the UI, e.g. `'Claude Code'` |
| `isInstalled(): Promise<boolean>` | Returns true if the CLI binary is present on the system |
| `newSessionCommand(): string` | Shell command written to PTY to start a new session |
| `resumeCommand(sessionId): string` | Shell command to resume an existing session |
| `scanSessions(projectPath): Promise<CliSession[]>` | List existing sessions for the project, newest first |
| `watchForNewSessions(projectPath, onNew): () => void` | Watch for new session files; returns unsubscribe |

**Optional — startup & runtime:**

| Member | Description |
|--------|-------------|
| `installUrl?: string` | Link shown in CLI Tools Manager when the tool is not installed |
| `checkStartupHealth?(accumulated, elapsedMs)` | Inspect PTY output to detect ready/dead state |
| `detectTitleEvent?(prevTitle, newTitle)` | Return a named event when a notable title transition occurs |
| `resolveOwnerPid?(candidatePids)` | Match a new session file to the PTY tab that spawned it |
| `prepareProject?(projectPath)` | One-time setup before the first session (e.g. write trust config) |
| `watchSessionLabel?(projectPath, sessionId, onLabel)` | Stream label updates for a running session |

**Optional — settings:**

| Member | Description |
|--------|-------------|
| `settingsFields?(): SettingsField[]` | Declares configurable fields rendered in Settings UI |
| `getSettings?(): Promise<Record<string, unknown>>` | Load current settings values |
| `updateSettings?(values): Promise<void>` | Persist updated settings values |

**Optional — accounts:**

| Member | Description |
|--------|-------------|
| `isLoggedIn?(): Promise<boolean>` | Whether the user is currently authenticated |
| `getLoginIdentifier?(): Promise<string \| null>` | Return email or username of the current user |
| `credentialsMatch?(saved): Promise<boolean>` | Check if saved credentials match the active ones |
| `exportCredentials?(): Promise<Record<string, unknown> \| null>` | Serialise current credentials |
| `importCredentials?(credentials): Promise<void>` | Restore previously exported credentials |
| `clearCredentials?(): Promise<void>` | Remove local credentials without server-side revocation |
| `getUsageInfo?(): Promise<UsageInfo \| null>` | Return usage/quota data for the status bar |

---

## Tool Registry

`src/main/pty/cliTools/registry.ts` is the single registration point.

```ts
const cliToolRegistry: CliTool[] = [claudeCodeTool /*, aiderTool, ... */]

export function getRegisteredTools(): CliTool[]
export function getToolById(id: string): CliTool | undefined
export function getDefaultTool(activatedTools: string[]): CliTool
```

`getDefaultTool` returns the first tool whose id appears in `activatedTools`. If `activatedTools`
is empty, it returns `plainShellTool` (the built-in fallback — see below).

`plainShellTool` is **not** in `cliToolRegistry`. It is a private constant used only as a
last-resort fallback and is never shown in the CLI Tools Manager UI.

---

## Activation

Activation is a user-driven, on-demand check. It is never automatic.

### State storage

`activatedTools: string[]` is stored in `aide-state.json` (Electron `userData` directory,
app-level — not per project). It contains the `id` values of tools the user has explicitly
activated.

```json
{
  "activatedTools": ["claude-code"]
}
```

### Activation flow

1. User opens **Tools → Manage CLI Tools**.
2. The window shows every tool in `cliToolRegistry` with its current activation state.
3. User clicks **Activate** next to an inactive tool.
4. Main process calls `tool.isInstalled()`.
5. Result is shown immediately:
   - Success → tool added to `activatedTools`, button changes to **Activated ▾**.
   - Failure → error message + **↗ Install** link using `tool.installUrl`.
6. User can click **Activated ▾ → Deactivate** to remove a tool from `activatedTools`.

### `isInstalled()` contract

Each tool implements its own check (e.g. `where claude`, `claude --version`). The result is
used only during the activation attempt — it is not cached or re-checked on subsequent
app launches.

---

## Fallback (plain-shell)

`src/main/pty/cliTools/plainShell.ts` implements a minimal fallback tool:

- `id: 'plain-shell'`, `name: 'Terminal'`
- `isInstalled()` always returns `true`
- `newSessionCommand()` and `resumeCommand()` return `''` (no command sent to PTY)
- `scanSessions()` returns `[]`
- `watchForNewSessions()` returns a no-op unsubscribe
- No account methods, no settings, no health check

The user gets a plain PowerShell prompt. Sessions are not stored.

---

## Startup Flow

```
App starts
    │
    ▼
activatedTools empty?
    ├─ YES → open CLI Tools Manager window (blocks session creation)
    │            │
    │            ├─ User activates at least one tool → close window → proceed
    │            └─ User closes window without activating → proceed with plain-shell
    │
    └─ NO  → proceed normally, defaultToolId = first activated tool
```

The CLI Tools Manager window is opened from the main process before `terminal:create-initial`
completes. The editor waits for the window to close via an IPC acknowledgement
(`cli-tools:closed`) before creating session tabs.

---

## Session Attribution

Every session tab carries a `toolId` that identifies which CLI created it.

### Persistent state

`SavedSessionEntry` in `appState.ts`:

```ts
interface SavedSessionEntry {
  sessionId: string
  title: string
  toolId: string   // which CLI owns this session
}
```

On restore, each saved entry's `toolId` is used to look up the correct `CliTool` via
`getToolById`. If the tool is no longer activated, the tab is silently discarded.

### Per-tab tool in PtyManager

`PtyTab` (internal to `PtyManager`) carries its own `tool: CliTool` reference:

```ts
interface PtyTab {
  pty: IPty
  tabId: string
  sessionId: string | null
  title?: string
  tool: CliTool
}
```

`PtyManager` no longer holds a single `this.tool`. Instead it accepts a `getToolById` function
in its constructor and all methods that previously called `this.tool.X` now use `tab.tool.X`.

---

## Default Tool (per project)

Each project stores its last-used tool in `.aide/settings.json`:

```json
{
  "defaultToolId": "claude-code"
}
```

When the user selects a different tool from the **New Session** dropdown, `defaultToolId` is
updated immediately. On next project open, the same tool is used for new sessions.

If `defaultToolId` is absent or refers to a tool no longer in `activatedTools`, the first
activated tool is used.

---

## New Session Button

The **New Session** button in the terminal panel shows two lines:

```
New Session
claude code          ▾
```

The lower line is the `name` of the current default tool (lower-cased). The `▾` opens a
dropdown listing only activated tools (from `activatedTools`). Selecting a different tool:

1. Updates `defaultToolId` in `.aide/settings.json`.
2. Updates the button label.
3. The next **New Session** click uses the selected tool.

---

## Settings — Per-Tool Sections

`SettingsApp.tsx` renders one `<fieldset>` per activated tool that implements `settingsFields()`.

Field types supported:

```ts
interface SettingsField {
  key: string
  label: string
  description?: string
  type: 'string' | 'boolean' | 'number' | 'password' | 'select'
  options?: Array<{ value: string; label: string }>
  default?: unknown
}
```

IPC:
- `tool-settings:get-all` → `{ toolId, name, fields, values }[]` for all activated tools that
  have `settingsFields()`.
- `tool-settings:update` `(toolId, values)` → calls `tool.updateSettings(values)`.

---

## Settings — Accounts Section

For each activated tool that implements `isLoggedIn`, Settings shows an account row:

```
Claude Code    user@example.com     [Switch account]
Aider          Not logged in        [Login]
```

IPC (all take `toolId` as first argument):
- `accounts:get-tools` → `{ id, name, hasAccount, installed }[]`
- `accounts:get-login-identifier(toolId)` → `string | null`
- `accounts:is-logged-in(toolId)` → `boolean`
- `accounts:import-credentials(toolId, credentials)` → switch account
- `accounts:clear-credentials(toolId)` → log out

---

## CLI Tools Manager Window

`src/main/windows/cliTools.ts` + `src/renderer/src/windows/CliToolsApp.tsx` +
`src/preload/cliTools.ts`

Accessible via **Tools → Manage CLI Tools** in the application menu.

Displays all tools in `cliToolRegistry` (plain-shell excluded). Each row shows:
- Tool name
- `installUrl` as a small link
- Activation state button

When `activatedTools` is empty, a footer note explains that the built-in Terminal fallback
will be used.

IPC:
- `cli-tools:get-all` → `{ id, name, installUrl?, activated }[]`
- `cli-tools:activate(toolId)` → runs `isInstalled()` → `{ ok: boolean, error?: string }`
- `cli-tools:deactivate(toolId)` → removes from `activatedTools`
- `cli-tools:closed` → sent by window on close so the main process can unblock session init

---

## IPC Summary

| Channel | Direction | Description |
|---------|-----------|-------------|
| `cli-tools:get-all` | renderer → main | List all registered tools with activation state |
| `cli-tools:activate` | renderer → main | Attempt activation (runs `isInstalled()`) |
| `cli-tools:deactivate` | renderer → main | Remove tool from activated list |
| `cli-tools:closed` | renderer → main | CLI Tools window closed |
| `tool-settings:get-all` | renderer → main | Settings fields + values for activated tools |
| `tool-settings:update` | renderer → main | Persist settings for one tool |
| `accounts:get-tools` | renderer → main | Activated tools with account capability flag |
| `accounts:get-login-identifier` | renderer → main | Current user identifier for a tool |
| `accounts:is-logged-in` | renderer → main | Login state for a tool |
| `accounts:import-credentials` | renderer → main | Switch account for a tool |
| `accounts:clear-credentials` | renderer → main | Log out from a tool |

---

## File Map

```
src/main/pty/cliTools/
  types.ts          — CliTool interface, SettingsField, UsageInfo
  registry.ts       — cliToolRegistry, getDefaultTool()
  claudeCode.ts     — Claude Code implementation
  plainShell.ts     — built-in fallback (new)

src/main/config/
  appState.ts       — SavedSessionEntry gets toolId; AppState gets activatedTools

src/main/windows/
  cliTools.ts       — CLI Tools Manager window (new)

src/main/menu/
  index.ts          — Tools → Manage CLI Tools menu item

src/main/ipc/
  index.ts          — cli-tools:*, tool-settings:*, accounts:* handlers

src/preload/
  cliTools.ts       — preload bridge for CLI Tools window (new)

src/renderer/src/windows/
  CliToolsApp.tsx   — CLI Tools Manager UI (new)
  SettingsApp.tsx   — per-tool settings sections, accounts section

src/renderer/src/store/
  useSessionStore.ts — SessionTab gets toolId; fallback slug uses tool.name

src/renderer/src/components/layout/
  TerminalPanel.tsx  — New Session button with dropdown + tool name label
```
