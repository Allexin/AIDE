# Multi-CLI Implementation Steps

Step-by-step guide for implementing multi-CLI support in AIDE.
Each step is independently buildable and testable. Complete them in order.

Reference: `docs/multi-cli-architecture.md`

---

## Step 1 — Extend CliTool interface

**File:** `src/main/pty/cliTools/types.ts`

Add to the `CliTool` interface:

```ts
readonly installUrl?: string
isInstalled(): Promise<boolean>
settingsFields?(): SettingsField[]
getSettings?(): Promise<Record<string, unknown>>
updateSettings?(values: Record<string, unknown>): Promise<void>
```

Add the new `SettingsField` interface (before `CliTool`):

```ts
export interface SettingsField {
  key: string
  label: string
  description?: string
  type: 'string' | 'boolean' | 'number' | 'password' | 'select'
  options?: Array<{ value: string; label: string }>
  default?: unknown
}
```

**Verify:** `npm run typecheck` — will fail on claudeCode.ts until Step 2.

---

## Step 2 — Implement new interface members in claudeCode.ts

**File:** `src/main/pty/cliTools/claudeCode.ts`

Add `installUrl` and `isInstalled()` to `claudeCodeTool`:

```ts
installUrl: 'https://claude.ai/download',

async isInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('where', ['claude'], { timeout: 3000 }, (err) => resolve(!err))
  })
},
```

Add `settingsFields()`, `getSettings()`, `updateSettings()` — leave as minimal stubs for now
(can be filled with real Claude Code settings in a later pass):

```ts
settingsFields(): SettingsField[] {
  return []
},

async getSettings(): Promise<Record<string, unknown>> {
  return {}
},

async updateSettings(_values: Record<string, unknown>): Promise<void> {
  // no-op until settings are defined
},
```

Also fix the `watchForNewSessions` slug hardcode: extract a top-level constant:

```ts
const TOOL_NAME = 'Claude Code'

// then in watchForNewSessions:
onNew({ sessionId, slug: TOOL_NAME, lastModified: new Date() })
```

**Verify:** `npm run typecheck` passes.

---

## Step 3 — Create plainShell fallback tool

**File:** `src/main/pty/cliTools/plainShell.ts` (new file)

```ts
import type { CliTool } from './types'

export const plainShellTool: CliTool = {
  id: 'plain-shell',
  name: 'Terminal',

  async isInstalled(): Promise<boolean> { return true },

  newSessionCommand(): string { return '' },
  resumeCommand(_sessionId: string): string { return '' },

  async scanSessions(_projectPath: string) { return [] },

  watchForNewSessions(_projectPath, _onNew) { return () => {} },
}
```

**Verify:** `npm run typecheck` passes.

---

## Step 4 — Update registry

**File:** `src/main/pty/cliTools/registry.ts`

Add `getDefaultTool` and import `plainShellTool`:

```ts
import type { CliTool } from './types'
import { claudeCodeTool } from './claudeCode'
import { plainShellTool } from './plainShell'

const cliToolRegistry: CliTool[] = [claudeCodeTool]

export function getRegisteredTools(): CliTool[] {
  return cliToolRegistry
}

export function getToolById(id: string): CliTool | undefined {
  if (id === plainShellTool.id) return plainShellTool
  return cliToolRegistry.find((t) => t.id === id)
}

export function getDefaultTool(activatedTools: string[]): CliTool {
  const first = cliToolRegistry.find((t) => activatedTools.includes(t.id))
  return first ?? plainShellTool
}
```

**Verify:** `npm run typecheck` passes.

---

## Step 5 — Add activatedTools to AppState

**File:** `src/main/config/appState.ts`

Add `activatedTools` and `toolId` to the state types:

```ts
export interface SavedSessionEntry {
  sessionId: string
  title: string
  toolId: string   // new
}

export interface AppState {
  recentProjects: RecentProject[]
  openSessions: Record<string, ProjectOpenSessions>
  activatedTools: string[]   // new
}

const DEFAULTS: AppState = {
  recentProjects: [],
  openSessions: {},
  activatedTools: []
}
```

Add helpers:

```ts
export function getActivatedTools(): string[] {
  return state.activatedTools
}

export function setActivatedTools(ids: string[]): void {
  state.activatedTools = ids
  saveAppState()
}
```

**Note:** Existing `SavedSessionEntry` records on disk won't have `toolId`. When loading,
default missing `toolId` to `'claude-code'` for backward compatibility.

In `loadOpenSessions` usage sites (ipc/index.ts), add a migration guard:

```ts
const loaded = loadOpenSessions(projectPath)
if (loaded) {
  loaded.tabs = loaded.tabs.map(t => ({ ...t, toolId: t.toolId ?? 'claude-code' }))
}
```

**Verify:** `npm run typecheck` passes.

---

## Step 6 — Update PtyManager for per-tab tool

**File:** `src/main/pty/ptyManager.ts`

This is the largest structural change.

### 6a — Update PtyTab

```ts
import { getToolById, getDefaultTool } from './cliTools/registry'

interface PtyTab extends SessionTabInfo {
  pty: nodePty.IPty
  tool: CliTool        // replaces the shared this.tool
}
```

### 6b — Update constructor

```ts
constructor(win: BrowserWindow, projectPath: string) {
  this.win = win
  this.projectPath = projectPath
  // no more this.tool — each tab carries its own
}
```

### 6c — Replace all this.tool.X references

Every call like `this.tool.prepareProject(...)` becomes a per-tab or per-call lookup.
For `createInitialTabs`, `prepareProject` should be called once per unique tool in the
session list, not once globally. For `createNewSessionTab(toolId)`, look up the tool via
`getToolById(toolId)`.

### 6d — Fix getActiveSessions fallback

```ts
title: this.titleCache.get(t.tabId) ?? t.tool.name   // was 'Claude Code'
```

### 6e — Update createInitialTabs signature

```ts
async createInitialTabs(
  saved?: SavedSessionEntry[],
  activeSessionId?: string | null,
  activatedTools: string[] = []
): Promise<...>
```

For each saved entry, resolve the tool:

```ts
const tool = getToolById(entry.toolId) ?? getDefaultTool(activatedTools)
```

### 6f — Update createNewSessionTab

```ts
async createNewSessionTab(toolId: string, activatedTools: string[]): Promise<SessionTabInfo>
```

**Verify:** `npm run typecheck` passes.

---

## Step 7 — Add toolId to renderer session store

**File:** `src/renderer/src/store/useSessionStore.ts`

Update `SessionTab`:

```ts
export interface SessionTab {
  tabId: string
  sessionId: string | null
  toolId: string        // new
  slug: string
  exited: boolean
  attention: boolean
}
```

Update `SessionTabInfo` (the IPC transfer type) to carry `toolId` and `toolName`:

```ts
interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  title?: string
  toolId: string
  toolName: string
}
```

Replace all `'Claude Code'` fallback strings with `tab.toolName || tab.toolId`.

**Verify:** `npm run typecheck` passes.

---

## Step 8 — IPC: cli-tools handlers

**File:** `src/main/ipc/index.ts`

Add three handlers:

```ts
ipcMain.handle('cli-tools:get-all', async () => {
  const activated = getActivatedTools()
  return getRegisteredTools().map((t) => ({
    id: t.id,
    name: t.name,
    installUrl: t.installUrl ?? null,
    activated: activated.includes(t.id),
  }))
})

ipcMain.handle('cli-tools:activate', async (_e, toolId: string) => {
  const tool = getToolById(toolId)
  if (!tool) return { ok: false, error: 'Unknown tool' }
  try {
    const installed = await tool.isInstalled()
    if (!installed) return { ok: false, error: 'Not found in PATH' }
    const current = getActivatedTools()
    if (!current.includes(toolId)) setActivatedTools([...current, toolId])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('cli-tools:deactivate', (_e, toolId: string) => {
  setActivatedTools(getActivatedTools().filter((id) => id !== toolId))
})
```

**Verify:** `npm run typecheck` passes.

---

## Step 9 — IPC: tool-settings handlers

**File:** `src/main/ipc/index.ts`

```ts
ipcMain.handle('tool-settings:get-all', async () => {
  const activated = getActivatedTools()
  const results = []
  for (const tool of getRegisteredTools()) {
    if (!activated.includes(tool.id)) continue
    if (!tool.settingsFields) continue
    const fields = tool.settingsFields()
    const values = tool.getSettings ? await tool.getSettings() : {}
    results.push({ toolId: tool.id, name: tool.name, fields, values })
  }
  return results
})

ipcMain.handle('tool-settings:update', async (_e, toolId: string, values: Record<string, unknown>) => {
  const tool = getToolById(toolId)
  if (tool?.updateSettings) await tool.updateSettings(values)
})
```

**Verify:** `npm run typecheck` passes.

---

## Step 10 — Create CLI Tools Manager window

### 10a — Main process window

**File:** `src/main/windows/cliTools.ts` (new)

Pattern: follow `src/main/windows/sessionPicker.ts`.

```ts
export function openCliToolsWindow(parentWin: BrowserWindow): BrowserWindow
```

The window is modal (`modal: true`, `parent: parentWin`), ~480×400px.
On close it sends `cli-tools:closed` to the parent window via IPC.

### 10b — Preload bridge

**File:** `src/preload/cliTools.ts` (new)

Expose to renderer:
- `getAll(): Promise<CliToolEntry[]>`
- `activate(toolId: string): Promise<{ ok: boolean; error?: string }>`
- `deactivate(toolId: string): Promise<void>`
- `close(): void` — sends `cli-tools:closed`

### 10c — UI

**File:** `src/renderer/src/windows/CliToolsApp.tsx` (new)

Renders a list of `CliToolEntry` items. Each row:

- Tool name (bold) + `installUrl` link (small, muted)
- Right side: **Activate** button (inactive) or **Activated ▾** dropdown with Deactivate
- On Activate click: show spinner → call `activate()` → show result inline

When `activatedTools` list is empty: show footer note about plain-shell fallback.

**Verify:** Window opens from menu, activation flow works end-to-end.

---

## Step 11 — Add menu item

**File:** `src/main/menu/index.ts`

Add under a **Tools** top-level menu (create if absent):

```ts
{ label: 'Manage CLI Tools...', click: () => openCliToolsWindow(mainWin) }
```

**Verify:** Menu item appears and opens the window.

---

## Step 12 — Startup gate

**File:** `src/main/ipc/index.ts` — in the `terminal:create-initial` handler (or the project
open logic that calls it)

Before creating session tabs:

```ts
const activated = getActivatedTools()
if (activated.length === 0) {
  // Open CLI Tools Manager and wait for it to close
  const cliWin = openCliToolsWindow(editorWin)
  await new Promise<void>((resolve) => {
    ipcMain.once('cli-tools:closed', () => resolve())
    cliWin.on('closed', resolve)  // safety: resolve even if IPC not sent
  })
}
// Proceed — if still empty, getDefaultTool() returns plainShellTool
```

**Verify:** Fresh install (empty `activatedTools`) opens CLI Tools window on first project open.

---

## Step 13 — New Session button dropdown

**File:** `src/renderer/src/components/layout/TerminalPanel.tsx`

Update the New Session button:

1. Read `activatedTools` list via a new store value or IPC call on mount.
2. Read `defaultToolId` from project settings IPC.
3. Render:
   - Left area (clickable): creates new session with `defaultToolId`
   - Below the label: tool name in small muted text
   - Right `▾` button: opens dropdown listing activated tools by name
4. On dropdown selection:
   - Call `project-settings:set-default-tool(toolId)` IPC
   - Update local state so the label refreshes

Add IPC handlers for `project-settings:get-default-tool` and
`project-settings:set-default-tool` that read/write `.aide/settings.json`.

**Verify:** Dropdown shows only activated tools, selecting one persists across restart.

---

## Step 14 — Settings per-tool sections

**File:** `src/renderer/src/windows/SettingsApp.tsx`

On mount, call `tool-settings:get-all`. For each result, render a `<fieldset>` with the
tool's `name` as legend. Render each `SettingsField` as the appropriate input type.

On Save, collect changed values per `toolId` and call `tool-settings:update` for each.

**Verify:** Claude Code fieldset appears (even if empty for now). A second activated tool
gets its own fieldset.

---

## Step 15 — Settings accounts section

**File:** `src/renderer/src/windows/SettingsApp.tsx`

Replace the hardcoded Claude Code account row with a dynamic list:

1. Call `accounts:get-tools` → get `{ id, name, hasAccount }[]` for activated tools.
2. For each with `hasAccount: true`, call `accounts:get-login-identifier(id)`.
3. Render a row per tool: name + identifier (or "Not logged in") + [Switch] / [Login].

Update `accounts:get-tools` handler in `ipc/index.ts` to include `hasAccount`:

```ts
hasAccount: typeof tool.isLoggedIn === 'function'
```

**Verify:** Multiple activated tools show separate account rows.

---

## Step 16 — Remove remaining 'Claude Code' hardcodes

Search for any remaining `'Claude Code'` string literals outside of `claudeCode.ts`:

```
grep -r "Claude Code" src/ --include="*.ts" --include="*.tsx" -l
```

Expected remaining locations after all prior steps:
- `claudeCode.ts` — intentional (tool name constant)
- Comments in `TerminalPanel.tsx` — update or remove

**Verify:** `npm run typecheck` + `npm run build` pass cleanly.

---

## Completion Checklist

- [ ] Step 1 — CliTool interface extended
- [ ] Step 2 — claudeCode.ts updated
- [ ] Step 3 — plainShell.ts created
- [ ] Step 4 — registry updated
- [ ] Step 5 — AppState updated
- [ ] Step 6 — PtyManager per-tab tool
- [ ] Step 7 — useSessionStore toolId
- [ ] Step 8 — cli-tools IPC handlers
- [ ] Step 9 — tool-settings IPC handlers
- [ ] Step 10 — CLI Tools Manager window
- [ ] Step 11 — menu item
- [ ] Step 12 — startup gate
- [ ] Step 13 — New Session button dropdown
- [ ] Step 14 — Settings per-tool sections
- [ ] Step 15 — Settings accounts section
- [ ] Step 16 — remove remaining hardcodes
