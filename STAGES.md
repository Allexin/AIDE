# AIDE — Stage Completion Log

---

## Stage 1 — Scaffold + Config + Lock

**Status:** Complete ✓

### What was built
- `electron-vite` project scaffold with React 18, TypeScript, Zustand 5
- `package.json`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `electron.vite.config.ts`
- App-level config (`src/main/config/appConfig.ts`): persisted to `userData/aide-config.json`; stores recent projects, editor preferences, and feature limits
- Project-level config (`src/main/config/projectConfig.ts`): reads `.aide/settings.json` and `aide/config.json`
- Lock file (`src/main/lock.ts`): writes PID to `.aide/lock` on open, checks for live process on conflict, releases on close
- `.gitignore` management (`src/main/gitignore.ts`): appends `.aide` entry if missing, creates file if absent
- IPC handlers (`src/main/ipc/index.ts`): `pick:select-folder`, `project:open`, `editor:get-project-path`, `config:get`
- Two windows: Picker (500×400, resizable) and Editor (1200×800, resizable)
- Picker UI: "Open Folder…" button with error display
- Editor UI: stage-1 placeholder showing project path
- Single renderer entry (`src/renderer/index.html`) with `?window=picker|editor` routing
- `.gitignore` for project repo, `.npmrc` with Electron mirror

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (main 6.7 kB, preloads 0.5 kB, renderer 218 kB)
- Build output structure verified: `out/main/index.js`, `out/preload/picker.js`, `out/preload/editor.js`, `out/renderer/index.html`

### User test checklist
1. `npm run dev` — Picker window appears (500×400)
2. Click "Open Folder…", select any project directory
3. Confirm `.aide/` folder created in that project directory
4. Confirm `.gitignore` in that directory now contains `.aide`
5. Editor window opens showing the project path; Picker closes
6. Launch a second `npm run dev` pointing to the same folder — error message, no second window
7. Close the Editor — confirm `.aide/lock` is deleted

---

## Stage 2 — Project Picker

**Status:** Complete ✓

### What was built
- App-level config split into two files: `aide-config.json` (static settings) and `aide-state.json` (dynamic state — recent projects). Prevents write-crash corruption of hand-edited config.
- `src/main/config/appState.ts`: new module — `RecentProject { path, lastOpened }`, `initAppState()`, `addRecentProject()`, `removeRecentProject()`
- `src/main/config/appConfig.ts`: removed `recentProjects`/`maxRecentProjects`; added structured `ui` and `sessions` sub-objects matching SPEC
- `src/main/windows/editor.ts`: extracted `openProjectAndTrack()` helper — single shared function for lock acquisition, gitignore, recent-add, and window creation; used by both IPC and startup paths
- `src/main/ipc/index.ts`: refactored to use `openProjectAndTrack`; added `path:validate` (existence check, no side effects) and `state:remove-recent` handlers
- `src/main/index.ts`: launch detection logic — CLI argument → `.aide/` in cwd → Picker (priority order per SPEC)
- `src/preload/picker.ts`: added `getState()`, `validatePath()`, `removeRecentProject()` bridge methods
- `src/renderer/src/env.d.ts`: added `RecentProject` type, extended `PickerAPI`
- `src/renderer/src/windows/PickerApp.tsx`: full redesign — scrollable recent projects list with folder name, full path, and formatted timestamp; stale-path inline error with "Remove from list" button; "Open Folder…" in fixed bottom bar

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (main 8.75 kB, preloads 0.74 kB, renderer 224 kB)

### User test checklist
1. `npm run dev` — Picker shows "No recent projects"
2. "Open Folder…" → select directory → Editor opens, Picker closes, title bar shows folder name
3. Close Editor, reopen — recent project appears with date
4. Click recent project — Editor opens directly
5. Delete the project folder, click it in recents — inline error + "Remove from list" button
6. `npm run build && npx electron out/main/index.js <path>` — Editor opens without Picker

---

## Stage 3 — Layout + Panel System

**Status:** Complete ✓

### What was built
- `src/renderer/src/store/usePanelStore.ts`: Zustand store — `activePanelRatio`, `collapsedWidthPx`, `fileTreeWidthPx`, `logPanelExpandedHeightPx`, `editorVisible`, `terminalCollapsed`, `logPanelExpanded`, `focusedPanel`; actions: `initFromConfig`, `setEditorVisible`, `toggleTerminalCollapse`, `focusEditor`, `focusTerminal`, `toggleLogPanel`
- `src/renderer/src/components/layout/MainToolbar.tsx`: full-width 36px toolbar strip (empty, Stage 9 populates)
- `src/renderer/src/components/layout/FileTreeColumn.tsx`: fixed-width left column with FileTreeToolbar (▣ ↺ ◎ buttons + temp [E] toggle for testing); file tree content placeholder
- `src/renderer/src/components/layout/EditorPanel.tsx`: panel with header (file path, [Diff], [×]) + Monaco placeholder; `onMouseDown` triggers `focusEditor()`; [×] calls `setEditorVisible(false)`
- `src/renderer/src/components/layout/TerminalPanel.tsx`: full panel (header with tabs placeholder, [+], [⌄] collapse) or 20px collapsed strip with vertical "Claude Code" label; `onMouseDown` triggers `focusTerminal()`; strip click restores
- `src/renderer/src/components/layout/LogPanel.tsx`: collapsed 28px strip with [∧]/[∨] toggle; expands to `logPanelExpandedHeightPx`; channel tabs in Stage 7
- `src/renderer/src/components/layout/StatusBar.tsx`: 22px blue bar; sensors in Stage 8
- `src/renderer/src/windows/EditorApp.tsx`: full layout — loads `getProjectSettings()` + `getConfig()` on mount via IPC, calls `initFromConfig()`, computes editor/terminal flex widths from `focusedPanel` + `activePanelRatio`; terminal always on right (empty spacer for collapsed strip when editor hidden)
- `src/preload/editor.ts`: added `getProjectSettings()` and `getConfig()` IPC bridges
- `src/main/ipc/index.ts`: added `editor:get-project-settings` handler (reads `readProjectSettings` for sender window's project)
- `src/renderer/src/env.d.ts`: updated `EditorAPI` with `getProjectSettings` and `getConfig`

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (main 9.75 kB, preloads 0.89 kB, renderer 240 kB)

### User test checklist
1. `npm run dev` — Editor window opens; terminal placeholder takes full width, no editor visible
2. Click **[E]** temp button (top-right of file tree toolbar) → editor appears at ~75%, terminal at ~25%
3. Click in editor area → editor stays at 75%, terminal at 25%
4. Click in terminal area → terminal expands to ~75%, editor shrinks to ~25%
5. Click **[⌄]** collapse button in terminal header → terminal shrinks to 20px strip with "Claude Code" label
6. Click the strip → terminal restores to previous size
7. Click **[E]** again to close editor → terminal expands to full width; if terminal was collapsed before close, it remains collapsed
8. Click **[∧]** button in log strip → log panel expands; click **[∨]** → collapses back
9. Resize window → panels scale proportionally

---

## Stage 4 — File Tree

**Status:** Complete ✓

### What was built
- `src/main/filetree/gitStatus.ts`: async `runGitStatus(projectPath)` — runs `git status --porcelain`, parses changed/deleted paths (always forward slashes), returns `GitStatusResult { available, changed[], deleted[] }`
- `src/main/filetree/watcher.ts`: `startProjectWatcher(projectPath, win)` / `stopProjectWatcher(projectPath)` — `fs.watch` with `recursive: true`; dot-prefixed paths filtered; git refresh debounced 300ms via `GitRefreshQueue` class (serial execution, one pending slot — queue absorbs rapid changes without stacking git calls)
- `src/main/ipc/index.ts`: added `filetree:read-dir(dirPath)` (returns sorted `TreeNode[]`, dirs before files, dot-prefixed excluded, `relativePath` in forward slashes) and `filetree:git-status` (returns `GitStatusResult` for the sender window's project)
- `src/main/windows/editor.ts`: `startProjectWatcher` called on `did-finish-load`; `stopProjectWatcher` called on `closed`
- `src/preload/editor.ts`: added `readDir`, `getGitStatus`, `onGitStatusUpdated`, `onFsChanged` bridges
- `src/renderer/src/env.d.ts`: added `TreeNode` and `GitStatusResult` interfaces; extended `EditorAPI`
- `src/renderer/src/store/useEditorStore.ts`: new Zustand store — `openFile`, `openRelativePath`, `openFileInEditor(abs, rel)`, `closeEditor()`; calls `usePanelStore.setEditorVisible` on open/close
- `src/renderer/src/store/useFileTreeStore.ts`: new Zustand store — `dirContents: Map<string, TreeNode[]>` (lazy per-directory cache), `expandedDirs: Set<string>`, `gitStatus`, `modifiedOnly`, `contextMenu`; actions: `init`, `expandDir` (lazy load + expand), `collapseDir`, `selectFile`, `toggleModifiedOnly`, `refresh` (re-reads all loaded dirs + git status), `updateGitStatus`, `handleFsChange` (re-reads parent dir on fs event; closes editor if open file deleted)
- `src/renderer/src/components/filetree/FileTree.tsx`: `FileTree` component — normal mode renders from `dirContents` with lazy expand/collapse; "Modified only" mode builds virtual tree from `gitStatus.changed` paths; `●` indicator on changed files; right-click context menu with "View Diff" (Stage 6 no-op); `ContextMenu` component with fixed overlay
- `src/renderer/src/components/layout/FileTreeColumn.tsx`: wired toolbar buttons (▣ = modifiedOnly toggle, ↺ = refresh, ◎ = commit placeholder); removed Stage 3 temp [E] button; renders `<FileTree />`
- `src/renderer/src/components/layout/EditorPanel.tsx`: header now shows `openRelativePath`; × calls `closeEditor()`
- `src/renderer/src/windows/EditorApp.tsx`: `init()` now also calls `getProjectPath()` and `useFileTreeStore.getState().init(projectPath)`

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (main 14.78 kB, preloads 1.00 kB, renderer 252 kB)

### User test checklist
1. Open a real project — file tree shows structure, no dot files/folders visible
2. Expand/collapse directories by clicking
3. Click a file — editor panel appears showing file path; previously open file is replaced
4. Make an external change to a file — `●` indicator appears automatically (no manual refresh needed)
5. Create a new file externally — appears in tree within ~300ms
6. Delete a file externally — disappears from tree; if it was open in editor, editor closes
7. Click **▣** to toggle "Modified only" — only changed files visible with directory hierarchy; click again to restore
8. Click **↺** Refresh — tree and git status manually updated
9. Right-click a file → "View Diff" menu item appears (no-op for now)
10. Confirm deleted files do not appear in the tree (only in commit dialog later)

---

## Stage 6 — Code Editor + Diff View

**Status:** Complete ✓

### What was built
- `src/renderer/src/monacoSetup.ts`: configures Monaco's web workers locally (editorWorker, tsWorker, jsonWorker, cssWorker, htmlWorker via Vite `?worker` syntax) and tells `@monaco-editor/react` to use the bundled Monaco instead of CDN
- `src/main/ipc/index.ts`: added `editor:read-file` (content + mtime + size), `editor:write-file` (returns new mtime), `editor:git-show-head` (runs `git show HEAD:<relPath>`, returns `{ content }` or `{ error: 'untracked' | 'other' }`)
- `src/preload/editor.ts`: added `readFile`, `writeFile`, `gitShowHead` bridges; updated `getConfig` return type to include `editor: EditorConfig`
- `src/renderer/src/env.d.ts`: added `EditorConfig` interface; updated `EditorAPI.getConfig` + added `readFile`, `writeFile`, `gitShowHead`
- `src/renderer/src/store/useEditorStore.ts`: added `editorConfig` (Monaco options from app config), `openDiffOnLoad` flag (diff mode after file load), `triggerDiffNow` flag (diff on already-open file), `setEditorConfig`, `setOpenDiffOnLoad`, `setTriggerDiffNow`, `viewDiff` action (handles both "file already open" and "open then diff" cases)
- `src/renderer/src/store/useFileTreeStore.ts`: updated `contextMenu` to include `relativePath`
- `src/renderer/src/windows/EditorApp.tsx`: calls `useEditorStore.setEditorConfig(appConfig.editor)` on init
- `src/renderer/src/components/layout/EditorPanel.tsx`: full implementation — Monaco Editor + DiffEditor (both always mounted, CSS toggled); language auto-detection from file extension; auto-save on blur (only if content changed); external modification → silent reload (no local changes) or conflict dialog (local changes); `applyFileToEditor` handles race between load and mount via `pendingContentRef`; large file dialog (> maxFileSizeMb); conflict dialog (Reload / Keep mine / Backup & Open); diff view via `git show HEAD` with no-diff dialogs for "identical" and "untracked"; `viewDiff` triggers handled via `triggerDiffNow` and `openDiffOnLoad` flags
- `src/renderer/src/components/filetree/FileTree.tsx`: wired "View Diff" context menu item to `useEditorStore.viewDiff()`; passes `relativePath` in context menu state

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (renderer 8,047 kB including full Monaco bundle)

### User test checklist
1. Click a file in tree → opens in Monaco with syntax highlighting, correct language
2. Edit content, click terminal → file saved (verify in OS explorer or another editor)
3. Modify the file externally while AIDE is open → conflict dialog appears
4. Choose **Reload** → editor shows new content; **Keep mine** → disk overwritten; **Backup & Open** → backup file created, opens in editor
5. Click **[Diff]** → diff view opens (HEAD vs disk); read-only; colors correct (green = added, red = removed)
6. Click **[Edit]** → back to editor with previous content intact
7. Click **[×]** → editor hidden, terminal expands
8. Right-click an unchanged file → "View Diff" → "File has not changed since last commit."
9. Right-click an untracked file → "View Diff" → "File is not tracked by git — there is no diff to show." → `[ Open Editor ]` opens the file in edit mode
10. Open a file > 5 MB → large file confirmation dialog; No → editor not opened; Yes → opens
11. Make changes then switch files in tree → previous file auto-saved before new one loads

---

## Stage 7 — Log Panel

**Status:** Complete ✓

### What was built
- `src/renderer/src/utils/stripAnsi.ts`: strips ANSI escape codes and carriage returns before display
- `src/renderer/src/store/useLogStore.ts`: Zustand store — `LogChannel { id, lines, attention, blinking }`, `channels[]`, `activeChannelId`; actions: `append` (auto-creates channel on first call, enforces 10 000-line cap with `[Older output truncated]` notice), `clear`, `close`, `setActive`, `stopBlink`; exported `logManager` singleton (`append`, `clear`) for non-component callers
- `react-window@1.8.11` + `@types/react-window` installed for virtualized rendering
- `src/renderer/src/store/useFileTreeStore.ts`: `refresh()` now appends to the `Git` log channel (`> git status` + summary line) — channel is auto-created on first explicit refresh
- `src/renderer/src/components/layout/LogPanel.tsx`: full implementation —
  - Tab strip (always visible even when collapsed) with per-tab `TabButton` that blinks amber at 500ms interval when `channel.blinking`, stops on click; clicking any tab while collapsed also expands the panel
  - `[∧/∨]` toggle button
  - Content area: `VirtualLogList` using `FixedSizeList` (react-window, 20px rows, `ResizeObserver` for container height, auto-scroll to bottom on new lines, `itemData` pattern for performance)
  - Empty state: blank area when no channels; "No output" when channel exists but is empty
  - Tab context menu (right-click): Clear (empties content, tab stays) / Close (removes tab; re-created on next append)
  - Attention system: blink only — panel does NOT auto-expand

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (renderer 8,078 kB)

### User test checklist
1. Open a project — log panel shows as thin collapsed strip, no tabs yet
2. Click **↺** Refresh in file tree — `Git` tab appears in the strip; panel stays collapsed
3. Click the `Git` tab — panel expands, shows `> git status` and summary line
4. Click **↺** Refresh again — new lines appended, auto-scrolls to bottom
5. Right-click `Git` tab → **Clear** — content cleared, tab stays
6. Right-click `Git` tab → **Close** — tab disappears
7. Click **↺** Refresh again — `Git` tab re-appears (auto-created)
8. Click **[∧]** button — panel expands; click **[∨]** — collapses back
9. Append 10 000+ lines (dev: many refreshes) — no UI lag; truncation notice appears

---

## Stage 8 — Status Bar

**Status:** Complete ✓

### What was built
- `src/main/filetree/gitStatus.ts`: extended `GitStatusResult` with `untracked: string[]` (files with `??` status, previously folded into `changed`) and `branch: string | null` (from `git rev-parse --abbrev-ref HEAD`, run in parallel with `git status --porcelain` via `Promise.allSettled`); `parsePorcelain` now routes `??` lines to `untracked` instead of `changed`
- `src/renderer/src/env.d.ts`: updated `GitStatusResult` to match — added `untracked` and `branch` fields
- `src/renderer/src/store/useEditorStore.ts`: added `cursorPosition: { line, column } | null` and `currentLanguage: string | null` state fields; added `setCursorPosition` and `setCurrentLanguage` actions; `closeEditor` now clears both fields
- `src/renderer/src/components/layout/EditorPanel.tsx`: `applyFileToEditor` calls `setCurrentLanguage(lang)` after computing the Monaco language ID; close path calls `setCursorPosition(null)` and `setCurrentLanguage(null)`; `handleEditorMount` subscribes to `editor.onDidChangeCursorPosition` → `setCursorPosition`; also sets initial cursor position on mount
- `src/renderer/src/components/filetree/FileTree.tsx`: `isChanged` check and "Modified only" mode now include both `changed` and `untracked` paths; "No changes" guard checks `changed.length === 0 && untracked.length === 0`; `buildModifiedTree` receives `[...changed, ...untracked]`
- `src/renderer/src/store/useFileTreeStore.ts`: log message in `refresh()` updated to count `changed + untracked` combined
- `src/renderer/src/components/layout/StatusBar.tsx`: full implementation with 5 sensors:
  - **Git branch** (left): shows `⎇ <branch>` when git available; hidden if git not initialized
  - **File git status** (left): shows `●` if `openRelativePath ∈ changed`, `?` if `∈ untracked`, empty if clean or no file open
  - **Cursor position** (right): `Ln N, Col N` from Monaco cursor events; hidden if no file open
  - **File language** (right): Monaco language ID mapped to display name (TypeScript, JSON, etc.); hidden if no file open
  - **File encoding** (right): always `UTF-8` when file is open; hidden otherwise

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (renderer 8,081 kB)

### User test checklist
1. Open a project with a git repo — status bar shows `⎇ main` (or current branch) on the left
2. Open a non-git directory — branch sensor hidden; status bar shows no left content
3. Click a tracked file with no changes — no `●` or `?` shown in status bar
4. Click a modified tracked file — `●` appears in status bar
5. Click a new untracked file — `?` appears in status bar
6. Move cursor in editor — `Ln N, Col N` updates in real time on the right
7. File language shows correct name (e.g. `TypeScript`, `Python`, `Markdown`)
8. File encoding shows `UTF-8` when a file is open
9. Close the editor (×) — cursor, language, encoding, and file status sensors all disappear
10. Switch files — all right sensors update to reflect the new file

---

## Stage 9 — Main Toolbar

**Status:** Complete ✓

### What was built
- `src/main/config/toolbarConfig.ts`: `ToolbarButton` / `ToolbarConfig` interfaces; `DEFAULT_TOOLBAR` constant (5 default buttons: Open in Explorer, Open in VS Code, Build, Dev Server, Test); `ensureDefaultToolbar(projectDir)` writes `.aide/toolbar.json` on first project open if absent; `readToolbarButtons(projectDir)` reads and merges `aide/toolbar.json` (shared) + `.aide/toolbar.json` (local) — local wins on duplicate `id`
- `src/main/toolbar/processManager.ts`: per-window `Map<BrowserWindow, Map<buttonId, RunningProcess>>`; `spawnButtonProcess()` spawns shell command, pipes stdout/stderr to renderer via `toolbar:output` IPC events, sends `toolbar:process-started` / `toolbar:process-exited`; `killButtonProcess()` runs `taskkill /f /t` on Windows, removes from map before kill so 'close' event skips double-notification; `killAllProcesses()` and `disposeProcessManager()` for window cleanup
- `src/main/ipc/index.ts`: added `toolbar:get-buttons`, `toolbar:run-button`, `toolbar:kill-button`, `toolbar:kill-restart-button` handlers; kill-restart waits 200ms between kill and spawn
- `src/main/windows/editor.ts`: calls `ensureDefaultToolbar(projectPath)` on project open; added `close` event handler — if any toolbar processes are running, shows native `dialog.showMessageBox` (Yes/No); Yes → `killAllProcesses` + `destroy()`; added `disposeProcessManager` to `closed` cleanup
- `src/preload/editor.ts`: added `getToolbarButtons`, `toolbarRunButton`, `toolbarKillButton`, `toolbarKillRestartButton` invokes; `onToolbarOutput`, `onToolbarProcessStarted`, `onToolbarProcessExited` event subscriptions
- `src/renderer/src/env.d.ts`: added `ToolbarChannel` and `ToolbarButton` interfaces; extended `EditorAPI` with toolbar methods
- `src/renderer/src/store/useToolbarStore.ts`: Zustand store — `buttons`, `runningButtonIds: Set<string>`, `setButtons`, `markRunning`, `markStopped`
- `src/renderer/src/components/layout/MainToolbar.tsx`: full implementation — loads buttons from IPC on mount; subscribes to `onToolbarOutput` (→ `logManager.append`), `onToolbarProcessStarted` / `Exited` (→ store); renders 32×32px buttons with emoji or `<img>` icon; animated spinner overlay (CSS keyframes injected once) while process running; `[‹]` / `[›]` scroll buttons appear when buttons overflow the strip (detected via `ResizeObserver` + scroll listener); modal dialog (Kill / Kill & Restart / Cancel) when clicking a running button

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (main 38.48 kB, preloads 4.44 kB, renderer 8,091 kB)

### User test checklist
1. Open a project — toolbar shows 5 default buttons (📂 💻 🔨 ▶ 🧪) with tooltips on hover
2. Confirm `.aide/toolbar.json` was created in the project directory with the default config
3. Click 📂 (Open in Explorer) — Windows Explorer opens at project root; spinner flashes briefly
4. Click 💻 (Open in VS Code) — VS Code opens at project root
5. Click 🔨 (Build) while project has `npm run build` — spinner animates; Build Output / Build Errors channels appear in log panel
6. Click 🔨 again while running → Kill / Kill & Restart / Cancel dialog appears
7. Kill & Restart → previous process killed, new one starts immediately
8. Add enough buttons in `.aide/toolbar.json` to overflow toolbar width → `[‹]` and `[›]` buttons appear; scrolling works
9. Close AIDE while a build is running → confirmation dialog "1 process is still running / Close AIDE anyway?" → Yes closes; No returns to editor

---

## Stage 5 — Terminal + Sessions

**Status:** Complete ✓

### What was built
- `src/main/pty/sessionScanner.ts`: `encodeProjectPath()` (e.g. `E:\Projects\AIDE` → `E--Projects-AIDE`), `getSessionsDir()`, `readSlugFromJsonl()` (scans JSONL lines for first `slug` field), `scanSessions()` (sorted by mtime descending), `watchSessionsDir()` (detects new `.jsonl` files, polls if dir doesn't exist yet), `watchJsonlFile()` (detects slug appearance in a specific JSONL file)
- `src/main/pty/registry.ts`: module-level `ptyRegistry: Map<BrowserWindow, PtyManager>` and `pickerEditorMap: Map<BrowserWindow, BrowserWindow>` — avoids circular dependencies
- `src/main/pty/ptyManager.ts`: `PtyManager` class — `createInitialTab()` (resume newest session or start fresh), `createNewSessionTab()`, `resumeSessionTab(sessionId)`, `write()`, `resize()`, `getTabs()`, `disposeAll()`; spawns PowerShell PTY; pushes `terminal:data`, `terminal:tab-exited`, `terminal:tab-slug-updated`, `terminal:tab-session-id` events to renderer
- `src/main/windows/editor.ts`: creates `PtyManager` on project open, stores in `ptyRegistry`; calls `disposeAll()` on window close
- `src/main/windows/sessionPicker.ts`: 500×400 BrowserWindow, no menu bar, `sessionPicker.js` preload, stores association in `pickerEditorMap`
- `src/main/ipc/index.ts`: added handlers — `terminal:create-initial`, `terminal:create-new`, `terminal:resume-session` (invoke), `terminal:write`, `terminal:resize` (fire-and-forget via `ipcMain.on`), `terminal:open-session-picker`; session picker handlers: `session-picker:get-sessions`, `session-picker:switch-tab`, `session-picker:resume-session`, `session-picker:new-session`
- `src/preload/editor.ts`: added full terminal API — `terminalCreateInitial`, `terminalCreateNew`, `terminalResumeSession`, `terminalWrite`, `terminalResize`, `terminalOpenSessionPicker`, `onTerminalData`, `onTerminalTabSlugUpdated`, `onTerminalTabSessionId`, `onTerminalTabExited`, `onTerminalSwitchTab`, `onTerminalNewTab`
- `src/preload/sessionPicker.ts`: new preload — `getSessions`, `switchTab`, `resumeSession`, `newSession`
- `electron.vite.config.ts`: added `sessionPicker` preload entry
- `src/renderer/src/env.d.ts`: added `DiskSession`, `SessionTabInfo`, `SessionPickerAPI`; extended `EditorAPI` with terminal methods; added `window.sessionPickerApi`
- `src/renderer/src/store/useSessionStore.ts`: Zustand store — `tabs: SessionTab[]`, `activeTabId`, `initialized`; actions: `initWithTab`, `addTab`, `setActiveTab`, `updateSlug`, `updateSessionId`, `markExited`
- `src/renderer/src/components/layout/TerminalPanel.tsx`: full implementation — `TerminalTab` (one xterm.js + FitAddon per tab, VS Dark theme, `onData` → PTY write, PTY data → `terminal.write`), `TabStrip` (horizontal scroll with `‹`/`›` overflow buttons, active tab highlighted), `TerminalContextMenu` (right-click → Copy/Paste via `navigator.clipboard`), `ResizeObserver` on container triggers fit on panel resize; `TerminalPanel` orchestrates init, push-event listeners, fit routing
- `src/renderer/src/windows/SessionPickerApp.tsx`: session picker UI — sorted session list with `●` indicator for open tabs, relative timestamps, "New session" button; closes picker on any selection
- `src/renderer/src/App.tsx`: added `session-picker` window type routing
- `src/main/filetree/watcher.ts`: added `fs.watch` on `.git/index` — triggers git status refresh on commit, `git add`, `git reset`, `git checkout` without sending `filetree:fs-changed` (no workspace files changed)

### Claude's checks
- `tsc --noEmit -p tsconfig.node.json` — **0 errors**
- `tsc --noEmit -p tsconfig.web.json` — **0 errors**
- `npm run build` — **succeeded** (main 28.23 kB, preloads 4.08 kB, renderer 692 kB)

### User test checklist
1. Open a project — terminal starts automatically; `claude --resume <id>` or `claude` runs in PowerShell PTY
2. Interact with Claude — full ANSI colors and cursor movement render correctly
3. Type `exit` in Claude — PowerShell prompt appears; terminal remains interactive
4. Right-click in terminal — context menu shows Copy (enabled if text selected) and Paste
5. Click `[ + ]` → Session Picker opens; existing sessions listed with dates; open sessions marked with `●`
6. Click a past session → new tab opens, `claude --resume` runs
7. Click "New session" → new tab, new `claude` session
8. Multiple tabs: all run simultaneously; switching tabs works; tab strip scrolls horizontally if overflow
9. Resize panel → terminal content reflows correctly
10. Collapse terminal → 20px strip; restore → terminal intact
11. Make a `git commit` in terminal → file tree git indicators update automatically (`.git/index` watcher)

---

## Stage 9 Follow-up — Toolbar Presets + Auto-Detection

**Status:** Complete ✓

### What was built
- `src/main/config/toolbarConfig.ts` — full rewrite:
  - `DEFAULT_TOOLBAR` trimmed to only 📂 Open in Explorer; `projectType: ''`
  - `ToolbarConfig.projectType?: string` field added
  - `ToolbarPresetGroup` interface: `{ type, label, buttons[] }`
  - `PRESET_GROUPS` constant: 7 groups — npm (build/dev/test/install), Unreal Engine, Unity, Python, Rust, Go, Docker
  - `detectProjectType(projectDir)` — priority: uproject → unity → npm → rust → go → python → docker
  - `readLocalToolbarConfig` / `writeLocalToolbarConfig` helpers
  - Presets are UI-only; the config stores only a flat `buttons[]` array
- `src/main/ipc/index.ts`:
  - Replaced `toolbar:get-buttons` → `toolbar:get-info` (returns `{ buttons, projectType, suggestedType }`)
  - Added `toolbar:get-presets` → returns `PRESET_GROUPS`
  - Added `toolbar:save-buttons(buttons[])` → replaces local buttons, returns merged result
  - Added `toolbar:set-project-type(type)` → persists type to `.aide/toolbar.json`
- `src/preload/editor.ts` — added `getToolbarInfo`, `getToolbarPresets`, `toolbarSaveButtons`, `toolbarSetProjectType`
- `src/renderer/src/env.d.ts` — added `ToolbarPresetGroup`, `ToolbarInfo` interfaces; updated `EditorAPI`
- `src/renderer/src/store/useToolbarStore.ts` — added `projectType`, `suggestedType`, `showAutoDetectDialog`, `showPresetDialog` + setters
- `src/renderer/src/components/layout/MainToolbar.tsx` — full rewrite:
  - On mount: calls `getToolbarInfo()` + `getToolbarPresets()`; shows auto-detect modal if `suggestedType !== null`
  - **Auto-detect dialog**: title "Detected X project", checkbox list of detected group's buttons (all pre-checked), "Add Selected" / "Skip (don't ask again)"
  - **Preset manager dialog**: shows all preset groups with headers + current non-preset buttons under "Other"; each button is checkbox + icon + tooltip + command; Save replaces toolbar buttons, Cancel closes
  - Hardcoded **"+" button** at right end of toolbar strip (always visible)

### Claude's checks
- `tsc --noEmit` — **0 errors**
- `npm run build` — **succeeded** (main 46.73 kB, preloads 4.70 kB, renderer 8.1 MB)

### User test checklist
1. Open a new project → `.aide/toolbar.json` created with `projectType: ''`, only 📂 visible
2. Project with `package.json` → auto-detect modal appears with npm buttons pre-checked
3. "Add Selected" → npm buttons appear; modal gone; next open = no modal
4. "Skip" → modal gone; next open = no modal
5. Click "+" → preset manager opens; all groups shown with headers; currently active buttons pre-checked
6. Check/uncheck any buttons → Save → toolbar updates immediately
7. Uncheck 📂 → it disappears from toolbar
8. Close AIDE with running process → confirm dialog still works

---

## Stage 9 Follow-up #2 — Unreal commands + General preset group + Configure manually

**Status:** Complete ✓

### What was built
- `src/main/config/toolbarConfig.ts`:
  - Added `General` preset group at the top of `PRESET_GROUPS` with the 📂 Open in Explorer button — makes it visible and removable in the preset manager dialog
  - Unreal Engine group expanded from 2 → 5 buttons with correct production commands:
    - **Open in UE Editor** — `${unrealVersionSelector} /editor <project.uproject>` (via `for %f in ("*.uproject")`)
    - **Build** — `UnrealBuildTool.exe <ProjectName>Editor Win64 Development <project.uproject> -rocket`
    - **Open in Visual Studio** — `for %f in ("*.sln") do start "" "%f"`
    - **Clear Intermediate** — PowerShell: removes `Intermediate DerivedDataCache Saved Binaries .vs Build Script`, `*.sln`, and `Plugins\*/Intermediate`
    - **Generate VS Files** — `GenerateProjectFiles.bat -project=<project.uproject> -game -rocket`
  - Unreal commands use `${unrealEngine}` and `${unrealVersionSelector}` placeholders (resolved at spawn time)
- `src/main/unreal/engineFinder.ts` — new file:
  - `queryRegSZ(keyPath, valueName)` — thin wrapper around `reg query` + REG_SZ output parser
  - `getEngineAssociation(projectDir)` — reads `EngineAssociation` from `.uproject` JSON
  - `findUnrealEngineDir(projectDir)` — looks up engine root: HKLM first (Launcher installs), then HKCU (custom/source builds)
  - `findUnrealVersionSelector()` — reads UVS path from `HKCR\Unreal.ProjectFile\shell\switchversion` → `Icon`
- `src/main/toolbar/processManager.ts`:
  - Added `${unrealVersionSelector}` substitution (lazy, only queries registry when placeholder is present)
- `src/renderer/src/components/layout/MainToolbar.tsx` — auto-detect dialog:
  - Added **"Configure manually…"** link at bottom-left — dismisses auto-detect, sets `projectType = 'dismissed'`, opens preset manager immediately

### Claude's checks
- `tsc --noEmit` — **0 errors**
- `npm run build` — **succeeded**

### User test checklist
1. Open Unreal project → auto-detect shows "Detected Unreal Engine project" with 5 buttons pre-checked
2. "Add Selected" → UE buttons appear in toolbar
3. Click "Open in UE Editor" → UVS opens correct engine version for this project
4. Click "Build" → UBT runs, output appears in log panel
5. Click "Clear Intermediate" → all build artifact folders removed (including plugin intermediates)
6. Click "Generate VS Files" → GenerateProjectFiles.bat runs with correct .uproject path
7. "Configure manually…" in auto-detect → closes modal, opens full preset manager directly
8. General group visible in preset manager with 📂 checked; uncheck it → disappears from toolbar

---
