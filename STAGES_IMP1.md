# AIDE — Improvements Progress

---

## Batch A — Quick Wins ✅

### A1. Fix: Open Recent / Open Folder for current project
**Done.** In `src/main/menu/index.ts` both `handleOpenRecent` and `handleOpenFolder` now check `openProjectsRef.has(path)` before switching. If the project is already open, the existing window is focused and no switch occurs.

### A2. Fix: Terminal loses focus after paste from context menu
**Done.** In `src/renderer/src/components/layout/TerminalPanel.tsx`, `handlePaste` now calls `setTimeout(() => terminalRef.current?.focus(), 0)` after `setCtxMenu(null)`, restoring focus after the context menu closes.

### A3. App icon
**Done.**
- `electron-builder.yml` created in project root with `win.icon: app_icon.ico`.
- `icon: join(__dirname, '../../app_icon.ico')` added to all three `BrowserWindow` constructors: `src/main/windows/editor.ts`, `src/main/windows/picker.ts`, `src/main/windows/sessionPicker.ts`.

**Files changed:**
- `src/main/menu/index.ts`
- `src/renderer/src/components/layout/TerminalPanel.tsx`
- `src/main/windows/editor.ts`
- `src/main/windows/picker.ts`
- `src/main/windows/sessionPicker.ts`
- `electron-builder.yml` (new)

---

## Batch B — File Tree Context Menu ✅

### B1. Four new context menu items (+ Duplicate)

**Done.** Right-click on any file in the file tree now shows:

1. **Open in Explorer** — `shell.showItemInFolder(path)` via IPC
2. **Add to Claude context** — writes `@relative/path ` to the active PTY tab using `terminalWrite`
3. *(separator)*
4. **View Diff** *(existing)*
5. *(separator)*
6. **Rename** — inline modal dialog, input prefilled with current filename. Enter/Escape support. Calls `fs.rename` via IPC.
7. **Duplicate** — inline modal dialog, input prefilled with `<name>_Copy.<ext>`. Enter/Escape support. Calls `fs.copyFile` via IPC.
8. **Delete** — inline confirm dialog showing filename. Enter/Escape support. Calls `fs.unlink` via IPC.

FS watcher automatically handles tree updates and editor close after rename/delete.
Context menu and dialogs now render in both normal and modified-only tree modes.

**New IPC handlers:**
- `shell:show-item-in-folder`
- `fs:delete-file`
- `fs:rename-file`
- `fs:copy-file`

**Files changed:**
- `src/main/ipc/index.ts` (4 new handlers, added `shell` import)
- `src/preload/editor.ts` (4 new methods)
- `src/renderer/src/env.d.ts` (4 new method types)
- `src/renderer/src/components/filetree/FileTree.tsx` (expanded ContextMenu, added dialogs, restructured render)

---

## Batch D — Terminal Tab Naming & Attention ✅

### D1. Attention blink via OSC 9

**Done.** `terminal.parser.registerOscHandler(9, ...)` in `TerminalTab` intercepts Claude Code's "waiting for input" notification (OSC 9).
- If the tab is not currently active → `setAttention(tabId, true)` in store
- Clicking the tab clears attention (`setActiveTab` now also sets `attention: false`)
- Tab color animates amber (`#f0a500`) ↔ dark (`#555`) at 500ms — identical to the log panel behavior
- `attention: boolean` field added to `SessionTab`; `setAttention` action added to store

### D2. Tab title from OSC sequences (main process)

**Done.** Tab labels update live from the terminal title sequences Claude Code emits.

**Why main process, not xterm.js:** xterm.js `onTitleChange` does not fire for titles set by Claude Code on Windows (ConPTY path). Parsing is done on the raw PTY data stream instead, before it reaches xterm.js.

**`extractTitle(tabId, data)` in `ptyManager.ts`:**
- Prepends any buffered partial sequence from the previous chunk (`titleBufs: Map<string, string>`)
- Regex matches OSC 0 or OSC 2 with BEL (`\x07`) or ST (`\x1b\`) terminator
- On match: sends `terminal:tab-title { tabId, title }` IPC to renderer
- No disk writes — title is purely a live UI label
- `dbgLog(tabId, data)` helper sends all ESC-containing PTY data to the **"PTY ESC"** log panel channel for diagnostics

**Renderer side:**
- `onTerminalTabTitle(cb)` in preload subscribes to `terminal:tab-title`
- `TerminalPanel.tsx` listener: `updateSlug(tabId, title)` on every event
- `initWithTab` / `addTab` in store hardcode `slug: 'Claude Code'` as the initial label

### D3. Session picker: last user message from JSONL

**Done.** The session picker shows the last real message the user sent in each session — much more informative than a generic label.

**`readLastUserMessage(sessionsDir, sessionId)` in `sessionScanner.ts`:**
- Reads the session JSONL file and scans from the end
- Skips entries where `isMeta: true` or content starts with `<command`, `<local-command`, `<tool`
- Returns up to 80 chars of the last matching user message
- `DiskSession.title` = this text; fallback `'Claude Code'` if nothing found

No file caching — title is read fresh from JSONL on each `scanSessions` call.

### Dead code removed

- `readSlugFromJsonl`, `watchJsonlFile` — removed from `sessionScanner.ts`
- `watchSessionsDir` callback simplified: `(sessionId, slug)` → `(sessionId)`
- `.aide/Titles/` directory and all related helpers (`saveTitle`, `loadTitle`, `ensureTitlesDir`) — never written to disk
- `SessionTabInfo.title?` — removed; title is not part of the tab spawn contract
- `terminal:save-title` IPC handler — removed from `ipc/index.ts`
- `terminalSaveTitle` — removed from preload and `env.d.ts`
- `terminal.onTitleChange(...)` — removed from `TerminalPanel.tsx`; main process handles title detection

**Files changed:**
- `src/main/pty/ptyManager.ts` — `extractTitle`; `titleBufs`; `dbgLog`; removed caching helpers; removed `fs`/`path` imports
- `src/main/pty/sessionScanner.ts` — `readLastUserMessage`; removed JSONL slug reading
- `src/main/ipc/index.ts` — `terminal:save-title` handler removed
- `src/preload/editor.ts` — `terminalSaveTitle` removed; `onTerminalTabTitle` added
- `src/renderer/src/env.d.ts` — updated `DiskSession`, `SessionTabInfo`; `onTerminalTabTitle` added
- `src/renderer/src/store/useSessionStore.ts` — `attention` field; `setAttention`; initial slug hardcoded
- `src/renderer/src/components/layout/TerminalPanel.tsx` — `onTerminalTabTitle` subscription; OSC 9 handler; `TabButton` with amber blink; removed `onTitleChange`
- `src/renderer/src/windows/SessionPickerApp.tsx` — displays `DiskSession.title`
