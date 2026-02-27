# AIDE — Improvements Plan 2 Progress

---

## Batch H — Terminal UX: Right-click, Focus, Close Tab ✅

### H1. Terminal: Right-click copy/paste, fix selection

**Done.** Removed `TerminalContextMenu` component entirely. Right-click on terminal now directly:
- If text is selected → copies to clipboard + clears selection
- If no selection → pastes from clipboard

This eliminates the custom context menu that was intercepting mouse events and interfering with xterm.js text selection.

### H2. Terminal: Focus after "Add to Claude context" + tab click

**Done.** Two focus fixes:
- **"Add to Claude context"** in FileTree context menu now calls `usePanelStore.getState().focusTerminal()` after writing to PTY, so focus moves to the terminal panel (triggering the 75/25 resize).
- **Tab click** now focuses the xterm instance via `fitFunctions.current.get(tabId)?.focus()` with a 50ms delay (allows the tab switch + fit to complete first). Clicking the already-active tab also re-focuses xterm.

### H3. Terminal tab: Close button

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
