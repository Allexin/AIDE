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
