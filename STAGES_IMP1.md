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
