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
