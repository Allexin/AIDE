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

### D1. xterm.js `onTitleChange` for tab labels + OSC 9 attention blink

**Done.** Two improvements to terminal tabs:

**Tab label from VT title (D1 original):**
- `terminal.onTitleChange(title => updateSlug(tabId, title))` registered on every xterm instance
- When Claude Code sets the terminal title via `ESC]0;title\007`, the tab label updates automatically
- JSONL slug remains as the initial label until the first title event arrives

**Attention blink (added to D1):**
- `terminal.parser.registerOscHandler(9, ...)` intercepts Claude Code's "waiting for input" notification
- If the tab is not currently active → `setAttention(tabId, true)` in store
- Clicking the tab clears attention (`setActiveTab` now also clears `attention: false`)
- Tab color animates amber (`#f0a500`) ↔ dark (`#555`) at 500ms — identical to the log panel behavior

**JSONL slug removed from tab lifecycle:**
- `slug` removed from `SessionTabInfo` (main → renderer contract) — JSONL slug was internal noise
- `ptyManager.ts` no longer watches JSONL files for slug or sends `terminal:tab-slug-updated`; tabs always start as "Claude Code"
- `onTerminalTabSlugUpdated` removed from preload, `env.d.ts`, and `TerminalPanel.tsx`
- `scanSessions` (session picker) still reads slugs for the picker UI — unaffected

**Files changed:**
- `src/renderer/src/store/useSessionStore.ts` — `attention: boolean` + `setAttention`; `setActiveTab` clears attention; `initWithTab`/`addTab` hardcode "Claude Code" as initial slug
- `src/renderer/src/components/layout/TerminalPanel.tsx` — `TerminalTab` registers `onTitleChange` + OSC 9; extracted `TabButton` with amber blink; removed `onTerminalTabSlugUpdated` listener
- `src/main/pty/ptyManager.ts` — removed `watchJsonlFile`/`readSlugFromJsonl` imports; removed `slug` from `SessionTabInfo` and `PtyTab`; removed JSONL slug watching from tab lifecycle
- `src/preload/editor.ts` — removed `onTerminalTabSlugUpdated`
- `src/renderer/src/env.d.ts` — removed `onTerminalTabSlugUpdated`
