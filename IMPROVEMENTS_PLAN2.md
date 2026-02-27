# AIDE — Improvements Plan 2

---

## Feature List & Complexity

| # | Feature | Complexity |
|---|---------|------------|
| 1 | Terminal: right-click copy/paste, remove context menu, fix selection | Low |
| 2 | Terminal: focus after "Add to Claude context" | Low |
| 3 | Session picker: preview last 5 KB of conversation | Medium |
| 4 | Dead session detection: auto-remove tab + notification | Medium |
| 5 | Terminal tab: close button | Low |
| 6 | Restore all open sessions on startup | Medium |
| 7 | Account management for CLI tools | High |

---

## 1. Terminal: Right-click copy/paste, fix selection

**Complexity: Low** (~1–2 h)

**Problem:** Custom `TerminalContextMenu` intercepts `mousedown`/`contextmenu` events, which interferes with xterm.js text selection (xterm.js owns mouse handling internally). PowerShell terminal works because it has its own ConPTY layer. The custom menu provides Copy/Paste — replacing it with direct right-click behavior removes the conflict.

**Work:**
- Remove `TerminalContextMenu` component and `ctxMenu` state from `TerminalPanel.tsx`
- Remove `handleContextMenu` handler and `onContextMenu` prop
- Add `onMouseDown` on the xterm container: if `button === 2` (right click):
  - If `terminal.hasSelection()` → `navigator.clipboard.writeText(terminal.getSelection())` + `terminal.clearSelection()`
  - Else → `navigator.clipboard.readText().then(t => ptyWrite(t))`
- xterm.js option `rightClickSelectsWord: false` (default) — keep default

**Files:** `TerminalPanel.tsx`

---

## 2. Terminal: Focus after "Add to Claude context"

**Complexity: Low** (~30 min)

**Problem:** `handleAddToContext` in `FileTree.tsx` calls `terminalWrite` but does not restore focus to the terminal. Drag & drop already calls `fitFunctions.current.get(activeTabId)?.focus()`. The context menu path lacks the equivalent.
**Second** click on CLI tab does not focus CLI inside

**Work:**
- Add IPC handler `terminal:focus-active` (or reuse existing `terminalWrite` flow) that focuses the active xterm instance
- OR: expose a renderer-side event bus call from the file tree to `TerminalPanel`
- Simplest: add a `terminalFocus()` call in `window.editorApi` via preload that sends IPC → renderer emits a custom event → `TerminalPanel` listens and calls `fitFunctions.current.get(activeTabId)?.focus()`
- Alternative (simpler, no new IPC): move focus call into `TerminalPanel` by listening on a Zustand event fired from `FileTree`

**Files:** `FileTree.tsx`, `TerminalPanel.tsx`, optionally `preload/editor.ts` + `ipc/index.ts`

---

## 3. Session picker: preview last 5 KB of conversation

**Complexity: Medium** (~3–4 h)

**Problem:** Session picker shows slug + timestamp. User can't see what was discussed without resuming the session.

**Work:**
- In `sessionScanner.ts`: add `readSessionPreview(sessionsDir, sessionId): string` — reads the JSONL file from the end (last ~5 KB), collects assistant + user message content lines, formats as plain text snippet. Skip tool calls, meta entries, `<command` blocks (same filter as `readLastUserMessage`).
- Add `preview?: string` field to `DiskSession`
- In `SessionPickerApp.tsx`: add expand/collapse toggle per row (small `▼` / `▲` button)
- When expanded: show preview text in a monospace `<pre>` block below the row, max-height with scroll
- Preview is loaded lazily on first expand via IPC call `sessions:get-preview` (avoid loading all previews upfront)
- New IPC: `sessions:get-preview` → returns preview string for a given sessionId

**Files:** `sessionScanner.ts`, `SessionPickerApp.tsx`, `ipc/index.ts`, `preload/editor.ts`, `env.d.ts`

---

## 4. Dead session detection

**Complexity: Medium** (~3–4 h)

**Problem:** `claude --resume <id>` outputs `No conversation found with session ID: <id>` to stdout when the session doesn't exist. Other CLI tools have their own error messages. Detection logic must not be hardcoded in `ptyManager`.

**Design: `checkResumeHealth` on `CliTool` interface**

```typescript
// types.ts
interface CliTool {
  // existing...
  checkResumeHealth?(
    accumulated: string,
    elapsedMs: number
  ): 'ok' | 'dead' | 'pending'
}
```

- `ptyManager` starts a **health-check window** per tab after sending the resume command
- On every `pty.onData`: append to per-tab `resumeBuf`, call `tool.checkResumeHealth(buf, elapsed)`
- On `'ok'` or `'dead'`: stop watching, clear buffer
- Hard timeout (12 s) with no verdict → assume `'ok'` (slow startup ≠ dead)
- On `'dead'`: emit `terminal:dead-session { tabId, slug }` IPC to renderer

```typescript
// claudeCode.ts
checkResumeHealth(accumulated, elapsedMs) {
  if (accumulated.includes('No conversation found with session ID')) return 'dead'
  if (accumulated.includes('? for shortcuts')) return 'ok'  // Claude's startup banner
  if (elapsedMs > 12000) return 'ok'
  return 'pending'
}

// openCode.ts (future)
checkResumeHealth(accumulated, elapsedMs) {
  if (accumulated.includes('Session not found')) return 'dead'
  // ...
  return 'pending'
}
```

**Renderer side:**
- `TerminalPanel.tsx` subscribes to `terminal:dead-session`
- On event: close the tab (`closeTab(tabId)` → kills PTY, removes from store)
- Show notification dialog:
  ```
  Session not found
  ─────────────────────────────────────────
  Session "brave-debugging-quest" was not found.
  The tab has been closed.

  [ OK ]   [ Start New Session ]
  ```
- "Start New Session" → `terminalCreateNewSession()` (existing IPC)

**Session cleanup:**
- JSONL file on disk is not deleted — belongs to Claude's storage
- If feature 6 is implemented: also remove from persisted open-sessions list

**Files:** `cliTools/types.ts`, `cliTools/claudeCode.ts`, `ptyManager.ts`, `TerminalPanel.tsx`, `ipc/index.ts`, `preload/editor.ts`, `env.d.ts`

---

## 5. Terminal tab: close button

**Complexity: Low** (~1–2 h)

**Work:**
- Add `×` button inside `TabButton` component in `TerminalPanel.tsx`
- Button visible on hover (CSS), always visible for inactive tabs to reduce accidental closes
- On click: call `closeTab(tabId)` action
- `closeTab` in `useSessionStore`: removes tab from store
- New IPC `terminal:close-tab { tabId }` → `ptyManager.closeTab(tabId)`: kills PTY, removes from `this.tabs`
- Edge case: closing the active tab → activate the nearest remaining tab; can't close last

**Files:** `TerminalPanel.tsx`, `useSessionStore.ts`, `ptyManager.ts`, `ipc/index.ts`, `preload/editor.ts`, `env.d.ts`

---

## 6. Restore all open sessions on startup

**Complexity: Medium** (~4–5 h)

**Problem:** Currently only the most recent session is resumed on startup. All other open tabs are lost.

**Design:**
- Persist open session IDs in `aide-state.json` per project:
  ```json
  {
    "recentProjects": [...],
    "openSessions": {
      "E:\\Projects\\AIDE": {
        "tabs": [
          { "sessionId": "abc-123", "tool": "claude-code" },
          { "sessionId": "def-456", "tool": "claude-code" }
        ],
        "activeSessionId": "abc-123"
      }
    }
  }
  ```
- `tool` field is the CLI tool identifier — needed for multi-provider support (E batch abstraction already exists)

**Work:**

**Persistence:**
- `appState.ts`: add `openSessions` field to `AppState`, add `saveOpenSessions(projectPath, tabs, activeId)` and `loadOpenSessions(projectPath)` helpers
- Save: IPC handler `state:save-open-sessions` called from renderer on tab add/remove/switch
- In `TerminalPanel.tsx`: call save on every `openTabs` / `activeTabId` change (debounced, ~500ms)

**Restore:**
- `ptyManager.ts` `createInitialTab()` → renamed to `createInitialTabs()`, returns `SessionTabInfo[]`
- Reads persisted tabs from `loadOpenSessions(projectPath)`
  - If persisted list exists: spawn one PTY per saved sessionId in order, return array
  - If no persisted list: fall back to current behavior (last session or new session)
- `ptyManager.ts` needs IPC change: `terminal:create-initial` now returns `SessionTabInfo[]`
- `TerminalPanel.tsx` `initWithTab` → add `initWithTabs(tabs[], activeId)` to store
- Dead session detection (feature 4) handles the case where a persisted session no longer exists

**Files:** `appState.ts`, `ptyManager.ts`, `useSessionStore.ts`, `TerminalPanel.tsx`, `ipc/index.ts`, `preload/editor.ts`, `env.d.ts`

---

## 7. Account management for CLI tools

**Complexity: High** (~10–14 h)

**Design overview:**
- Accounts are snapshots of CLI credential files. For Claude Code: `~/.claude/` directory contents (primarily `.claude/claude.json` or OAuth tokens). Exact files TBD by inspecting what `claude` stores after login.
- Accounts stored in AIDE's userData: `aide-accounts.json`
  ```json
  {
    "claude-code": [
      { "id": "uuid", "name": "Work account", "savedAt": "2026-02-27T...", "credentials": { ... } }
    ]
  }
  ```
- "Checking if logged in" = verifying credential files exist and are non-empty (each CLI tool implements this check as part of `CliTool` interface extension)

### 7.1 CliTool interface extension

Add to `types.ts`:
```typescript
interface CliTool {
  // existing...
  id: string                          // e.g. "claude-code"
  displayName: string                 // e.g. "Claude Code"
  isLoggedIn(): Promise<boolean>
  exportCredentials(): Promise<Record<string, unknown>>
  importCredentials(creds: Record<string, unknown>): Promise<void>
}
```

For `claudeCodeTool`: credentials = relevant fields from `~/.claude/` config files.

### 7.2 Storage

New file `src/main/config/accountStorage.ts`:
- `loadAccounts(toolId)` / `saveAccount(toolId, name, creds)` / `deleteAccount(toolId, id)` / `updateAccount(toolId, id, creds)`
- Stored in `aide-accounts.json` in `userData`

### 7.3 IPC handlers

New IPC group `accounts:*`:
- `accounts:list { toolId }` → `CliAccount[]`
- `accounts:save-current { toolId, name }` → `CliAccount` (calls `tool.exportCredentials()`)
- `accounts:delete { toolId, accountId }` → `void`
- `accounts:update { toolId, accountId }` → re-runs `exportCredentials`, updates stored record
- `accounts:load { toolId, accountId }` → calls `tool.importCredentials(creds)`, returns `void`
- `accounts:is-logged-in { toolId }` → `boolean`

### 7.4 Menu integration

In `menu/index.ts`, add "CLI" top-level menu:
```
CLI
  Manage Accounts...    → opens AccountManager window
  ──────────────────
  Load Account        ▶ → submenu per tool, then per saved account
    Claude Code       ▶
      Work account
      Personal
```

"Load Account" submenu is dynamic — rebuilt on `rebuildMenu()`. On account click:
- Call `accounts:load { toolId, accountId }`
- Show dialog: "Restart required to apply account change." → `[ Restart Later ]` `[ Restart Now ]`
- "Restart Now" → `app.relaunch()` + `app.exit(0)`

### 7.5 Account Manager window

New Electron window (`src/main/windows/accountManager.ts`), new renderer entry (`AccountManagerApp.tsx`).

UI:
```
┌─ Manage Accounts ─────────────────────────────────────┐
│  [ Claude Code ]  [ Aider ]  ...                       │  ← tabs per CLI tool
│  ──────────────────────────────────────────────────── │
│  Status: ● Logged in                                   │
│                                                        │
│  Saved accounts                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Work account          saved 2026-02-01  [Update] [Delete] │
│  │ Personal              saved 2026-01-15  [Update] [Delete] │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  [ Save Current As... ]                                │
│                                              [ Close ] │
└────────────────────────────────────────────────────────┘
```

- **Status** — `accounts:is-logged-in` on mount; shows "● Logged in" / "○ Not logged in"
- **Save Current As...** — if not logged in: show error toast "Not logged in to Claude Code". If logged in: prompt for account name → `accounts:save-current`
- **Update** — re-exports current credentials into the saved account slot (`accounts:update`) with confirmation dialog
- **Delete** — `accounts:delete` with confirm

### 7.6 Work breakdown

| Sub-task | Time |
|---|---|
| `CliTool` interface extension + `claudeCode.ts` implementation | 2 h |
| `accountStorage.ts` + IPC handlers | 2 h |
| Menu integration (static "Manage Accounts" + dynamic "Load Account" submenu) | 1.5 h |
| Restart dialog | 0.5 h |
| `AccountManagerApp.tsx` + window setup | 3 h |
| Testing & edge cases (not logged in, corrupt creds, etc.) | 1 h |

---

## Implementation Order (suggested)

1. **1** — Terminal right-click (unblocks usability issue, quick win)
2. **2** — Terminal focus after add-to-context (quick win)
3. **5** — Tab close button (quick win)
4. **4** — Dead session detection (depends on none; needed before 6)
5. **6** — Restore all sessions on startup (depends on 4)
6. **3** — Session picker preview (independent)
7. **7** — Account management (independent, largest)
