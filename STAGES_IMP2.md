# AIDE — Improvements Plan 2 Progress

---

## Batch H — Terminal UX: Right-click, Focus, Close Tab ✅

### H1. Terminal: Right-click copy/paste, fix selection

**Done.** Removed `TerminalContextMe
- **"Add to Claude context"** in FileTree context menu now calls `usePanelStore.getState().focusTerminal()` after writing to PTY, so focus moves to the terminal panel (triggering the 75/25 resize).
- **Tab click** now focuses the xterm instance via `fitFunctions.current.get(tabId)?.focus()` with a 50ms delay (allows the tab switch + fit to complete first). Clicking the already-active tab also re-focuses xterm.

### H3. Terminal tab: Close button
nu` component entirely. Right-click on terminal now directly:
- If text is selected → copies to clipboard + clears selection
- If no selection → pastes from clipboard

This eliminates the custom context menu that was intercepting mouse events and interfering with xterm.js text selection.

### H2. Terminal: Focus after "Add to Claude context" + tab click

**Done.** Two focus fixes:
**Done.** Each terminal tab now shows a `×` close button (visible on hover or when active). Clicking it:
- Sends `terminal:close-tab` IPC → `ptyManager.closeTab(tabId)` kills the PTY and cleans up watchers
- Removes the tab from `useSessionStore` via `closeTab(tabId)`
- If closing the active tab → activates the nearest remaining tab
- Cannot close the last tab (button hidden when only one tab exists)

**New:**
- `PtyManager.closeTab(tabId)` — kills PTY, removes watcher, deletes from map
- `terminal:close-tab` IPC handler (fire-and-forget)
- `terminalCloseTab` in preload + EditorAPI
- `closeTab` action in `useSessionStore`

**Files changed:**
- `src/main/pty/ptyManager.ts` — `closeTab` method
- `src/main/ipc/index.ts` — `terminal:close-tab` handler
- `src/preload/editor.ts` — `terminalCloseTab` method + EditorAPI type
- `src/renderer/src/env.d.ts` — `terminalCloseTab` type
- `src/renderer/src/store/useSessionStore.ts` — `closeTab` action
- `src/renderer/src/components/layout/TerminalPanel.tsx` — removed TerminalContextMenu, right-click copy/paste, tab focus on click, close button in TabButton
- `src/renderer/src/components/filetree/FileTree.tsx` — focus terminal after "Add to Claude context"

---

## Batch I — CLI Startup Health Check + Prompt Wait ✅

### I1. `checkStartupHealth` on CliTool interface

**Done.** New optional method `checkStartupHealth(accumulated, elapsedMs) → 'ok' | 'dead' | 'pending'` on `CliTool`. Inspects accumulated PTY output to determine CLI readiness.

### I2. Claude Code implementation

**Done.** `claudeCodeTool.checkStartupHealth`:
- `'dead'` — output contains `"No conversation found with session ID"`
- `'ok'` — output contains `"? for shortcuts"` (CLI ready prompt)
- `'ok'` — elapsed > 15s (hard timeout fallback)
- `'pending'` otherwise

### I3. Startup monitoring in PtyManager

**Done.** `HealthCheck` Map tracks per-tab state (`buf`, `startTime`, `resolved`, `onResult` callback). Three helpers:
- `startHealthCheck(tabId)` — creates entry, called for every `spawnNewSessionTab` and `spawnResumeTab`
- `feedHealthCheck(tabId, data)` — appends PTY data, calls `checkStartupHealth`, resolves on non-pending
- `waitForReady(tabId)` — returns `Promise<'ok' | 'dead'>`, resolved by health check or 15s hard timeout

Emits IPC events: `terminal:tab-ready { tabId }` on ok, `terminal:dead-session { tabId, sessionId }` on dead.

### I4. Reliable prompt delivery

**Done.** `createNewSessionWithPrompt` replaced blind `setTimeout(2000)` with `await waitForReady(tabId)`. Prompt is written only after CLI signals readiness (`'ok'`). Dead sessions get no prompt.

### I5. Dead session dialog in renderer

**Done.** `TerminalPanel` subscribes to `onTerminalDeadSession`. On event:
- Closes the dead tab (unless last)
- Shows modal dialog: "Session not found. The tab has been closed." with OK / Start New Session buttons

**Files changed:**
- `src/main/pty/cliTools/types.ts` — `checkStartupHealth` method on `CliTool`
- `src/main/pty/cliTools/claudeCode.ts` — implementation
- `src/main/pty/ptyManager.ts` — `HealthCheck`, `startHealthCheck`, `feedHealthCheck`, `waitForReady`, fixed `createNewSessionWithPrompt`
- `src/preload/editor.ts` — `onTerminalTabReady`, `onTerminalDeadSession` listeners + types
- `src/renderer/src/env.d.ts` — `onTerminalTabReady`, `onTerminalDeadSession` types
- `src/renderer/src/components/layout/TerminalPanel.tsx` — dead session handler + dialog UI

---

## Batch J — Restore All Open Sessions on Startup ✅

### J1. Session persistence in aide-state.json

**Done.** Extended `AppState` with `openSessions` map (keyed by project path). Each entry stores:
- `tabs` — array of `{ sessionId, title }` for each open tab
- `activeSessionId` — which tab was active

New helpers: `saveOpenSessions(projectPath, data)` and `loadOpenSessions(projectPath)`.

### J2. PtyManager: `createInitialTabs` (replaces `createInitialTab`)

**Done.** New method accepts optional `SavedSessionEntry[]` from persisted state:
- If saved sessions exist: spawns a resume PTY for each, returns all tab infos with saved titles
- If no saved sessions: falls back to previous behavior (resume latest or start fresh)
- `SessionTabInfo` now includes optional `title` field for restore

### J3. Silent dead session handling during restore

**Done.** Health checks during restore use `silent: true` flag:
- `startHealthCheck(tabId, silent)` — marks health check as silent
- `feedHealthCheck` — skips `terminal:dead-session` IPC for silent checks (no dialog shown)
- `handleRestoreDeadSessions(tabIds)` — waits for all health checks, silently closes dead tabs via `terminal:tab-closed` IPC, spawns new session via `terminal:new-tab` if all tabs were dead

### J4. Renderer: multi-tab init + debounced persistence

**Done.**
- `useSessionStore`: new `initWithTabs(tabs[], activeTabId)` action, uses saved `title` as initial slug
- `TerminalPanel` init effect: calls `terminalCreateInitial()` which now returns `{ tabs[], activeSessionId }`, uses `initWithTabs` for multiple tabs
- New `onTerminalTabClosed` listener for silent tab removal during restore
- Debounced persistence effect (500ms): saves current open tabs + active session to `aide-state.json` on every tab/activeTab change

### J5. IPC changes

**Done.**
- `terminal:create-initial` — now returns `{ tabs: SessionTabInfo[], activeSessionId: string | null }` (was single `SessionTabInfo`)
- `state:save-open-sessions` — new fire-and-forget IPC, saves open sessions per project
- `terminal:tab-closed` — new push event from main→renderer for silent tab removal during restore

**Files changed:**
- `src/main/config/appState.ts` — `SavedSessionEntry`, `ProjectOpenSessions`, `openSessions` in AppState, save/load helpers
- `src/main/pty/ptyManager.ts` — `createInitialTabs`, `handleRestoreDeadSessions`, `silent` flag on HealthCheck, `title` on SessionTabInfo
- `src/main/ipc/index.ts` — updated `terminal:create-initial`, added `state:save-open-sessions`
- `src/preload/editor.ts` — `InitialTabsResult` type, `saveOpenSessions`, `onTerminalTabClosed`, updated EditorAPI
- `src/renderer/src/env.d.ts` — `InitialTabsResult`, `title` on SessionTabInfo, `saveOpenSessions`, `onTerminalTabClosed`
- `src/renderer/src/store/useSessionStore.ts` — `initWithTabs` action, `title` on SessionTabInfo
- `src/renderer/src/components/layout/TerminalPanel.tsx` — multi-tab init, debounced persistence, silent tab close listener

---

## Batch K — Session Picker Preview ✅

### K1. `readSessionPreview` in sessionScanner

**Done.** New function reads the last ~5 KB of a session JSONL file using low-level `openSync`/`readSync` (avoids loading the entire file). Parses user + assistant messages, skipping tool/command/meta entries. If the earliest message in the 5 KB window is cut off, expands backwards in 4 KB steps (up to 5 iterations) until the full message boundary is found.

Returns `PreviewMessage[]` with `{ role: 'user' | 'assistant', text: string }`.

### K2. IPC + preload

**Done.**
- New `session-picker:get-preview` IPC handler — takes `sessionId`, resolves project path from editor window, calls `readSessionPreview`
- `preload/sessionPicker.ts` — added `getPreview(sessionId)` method
- `env.d.ts` — added `PreviewMessage` interface and `getPreview` to `SessionPickerAPI`

### K3. Session Picker UI — expand/collapse preview

**Done.** Each session row now has a `▸`/`▾` toggle button (left side). Clicking it:
- Lazily loads preview via `getPreview(sessionId)` (cached after first load)
- Shows a scrollable panel (max 200px) with color-coded messages:
  - **You** (blue `#569cd6`) for user messages
  - **Claude** (teal `#4ec9b0`) for assistant messages
- Long messages truncated at 500 chars with `…`
- Shows "Loading…" during fetch, "No messages" if empty

### K4. Filter out empty/dead sessions

**Done.** `scanSessions` now skips sessions with no real user messages (`readLastUserMessage` returns empty string). These dead sessions never appear in the picker. The `'Claude Code'` fallback title removed — `title` always contains the actual last user message text.

**Files changed:**
- `src/main/pty/sessionScanner.ts` — `PreviewMessage` interface, `readSessionPreview` function, dead session filtering in `scanSessions`
- `src/main/ipc/index.ts` — `session-picker:get-preview` handler, imports
- `src/preload/sessionPicker.ts` — `PreviewMessage` interface, `getPreview` method
- `src/renderer/src/env.d.ts` — `PreviewMessage` interface, `getPreview` in `SessionPickerAPI`
- `src/renderer/src/windows/SessionPickerApp.tsx` — expand/collapse toggle, lazy preview loading, preview panel UI
