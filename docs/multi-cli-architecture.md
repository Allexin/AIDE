# Multi-CLI Architecture

AIDE supports multiple AI CLI tools (Claude Code, Codex, OpenCode 2, Cursor Agent, Devin, Google Antigravity, Qwen Code, etc.) running as interactive terminal sessions inside the editor and — where supported — as headless pipeline runners. This document describes the architecture for registering, activating, launching, and managing CLI tools.

For a step-by-step implementation guide and checklist, see [`new-cli-tool-spec.md`](new-cli-tool-spec.md).

---

## Core Concepts

### `CliTool` Interface

Every CLI tool is described by a single object implementing `CliTool` (`src/main/pty/cliTools/types.ts`).

**Required:**

| Member | Description |
|--------|-------------|
| `id: string` | Stable machine identifier, e.g. `'claude-code'`, `'codex'`, `'antigravity'` |
| `name: string` | Human-readable name shown in the UI, e.g. `'Claude Code'` |
| `isInstalled(): Promise<boolean>` | Returns true if the CLI binary is present and usable |
| `newSessionCommand(): string` | Shell command passed to `defaultShell(command)` to start a new session |
| `resumeCommand(sessionId): string` | Shell command to resume an existing session |
| `scanSessions(projectPath): Promise<CliSession[]>` | List existing sessions for the project, newest first |
| `watchForNewSessions(projectPath, onNew): () => void` | Watch for new sessions; returns unsubscribe |
| `hasAccountSystem(): boolean` | Return `false` only for tools with built-in account switching or technically impossible credential management; `true` for all others |

**Optional — installation, launch & startup:**

| Member | Description |
|--------|-------------|
| `installUrl?: string` | Link shown in CLI Tools Manager |
| `installProblem?(): Promise<string \| null>` | Specific reason the tool cannot be activated (e.g. unsupported version), or `null` |
| `aideMcp?: { supported: boolean; note?: string }` | Declares whether the CLI takes AIDE's MCP server via `prepareLaunch`; adds the per-CLI setting |
| `prepareProject?(projectPath)` | One-time setup before starting/resuming sessions (e.g. workspace trust config) |
| `prepareLaunch?(ctx: LaunchContext): LaunchAdditions` | Per-launch `{ args?, env? }` for hook server wiring (`ctx.hook`) and AIDE's MCP servers (`ctx.mcpServers`) |
| `getEnvOverrides?(): Record<string, string>` | Synchronous env vars merged into both PTY shells and headless runs (e.g. proxy + `NO_PROXY`) |
| `checkStartupHealth?(accumulated)` | Inspect PTY output for `'ok' \| 'dead' \| 'pending'` (never time-based) |
| `interactiveSubmitSequence?(): string` | Terminal sequence to submit a pasted prompt (default `'\r'`) |
| `exitCommand?(): string` | Interactive command that exits the CLI back to its parent shell |

**Optional — runtime signals, history, thinking & headless:**

| Member | Description |
|--------|-------------|
| `registerSignalHandler?(tabId, handler)` | Registers per-tab callback for signals like `'completeAndWait'` (completion sound + `tabActivity.markIdle`) |
| `detectTitleEvent?(tabId, prevTitle, newTitle)` | Inspect OSC title transitions and emit events via the signal handler |
| `onPtyActivity?(tabId)` | Called on every PTY output chunk (used for silence-based `'completeAndWait'`) |
| `deregisterTab?(tabId)` | Cleanup per-tab signal handlers, timers, and launch files when a tab closes |
| `contextInsert?(relPath)` | Text inserted into the terminal for "Add to context" (desktop + Remote Access) |
| `getSessionPreview?(projectPath, sessionId)` | Last few messages for Session Picker hover card |
| `getSessionHistory?(projectPath, sessionId)` | Full structured `HistoryEntry[]` (with CLI-neutral `ToolView`) for History Viewer, Remote Access, and Thinking Panel |
| `subscribeToSessionHistory?(projectPath, sessionId, onEntry)` | Live stream of new `HistoryEntry` items |
| `getSessionFilePath?(projectPath, sessionId)` | Path to appendable session file for file-based `ThinkingWatcher` |
| `parseThinkingBlocks?(line)` | Extracts thinking texts from one JSONL line |
| `watchSessionLabel?(projectPath, sessionId, onLabel)` | Optional stream of session title updates |
| `resolveOwnerPid?(candidatePids)` | Legacy process-tree lookup (no longer used by `PtyManager.assignNewSession`) |
| `headless?: HeadlessCapability` | Non-interactive execution adapter for pipeline steps and plan Orchestrator calls |

**Optional — settings:**

| Member | Description |
|--------|-------------|
| `settingsFields?(): SettingsField[]` | Configurable fields rendered in Settings → CLI Settings |
| `getSettings?(): Promise<Record<string, unknown>>` | Load current settings values |
| `updateSettings?(values): Promise<void>` | Persist updated settings values |

**Optional — accounts & usage:**

| Member | Description |
|--------|-------------|
| `isLoggedIn?(): Promise<boolean>` | Whether the user is currently authenticated |
| `getLoginIdentifier?(): Promise<string \| null>` | Email, username, or label of the active user |
| `exportCredentials?(): Promise<Record<string, unknown> \| null>` | Serialise current credentials |
| `importCredentials?(credentials): Promise<void>` | Restore previously exported credentials |
| `clearCredentials?(): Promise<void>` | Remove local credentials without server-side revocation |
| `accountHint?(): Promise<string \| null>` | Extra note shown in Account Manager |
| `refreshAccountState?(): Promise<void>` | Refresh cached/derived account state when Account Manager displays the tool |
| `accountSwitchNeedsRestart?(): boolean` | Whether open tabs must restart on account change (default `true`) |
| `getUsageInfo?(cacheMaxAgeMs?): Promise<UsageInfo \| null>` | Usage/quota data for desktop status bar and Remote Access |

---

## Tool Registry

`src/main/pty/cliTools/registry.ts` is the single registration point:

```ts
const cliToolRegistry: CliTool[] = [
  claudeCodeTool, qwenCodeTool, openCodeTool, cursorAgentTool,
  codexTool, devinTool, antigravityTool
]

export function getRegisteredTools(): CliTool[]
export function getToolById(id: string): CliTool | undefined
export function getDefaultTool(activatedTools: string[]): CliTool
```

`getDefaultTool` returns the first tool whose id appears in `activatedTools`. If `activatedTools` is empty, it returns `plainShellTool`.

`plainShellTool` lives in `builtinTools` (not `cliToolRegistry`) and is never shown in CLI Tools Manager.

---

## Activation

Activation is user-driven and on-demand (never automatic).

### State storage

`activatedTools: string[]` is stored in `aide-state.json` (Electron `userData` directory, app-level):

```json
{
  "activatedTools": ["claude-code", "codex"]
}
```

### Activation flow

1. User opens **Tools → Manage CLI Tools**.
2. Window lists all tools in `cliToolRegistry` with tool ID (copyable), `installUrl`, and activation state.
3. User clicks **Activate**.
4. Main process calls `tool.installProblem()` if defined, else `tool.isInstalled()` (reporting `"Not found in PATH"` on `false`).
5. Result is shown immediately:
   - Success → tool added to `activatedTools`, button changes to **Activated ▾**.
   - Failure → error message + **↗ Install** link using `tool.installUrl`.
6. User can deactivate via **Activated ▾ → Deactivate**.

---

## Fallback (`plain-shell`)

`src/main/pty/cliTools/plainShell.ts` implements a minimal fallback:
- `id: 'plain-shell'`, `name: 'Terminal'`
- `isInstalled()` → `true`, `hasAccountSystem()` → `false`
- `newSessionCommand()` / `resumeCommand()` → `''` (plain interactive shell)
- `scanSessions()` → `[]`, `watchForNewSessions()` → no-op

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
    └─ NO  → proceed normally, defaultToolId = project default or first activated tool
```

---

## Session Attribution, Launch & Hooks

Every session tab carries a `toolId` and its own `tool: CliTool` reference inside `PtyManager`.

### Launch environment & command

`PtyManager.spawnPty()` launches the platform shell (`defaultShell(command)` in `src/main/platform/index.ts` — PowerShell `-NoExit -EncodedCommand` on Windows, login shell `-l -c` on POSIX) with:
- `env.AIDE_TAB_ID = tabId`
- `env.PWD = projectPath`
- `tool.getEnvOverrides?.()` (proxy + `NO_PROXY`)
- `prepareLaunch(ctx).env`
- Command: `${baseCommand}${additions.args ?? ''}`

### AIDE's MCP server & deterministic hook binding

- **AIDE MCP (`src/main/aideMcp/launch.ts`, `docs/aide-mcp-launch.md`):** when AIDE's server starts, `setLaunchMcpProvider` feeds `ctx.mcpServers` to `prepareLaunch(ctx)` for every tool with `aideMcp.supported === true` and `aideMcpServer !== false`.
- **HookServer (`src/main/hooks/hookServer.ts`):** an app-wide localhost HTTP server (`POST /hook?tab=<tabId>&event=<name>&token=<token>`) provides authoritative `tabId → { sessionId, transcriptPath }` binding for CLIs that wire `ctx.hook` in `prepareLaunch` (Claude Code, Devin).
- **Fallback binding:** for tools without hooks, `watchForNewSessions` binds automatically when a single tab of that tool is waiting for a session ID.

### Idle detection & Strategist `EventRelay`

`tabActivity` (`src/main/pty/tabActivity.ts`) tracks whether each tab's CLI is idle:
- Marked **idle** when the tool emits `'completeAndWait'` via `registerSignalHandler`.
- Marked **busy** when the user submits input, AIDE pastes a prompt, or the tab calls AIDE's pipeline MCP server.
- `EventRelay` (`src/main/pipeline/eventRelay.ts`) delivers missed pipeline/plan events to an idle Strategist tab via `PtyManager.submitWhenReady` → `submitPastedInput` (using `interactiveSubmitSequence`).

---

## Headless Execution & Pipelines

Tools that set `CliTool.headless` (`src/main/pipeline/headless/types.ts`) are automatically available to pipeline `agent` steps, plan Orchestrator calls, and `pipeline_smoke`.

- Launched via `startHeadless(tool, options)` (`src/main/pipeline/headless/index.ts`), which merges `tool.getEnvOverrides()` and provides a per-CLI `<userData>/headless/<toolId>` state directory.
- Optional `resultTool: true` lets adapters without native structured output receive a per-visit `submit_result` MCP tool from AIDE's pipeline server.
- Per-CLI accepted `effort` levels are validated by `EFFORTS` in `src/main/pipeline/engine/validate.ts`.
- See [`headless-cli-matrix.md`](headless-cli-matrix.md) for per-CLI details.

---

## Default Tool (per project) & New Session Button

Each project stores its last-used tool in `.aide/users/<user>/settings.json` (`defaultToolId`). Switching tools from the **New Session ▾** dropdown updates `defaultToolId` immediately. If absent or deactivated, the first activated tool is used.

---

## Settings — Per-Tool Sections

`SettingsApp.tsx` (**CLI Settings** tab) renders one `<fieldset>` per activated tool. For every activated tool, `tool-settings:get-all` (`src/main/ipc/index.ts`) combines:
1. `tool.settingsFields?.()`
2. `aideMcpField(tool)` (*Give AIDE's MCP server to this CLI*), when `tool.aideMcp` is declared
3. `EVENT_MESSAGES_FIELD` (*Send pipeline events to the orchestrator as messages*)

Supported `SettingsField` (`src/shared/settingsTypes.ts`) properties: `type` (`'string' | 'boolean' | 'number' | 'password' | 'select'`), `options`, `default`, `disabled`, `visibleWhen`.

---

## Accounts, Account Manager & Account Pool

For activated tools with `hasAccountSystem() === true`:
- **Settings** shows a login summary row per tool.
- **Account Manager** (`AccountManagerApp.tsx`) allows saving, loading, updating, deleting, ordering, and checking accounts for the **Pipeline Account Pool**, plus calls `refreshAccountState()` and displays `accountHint()`.
- **Load Account** application menu provides quick switching.
- On interactive account switch, `offerRestartAfterAccountChange()` (`src/main/pty/registry.ts`) asks to restart open tabs unless `tool.accountSwitchNeedsRestart?.() === false`.
- **Pipeline Account Pool** (`src/main/pipeline/accountPool.ts`, `docs/account-pool.md`) rotates automatically to the next checked account when a headless step hits `error.code === 'limit'`.

Tools with `hasAccountSystem() === false` are excluded from `accounts:get-tools` and Account Manager, while `getLoginIdentifier()` is still shown in the status bar as a static label.

---

## IPC Summary

| Channel | Direction | Description |
|---------|-----------|-------------|
| `cli-tools:list` | renderer → main | List registered tools `{ id, name }` |
| `cli-tools:get-all` | renderer → main | List all registered tools with `installUrl` and activation state |
| `cli-tools:activate` | renderer → main | Validate via `installProblem()` / `isInstalled()` and activate |
| `cli-tools:deactivate` | renderer → main | Remove tool from `activatedTools` |
| `cli-tools:closed` | renderer → main | CLI Tools window closed (unblocks startup session init) |
| `tool-settings:get-all` | renderer → main | Tool fields + common fields (`aideMcpServer`, `pipelineEventMessages`) and values |
| `tool-settings:update` | renderer → main | Persist tool settings and common settings |
| `accounts:get-tools` | renderer → main | Activated tools with `hasAccountSystem() === true` |
| `accounts:is-logged-in` | renderer → main | Login state for a tool |
| `accounts:get-login-identifier` | renderer → main | Current user identifier for a tool |
| `accounts:refresh-state` | renderer → main | Calls `tool.refreshAccountState()` |
| `accounts:get-hint` | renderer → main | Calls `tool.accountHint()` |
| `accounts:list` / `save-current` / `load` / `update` / `delete` / `set-in-pool` / `move` | renderer → main | Saved account and pool management |

---

## File Map

```
src/shared/
  settingsTypes.ts            — SettingsField

src/main/pty/
  ptyManager.ts               — per-tab CliTool lifecycle, prepareLaunch, health checks, signals, submitPastedInput
  registry.ts                 — ptyRegistry, offerRestartAfterAccountChange()
  tabActivity.ts              — idle/busy state per tab (drives EventRelay)
  cliTools/
    types.ts                  — CliTool interface, LaunchContext, LaunchMcpServer, ToolView, HistoryEntry, UsageInfo
    registry.ts               — cliToolRegistry, getRegisteredTools(), getToolById(), getDefaultTool()
    launchFiles.ts            — per-tab launch file helpers + shellLiteral()
    startupHealth.ts          — tuiReadyForInput()
    toolViews.ts              — per-CLI native tool → ToolView mappers
    sessionMetaCache.ts       — persistent transcript metadata cache
    cliLogger.ts              — Log Panel helper
    claudeCode.ts / claudeCodeScanner.ts / claudeHooks.ts
    codex.ts / codexScanner.ts / codexUsage.ts
    cursorAgent.ts / cursorAgentScanner.ts / cursorAgentStoreScanner.ts
    devin.ts / devinScanner.ts / devinHooks.ts / devinMcp.ts
    openCode.ts / openCodeScanner.ts / openCodeAuth.ts / openCodeParts.ts
    qwenCode.ts / qwenCodeScanner.ts
    antigravity.ts
    plainShell.ts             — built-in fallback

src/main/aideMcp/
  launch.ts                   — aideMcpField(), aideMcpEnabled(), aideMcpServers()

src/main/hooks/
  hookServer.ts               — app-wide localhost HTTP receiver for deterministic tab binding

src/main/thinking/
  thinkingWatcher.ts          — JSONL tail-watcher + history-stream thinking extractor

src/main/accounts/
  accountSwitch.ts            — headless/pool account switching + active credential sync
  accountInfo.ts / accountDisplay.ts

src/main/pipeline/
  index.ts                    — pipelineManager, headless CLI discovery, launch MCP provider wiring
  accountPool.ts              — automatic pool rotation on headless usage limits
  eventRelay.ts               — delivers missed pipeline/plan events to idle tabs
  smoke.ts                    — pipeline_smoke CLI verification
  engine/validate.ts          — EFFORTS table & schema validation per CLI
  headless/
    types.ts / index.ts / common.ts
    claudeHeadless.ts / codexHeadless.ts / cursorHeadless.ts / devinHeadless.ts / openCodeHeadless.ts

src/main/remote/
  index.ts                    — Remote Access (uses scanSessions, history, contextInsert, getUsageInfo)

src/main/windows/
  cliTools.ts                 — CLI Tools Manager window
  accountManager.ts           — Account Manager window
  historyViewer.ts            — History Viewer window

src/main/ipc/
  index.ts                    — cli-tools:*, tool-settings:*, accounts:* handlers

src/renderer/src/windows/
  CliToolsApp.tsx             — CLI Tools Manager UI
  SettingsApp.tsx             — CLI Settings tab (per-tool sections + work instruction + accounts summary)
  AccountManagerApp.tsx       — Account Manager & Pool UI
```
