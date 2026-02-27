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
