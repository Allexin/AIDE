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

---

## Batch C — Drag & Drop into Terminal ✅

### C1. External drag from Windows Explorer

**Done.** Dropping a file from Windows Explorer into the terminal area writes the file path to the active PTY stdin.

- `onDragOver` + `onDrop` handlers added to the xterm container div in `TerminalPanel.tsx`
- In `onDrop`: reads `event.dataTransfer.files[0].path` (Electron extension on `File`)
- Path rule: if the file is inside `projectRoot` → writes `@relative/path ` (with trailing space); otherwise → absolute path with trailing space
- After writing: calls `terminal.focus()` via the extended `FitFn.focus()` method

### C2. Internal drag from file tree

**Done.** Dragging a file node from the file tree and dropping it into the terminal area works identically.

- File nodes in `FileTree.tsx` (`NodeItem`) are now `draggable={true}` (files only, not directories)
- `onDragStart` sets `dataTransfer.setData('aide/absolute-path', node.path)`
- `onDrop` in `TerminalPanel.tsx` checks `dataTransfer.getData('aide/absolute-path')` first — if present, uses it instead of `dataTransfer.files`. Files from the tree are always inside `projectRoot`, so always written as `@relative/path `

**Files changed:**
- `src/renderer/src/components/layout/TerminalPanel.tsx` — `useFileTreeStore` import; `FitFn.focus`; `handleDragOver`; `handleDrop`; `onDragOver`/`onDrop` on xterm container; `focus()` exposed in `onMount`
- `src/renderer/src/components/filetree/FileTree.tsx` — `draggable` + `onDragStart` on file nodes in `NodeItem`

---

## Batch E — CLI Tool Abstraction ✅

### E1. Decouple PtyManager from Claude Code

**Done.** PTY core is now tool-agnostic. All Claude-specific logic lives in a dedicated module. Adding a new tool (Aider, OpenCoder, etc.) = implement one interface + pass it to `PtyManager`.

**New files:**

`src/main/pty/cliTools/types.ts` — `CliSession` and `CliTool` interfaces:
- `scanSessions(projectPath)` — find sessions on disk, sorted newest first
- `resumeCommand(sessionId)` — command string to resume a session
- `newSessionCommand()` — command string to start a new session
- `watchForNewSessions(projectPath, onNew)` — watch for new sessions, returns unsubscribe fn
- `watchSessionLabel?(...)` — optional live label watch
- `prepareProject?(projectPath)` — optional one-time setup before first session

`src/main/pty/cliTools/claudeCode.ts` — `claudeCodeTool` implementation:
- `prepareProject(projectPath)` — writes `hasTrustDialogAccepted: true` into `~/.claude.json` under `projects[normalizedPath]` before first launch; no-op if already trusted. Path key uses forward slashes (matching Claude's own format).
- `scanSessions` ← wraps `scanSessions` from `sessionScanner.ts` with field mapping
- `resumeCommand(id)` → `'claude --resume <id>'`
- `newSessionCommand()` → `'claude'`
- `watchForNewSessions` ← wraps `watchSessionsDir` from `sessionScanner.ts`

**Refactored `src/main/pty/ptyManager.ts`:**
- Constructor: `(win, projectPath, tool: CliTool = claudeCodeTool)`
- Removed: `this.sessionsDir`, direct imports of `scanSessions`/`getSessionsDir`/`watchSessionsDir`
- `createInitialTab`, `createNewSessionTab`, `resumeSessionTab` — call `await tool.prepareProject?.()` before spawning
- `'claude\r'` → `tool.newSessionCommand() + '\r'`
- `'claude --resume <id>\r'` → `tool.resumeCommand(id) + '\r'`
- `scanSessions(...)` → `tool.scanSessions(...)`
- `watchSessionsDir(...)` → `tool.watchForNewSessions(...)`

`src/main/pty/sessionScanner.ts` — unchanged; used internally by `claudeCode.ts`.

**New files:**
- `src/main/pty/cliTools/types.ts`
- `src/main/pty/cliTools/claudeCode.ts`

**Files changed:**
- `src/main/pty/ptyManager.ts`

---

## Batch F — Sync IO + Dirty Flag for Editor ✅

### Problem

EditorPanel had a critical bug: closing a file could zero its contents. Root cause: async `readFile`/`writeFile` IPC created race conditions. Save-on-close compared `editor.getValue()` against `diskContentRef` — if Monaco hadn't loaded content yet (empty from `defaultValue=""`), `"" !== fileContent` → wrote `""` to disk. Additionally, `EditorPanel` is conditionally rendered (unmounts/remounts on every close/open cycle), resetting all refs.

### F1. Sync IPC for editor read/write

**Done.** Replaced async `ipcMain.handle` + `ipcRenderer.invoke` with sync `ipcMain.on` + `event.returnValue` / `ipcRenderer.sendSync`.

- `editor:read-file` → `editor:read-file-sync` — `readFileSync` + `statSync`, returns `{ content, mtime, size }` or `{ error }`
- `editor:write-file` → `editor:write-file-sync` — `writeFileSync` + `statSync`, returns `{ mtime }` or `{ error }`
- Return types in `EditorAPI` and `env.d.ts` changed from `Promise<T>` to `T | { error: string }`

### F2. Dirty flag

**Done.** `dirtyRef = useRef(false)` tracks whether the editor has unsaved changes.

- Set `true` by `editor.onDidChangeModelContent()` in `handleEditorMount`
- Set `false` in `applyFileToEditor` (freshly loaded = clean) and after every successful save
- All save points now check `dirtyRef.current` instead of `getValue() !== diskContent`:
  - `handleClose` — save only if dirty
  - `handleBlurRef` — save only if dirty
  - Auto-save on file switch (openFile useEffect) — save only if dirty

### F3. Removed async patterns from EditorPanel

- `loadFile`, `saveFile`, `handleConflictKeepMine`, `handleConflictBackup` — all sync now
- `onFsChanged` handler — sync `readFile`, uses `dirtyRef.current` for conflict detection
- Removed `.catch(() => {})` patterns, replaced with `'error' in result` checks
- Removed stale-file bail check (`if (filePath !== openFile) return`) — no async gap

**Files changed:**
- `src/main/ipc/index.ts` — sync IPC handlers, added `readFileSync`/`writeFileSync`/`statSync` imports
- `src/preload/editor.ts` — sync bridge methods + updated `EditorAPI` types
- `src/renderer/src/env.d.ts` — sync return types for `readFile`/`writeFile`
- `src/renderer/src/components/layout/EditorPanel.tsx` — dirty flag + all sync conversions

---

## Batch G — Toolbar Improvements ✅

*Note: Originally planned as "Batch F" in IMPROVEMENTS_PLAN1.md, renamed to G to avoid collision with the Sync IO batch above.*

### G1. Hot reload toolbar config

**Done.** Editing `aide/toolbar.json` or `.aide/toolbar.json` updates the toolbar live without restarting AIDE.

- `startToolbarWatcher(projectPath, onChange)` in new `src/main/toolbar/toolbarWatcher.ts` — `fs.watch` on both config files with 300ms debounce; returns cleanup function
- Editor window setup calls `startToolbarWatcher`, sends `toolbar:config-updated` IPC on change
- Cleanup on window close
- Renderer subscribes via `onToolbarConfigUpdated` → `setButtons(newButtons)`

### G2. Auto-deploy toolbar docs

**Done.** On project open, bundled documentation is copied to `.aide/docs/toolbar.md` (created if missing, updated if outdated).

- `resources/docs/toolbar.md` — full documentation covering: config files, file format, button fields, variables, relative paths in commands, external scripts (`aide/scripts/` and `.aide/scripts/`), icon formats, channels, project type, hot reload
- `deployToolbarDocs(projectPath)` in `toolbarConfig.ts` — reads bundled doc, compares with `.aide/docs/toolbar.md`, writes if different or missing
- Called from `openProjectAndTrack` in `editor.ts`

### G3. AI helper with CLI tool split button

**Done.** PresetDialog now has an "AI Helper" section: textarea + split button that sends a prompt to a new CLI tool session.

**CLI tool registry:**
- `src/main/pty/cliTools/registry.ts` — `getRegisteredTools()` returns `[{ id, name }]` from registry array; `getToolById(id)` for lookup. Currently contains `claudeCodeTool`.

**IPC:**
- `cli-tools:list` → returns registered tools
- `terminal:create-with-prompt` → creates new session tab, sends `terminal:new-tab` to renderer, writes prompt to PTY after 2s delay

**PtyManager:**
- `createNewSessionWithPrompt(prompt)` — calls `prepareProject`, spawns new session tab, writes prompt after tool has time to start (2s after the 0.5s newSessionCommand delay)

**PresetDialog UI:**
- Textarea for describing the toolbar change
- Split button: main part = "Ask {tool.name}", dropdown arrow lists all registered tools (only shown if >1 tool)
- On click: sends prompt prefixed with `"Please read .aide/docs/toolbar.md to understand the toolbar configuration format, then help with: ..."` → closes dialog

**New files:**
- `src/main/toolbar/toolbarWatcher.ts`
- `src/main/pty/cliTools/registry.ts`
- `resources/docs/toolbar.md`

**Files changed:**
- `src/main/config/toolbarConfig.ts` — `deployToolbarDocs`, `mkdirSync` import
- `src/main/ipc/index.ts` — `cli-tools:list`, `terminal:create-with-prompt` handlers
- `src/main/pty/ptyManager.ts` — `createNewSessionWithPrompt`
- `src/main/windows/editor.ts` — toolbar watcher + docs deploy on project open
- `src/preload/editor.ts` — `onToolbarConfigUpdated`, `getCliTools`, `terminalCreateWithPrompt`
- `src/renderer/src/env.d.ts` — matching types
- `src/renderer/src/components/layout/MainToolbar.tsx` — config update subscription, AI helper UI in PresetDialog
