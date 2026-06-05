# AIDE — AI-Driven Code Editor

Electron + React + TypeScript desktop code editor. Windows only.

## Architecture

**Main process** (`src/main/`): Electron main, IPC handlers, FS watcher, git runner, pty manager, window creation.

**Preload** (`src/preload/`): Context bridge scripts for each window type (editor, picker, settings, etc.).

**Renderer** (`src/renderer/src/`): React UI with Zustand stores.

### Key directories

- `src/main/ipc/index.ts` — all IPC handlers
- `src/main/filetree/` — FS watcher + git status runner
- `src/main/pty/` — node-pty terminal management
- `src/main/windows/` — BrowserWindow creation (editor, picker)
- `src/main/config/` — app config, project config, toolbar config
- `src/renderer/src/store/` — Zustand stores (editor, fileTree, panel, session, toolbar, log, toast)
- `src/renderer/src/components/` — React components (layout, filetree, git)

### Tech stack

- **Electron** + **electron-vite** for build/dev
- **React 18** + **TypeScript**
- **Zustand** for state management
- **Monaco Editor** for code editing
- **xterm.js** + **node-pty** for integrated terminal
- **No test framework** currently configured

## Core Concepts

### Project Lifecycle
- App launch → Project Picker (recent projects list + "Open Folder")
- CLI launch with path (`aide.exe .`) or cwd with `.aide/` → opens editor directly
- Lock file (`.aide/lock`) prevents two instances on the same project

### Layout & Panels
- Panels: file tree column, editor area, terminal area, log strip, status bar
- Editor + terminal split: active panel gets 75%, inactive 25%
- Terminal collapses to 20px strip with vertical "Claude Code" label
- Panel ratios stored in `.aide/settings.json`

### File Tree
- Lazy directory loading, dot-prefixed entries hidden
- Git status indicators: `●` changed, `?` untracked
- "Modified only" toggle: shows only changed files with directory hierarchy
- FS watcher auto-updates tree on external changes

### Terminal & Sessions
- xterm.js + node-pty (PowerShell), cwd = project root
- Auto-start: resumes latest Claude Code session or starts new one
- Session tabs with titles stored in `.aide/Titles/{sessionId}.txt`
- Session Picker window for managing multiple sessions

### Code Editor
- Monaco Editor, single file (no tabs), theme `vs-dark`
- Auto-save on focus loss; conflict dialog on external modification
- Diff view: Monaco DiffEditor comparing HEAD vs disk content (`git show HEAD:<path>`)
- Large file confirmation dialog (configurable `maxFileSizeMb`)

### Toolbar
- Buttons loaded from `aide/toolbar.json` (shared) + `.aide/toolbar.json` (local, wins on duplicate id)
- Each button spawns a child process; output routed to log channels
- Spinner overlay while process runs; kill/restart dialog on re-click
- Running processes check before app close or project switch

### Git Integration
- Background git status via watcher (300ms debounce, serial queue)
- Commit dialog: file selection + message → streamed git progress
- Status bar sensors: branch name, file git status

### Log Panel
- Channel-based, collapsed by default, virtualized rendering
- 10k line buffer per channel; attention system (blinking tab label)

### Status Bar
- Sensors based

## Conventions

- **Versioning**: `package.json` (and `package-lock.json`) auto-increment the `version` on each build. These bumped files MUST be committed together with the code changes they correspond to, so the committed version matches the commit. Do NOT leave the version bump uncommitted or split it into a separate commit — `git add` the package files alongside your edits.
- **All UI text MUST be in English.** No Russian or other non-English strings in any component, tooltip, dialog, or label. This is a strict requirement.
- IPC channels use namespaced format: `domain:action` (e.g. `filetree:git-status`, `editor:git-show-head`)
- Stores are single-file Zustand stores with `use[Name]Store` naming
- The `.aide/` directory inside each project stores local config (settings, toolbar, terminal titles)
- Git operations run with timeouts (15s for status, 5s for branch) to avoid hangs
- FS watcher skips dot-prefixed paths (`.git`, `.aide`, etc.)
- **Logging**: NEVER use `console.log`/`console.warn`/`console.error` for debug or any other logs. Use the built-in log system: `logManager.append(channel, message)` from `useLogStore.ts`. Logs appear in the Log Panel UI. Import: `import { logManager } from '../../store/useLogStore'`
- **Preload API types**: `src/preload/editor.ts` defines `EditorAPI` as a TypeScript interface at the top of the file AND as an object literal below. When adding a new method, update **both**: the interface declaration and the object implementation. Same pattern applies to other preload files (`sessionPicker.ts`, `historyViewer.ts`, etc.) that define a local interface. The renderer-facing types in `src/renderer/src/env.d.ts` must also be kept in sync.
