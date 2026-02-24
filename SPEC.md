# AIDE — AI-Driven Editor
## Product Specification

---

## 1. Overview

AIDE is a lightweight code editor designed around a single workflow: **collaborating with Claude Code**. The editor is not trying to compete with VS Code in terms of features — it is intentionally minimal, optimized for the loop of "talk to Claude → review changes → edit manually → commit".

The core idea is that the terminal running Claude Code and the code editor are **equal citizens** of the workspace, not an afterthought. The UI dynamically adapts to where your attention is.

**Target platform:** Windows
**Target user:** Developer working with Claude Code CLI on a daily basis.

### 1.1 Window

Standard native OS window with system title bar and decorations (minimize, maximize, close). No borderless/custom chrome.

**Title bar:** `AIDE — <project folder name>`
The project folder is set once at launch and does not change during the session. To work on a different project, open a new instance.

**Default size:** 1280×720 px. Window size and position are not saved between sessions.

### 1.2 Single instance per directory

Only one AIDE instance may open a given project directory at a time. If a second instance attempts to open the same directory, it shows an error message and returns the user to the Project Picker — no attempt is made to focus the existing instance.

**Implementation:** lock file per project. On project open, AIDE writes `.aide/lock` containing the current process PID. On startup, if `.aide/lock` exists and the recorded PID belongs to a running process, the project is considered already open — show error: *"This project is already open in another AIDE window."* → return to Project Picker. If the PID is stale (process dead), overwrite the lock file. Lock file is deleted on clean exit.

Multiple AIDE instances may run simultaneously as long as each opens a different project directory.

---

## 2. Technology Stack

### 2.1 Framework: Electron

**Why Electron:**
- The two hardest UI components — terminal emulation and code editing — have best-in-class JavaScript implementations (xterm.js and Monaco Editor). Using any native framework means either shipping inferior versions of these or embedding a browser engine anyway.
- Electron bundles Chromium, which means Monaco and xterm.js run in their native environment with zero adaptation cost.
- Bundle size and RAM usage are not concerns for this project.
- Windows-only target eliminates the main cross-platform complexity of Electron.

### 2.2 Language: TypeScript

Typed JavaScript. Makes the codebase readable and navigable without deep JS ecosystem knowledge. Catches errors at compile time rather than runtime.

### 2.3 UI: React

Component model maps cleanly to the panel-based layout of the editor. Declarative state management makes the dynamic resize behavior (focus-driven panel sizing) straightforward to implement.

### 2.4 State management: Zustand

Zustand is a minimal global state library for React. Chosen because:
- No boilerplate (no actions, reducers, or providers like Redux requires)
- State is accessed directly from any component without prop-drilling
- Simple mental model: a store is just an object with values and functions that update them

The app is divided into focused stores:

| Store | Owns |
|---|---|
| `useAppStore` | Current project path, recent projects, loaded config |
| `usePanelStore` | Panel sizes, which panels are visible, focus state |
| `useEditorStore` | Currently open file, diff/edit mode toggle |
| `useSessionStore` | Session registry (open tabs, PTY processes) |
| `useLogStore` | Log channels and their content |

### 2.5 Build tooling: electron-vite

Fast dev server with hot reload for the renderer process. Standard choice for modern Electron apps.

### 2.6 Component breakdown

| Component | Library | Rationale |
|---|---|---|
| Code editor | Monaco Editor | VS Code's engine. Syntax highlighting for 50+ languages, built-in diff viewer, mature API. |
| Terminal | xterm.js + xterm-addon-fit | Industry standard for browser-based terminal emulation. Full ANSI/VT support. |
| PTY (Windows) | node-pty | Wraps Windows ConPTY API. Required for PowerShell and Claude Code to behave correctly. |
| Git operations | child_process + git CLI | No abstraction layer needed. Direct git calls are simple, debuggable, and reliable. |

---

## 3. Layout

```
┌──────────────────────────────────────────────────────────────┐
│  AIDE — ProjectName                               [─][□][×]  │  ← native title bar
├──────────────────────────────────────────────────────────────┤
│  File   Edit   ...                                           │  ← native menu bar
├──────────────────────────────────────────────────────────────┤
│  [⬡]  [⬡]  [⬡]  ...                                 [<][>] │  ← main toolbar (full width)
├──────────────┬───────────────────────────────────────────────┤
│  [▣][↺][◎]  │                                               │  ← file tree toolbar (column-scoped)
├──────────────┤  Editor / Diff View    │  Terminal            │
│              │                        │  (Claude Code)       │
│  File Tree   │                        │                      │
│              │                        │                      │
│              ├────────────────────────┴─────────────────────┤
│              │ ══[Git]══[Build Output]══[Build Errors]══ [∧] │  ← log panel (collapsed)
├──────────────┴──────────────────────────────────────────────┤
│  Status Bar                                                  │
└──────────────────────────────────────────────────────────────┘
```

Two separate toolbars at different vertical positions:
- **Main toolbar** — full application width, below the native menu bar. Large icon-only buttons. Described in section 5.
- **File tree toolbar** (`[▣][↺][◎]`) — small buttons, positioned directly below the main toolbar but scoped to the file tree column only. Described in section 7.2.

The main toolbar spans the full width including the file tree column. The file tree toolbar appears in the same horizontal band as the top of the editor/terminal area but is a separate component contained within the file tree column.

### 3.1 Panel states

The editor and terminal panels behave differently:

**Terminal panel** has three states:

| State | Width | Behavior |
|---|---|---|
| **Active** | `activePanelRatio` (default 75%) | Focused, receiving input |
| **Inactive** | `1 - activePanelRatio` (default 25%) | Fully functional, just narrower |
| **Collapsed** | `collapsedWidthPx` (default 20px) | Vertical "Claude Code" label; click to restore |

**Editor panel** has two states:

| State | Behavior |
|---|---|
| **Visible** | File is open — panel exists and participates in the 75/25 split with terminal |
| **Hidden** | No file open — panel is not rendered, terminal takes full width |

The editor panel never collapses to a strip. It either exists or it doesn't.

Active and inactive terminal/editor panels are **fully functional**. Collapsed is the only non-interactive state (terminal only).

**Resize trigger:** panel size changes are triggered by the panel that *receives* focus, not the one that loses it. If focus moves from the editor to the log panel (or status bar, or any non-editor/terminal area), no resize occurs. Resize only fires when the editor or the terminal gains focus.

**Resize speed:** instantaneous — no animation. Collapse/expand of the terminal strip may be animated if the implementation supports it simply; otherwise also instantaneous.

### 3.2 Startup state

On launch no file is open — the editor panel is not rendered. The terminal takes all available center width.

```
┌──────────┬────────────────────────────────────────┐
│ File     │  Terminal (Claude Code)                │
│ Tree     │  full available width                  │
└──────────┴────────────────────────────────────────┘
```

### 3.3 Editor visibility

The editor panel is shown or hidden based on whether a file is open:
- **File selected, terminal not collapsed** → editor panel appears and receives focus (takes `activePanelRatio` = 75%), terminal becomes inactive (25%)
- **File selected, terminal collapsed** → editor panel appears and takes all available width; terminal remains collapsed (20px strip)
- **File closed** → editor panel disappears, terminal state is unchanged (collapsed stays collapsed, inactive stays inactive)

No collapsed strip for the editor — it either exists or it doesn't.

### 3.4 Editor close triggers

- User clicks the close (×) button in the editor panel header
- Currently open file is deleted on disk (filesystem watcher → auto-close)
- If a diff view is open for the deleted file — it closes with the panel

### 3.5 Terminal collapse

The terminal can be manually collapsed via a button in its header. It shrinks to a **20px vertical strip** on the right with "Claude Code" written vertically. The process keeps running. Click the strip to restore.

The collapse button is always available. If the editor panel is closed while the terminal is in collapsed state, the terminal remains collapsed — the user collapsed it intentionally and the state is preserved.

```
┌──────────┬──────────────────────────────────┬──┐
│ File     │  Editor (full available width)   │C │
│ Tree     │                                  │L │
│          │                                  │A │
│          │                                  │U │
│          │                                  │D │
│          │                                  │E │
└──────────┴──────────────────────────────────┴──┘
```

### 3.6 Sizing configuration

Panel ratios stored in `.aide/settings.json` (user-local, auto-created):

```json
{
  "panelSizing": {
    "activePanelRatio": 0.75,
    "collapsedWidthPx": 20
  }
}
```

`inactivePanelRatio` is always `1 - activePanelRatio` — derived, never stored.

File tree width and log panel expanded height are stored in Electron's `userData` (app-level config, see section 4.2).

**Why horizontal split, not vertical:**
Claude Code is an interactive TUI application that needs vertical space to render correctly.

### 3.7 File tree column

Fixed left column. Not collapsible — with no tabs, the file tree is the primary navigation instrument. Width is fixed (not user-resizable at runtime) and configured via the app-level config in `userData`:

```json
{
  "ui": {
    "fileTreeWidthPx": 220,
    "logPanelExpandedHeightPx": 200
  }
}
```

---

## 4. Configuration System

AIDE merges two config layers at startup. Changes take effect on restart only.

| Directory | Scope | Git-tracked | Created by |
|---|---|---|---|
| `./aide/` | Project-global | Yes | User manually |
| `./.aide/` | User-local | No | AIDE automatically |

Merge order: project-global (`aide/`) loaded first, user-local (`.aide/`) applied on top. If both files define a button with the same `id`, the user-local version wins — local configuration always takes priority over shared project config.

### 4.1 Config directory layout

```
project-root/
  aide/                ← committed to git, shared with team
    toolbar.json       ← toolbar button definitions
  .aide/               ← local only, in .gitignore, auto-created by AIDE
    toolbar.json       ← user's personal button overrides/additions
    settings.json      ← user's personal panel sizing overrides (activePanelRatio, collapsedWidthPx only)
    lock               ← PID lock file (see section 1.2)
```

### 4.2 .gitignore setup

When AIDE creates the `.aide/` directory on first project open, it also ensures `.aide` is excluded from git:
- If `.gitignore` exists at project root → append `.aide` if not already present
- If `.gitignore` does not exist → create it with a single line: `.aide`

This happens automatically and silently. No user confirmation needed.

### 4.3 Application-level config

Stored in Electron's `userData` (outside the project directory). Split into two files to isolate static settings from frequently-written dynamic state — a crash during state write cannot corrupt hand-edited configuration.

**`aide-config.json`** — static settings, rarely written, safe to hand-edit:

```json
{
  "editor": {
    "maxFileSizeMb": 5,
    "fontFamily": "Cascadia Code, Consolas, monospace",
    "fontSize": 14,
    "minimap": false,
    "wordWrap": "off",
    "lineNumbers": "on",
    "tabSize": 2
  },
  "ui": {
    "fileTreeWidthPx": 220,
    "logPanelExpandedHeightPx": 200
  },
  "sessions": {
    "maxSessionsInPicker": 20,
    "maxRecentProjects": 20
  }
}
```

**`aide-state.json`** — dynamic runtime state, written on every project open:

```json
{
  "recentProjects": [
    {
      "path": "E:\\Projects\\MyApp",
      "lastOpened": "2026-02-24T10:00:00Z"
    }
  ]
}
```

All `editor.*` fields are passed directly to the Monaco Editor instance on startup. Changes take effect on restart.

**Theme:** Monaco's built-in `vs-dark` theme is used for the editor. The same theme's CSS variables and color tokens are used for all other UI elements (panels, toolbars, status bar, dialogs) — this keeps styling simple and consistent without maintaining a separate design system.

---

## 5. Main Toolbar

Large icon-only buttons spanning the **full application width** (including the file tree column). Tooltip shown on hover. No text labels on buttons.

Buttons are defined entirely through configuration — there are no hardcoded native buttons. If no config files are present, the toolbar is empty.

**Overflow:** if buttons do not fit the toolbar width, `[<]` and `[>]` scroll buttons appear at the right end of the toolbar to navigate through the overflow.

### 5.1 Button process lifecycle

Each button is bound to a background process. Clicking a button:

1. **No process running** → spawn the command as a `child_process`, attach stdout/stderr to the configured log channels. Process runs asynchronously — UI is not blocked.
2. **Process already running** → show a modal dialog:

**Running indicator:** while a process is alive, the button displays an animated spinner overlay (e.g. rotating clock ⏳ or similar). The animation makes it immediately visible which buttons have active processes. The spinner disappears when the process exits.

**App close with running processes:** if any toolbar processes are running when the user closes the AIDE window, a confirmation dialog is shown:

```
┌────────────────────────────────────────┐
│  2 processes are still running.        │
│  Close AIDE anyway?                    │
│                                        │
│           [ Yes ]   [ No ]             │
└────────────────────────────────────────┘
```

- **Yes** → terminate all running toolbar processes, then close the app
- **No** → dismiss dialog, return to the editor

```
┌────────────────────────────────────────┐
│  "Build project" is already running.  │
│                                        │
│  [ Kill ]   [ Kill & Restart ]   [ Cancel ] │
└────────────────────────────────────────┘
```

| Action | Behavior |
|---|---|
| **Kill** | Terminate the running process; do nothing else |
| **Kill & Restart** | Terminate the running process; immediately spawn a new one |
| **Cancel** | Dismiss dialog; leave process running |

### 5.2 Button definition format

Declared in `aide/toolbar.json` (global) or `.aide/toolbar.json` (local):

```json
{
  "buttons": [
    {
      "id": "build",
      "icon": "🔨",
      "tooltip": "Build project",
      "command": "npm run build",
      "cwd": "${projectRoot}",
      "channels": {
        "stdout": { "name": "Build Output" },
        "stderr": { "name": "Build Errors", "attention": true }
      }
    }
  ]
}
```

### 5.3 Icon system

The `icon` field accepts two formats:

| Format | Example | Behavior |
|---|---|---|
| Unicode emoji | `"🔨"`, `"▶"`, `"⚙"` | Rendered directly as text — no image files needed |
| File path | `"./icons/build.png"` | Image loaded from that path; if relative, resolved relative to the config file that declared the button |

Emoji covers the majority of use cases. Custom image files are for project-specific branding or non-standard symbols.

---

## 6. Menu Bar

Native OS menu bar (Electron `Menu.setApplicationMenu`). Menu items reference the command registry — no logic is duplicated.

```
File
  New Window          → opens a new AIDE instance (no project pre-selected)
  Open Folder...      → native folder picker → opens project in new instance, closes current
  Open Recent       ▶ → submenu: recent projects → opens in new instance, closes current
  ────────────────
  Exit

Edit
  Undo                → Monaco: undo  (disabled when editor not focused)
  Redo                → Monaco: redo  (disabled when editor not focused)
  ────────────────
  Cut                 → (disabled when editor not focused)
  Copy                → (disabled when editor not focused)
  Paste               → (disabled when editor not focused)
```

**Notes:**
- Any project-switching action (Open Folder, Open Recent) always spawns a **new AIDE instance** and closes the current one. This avoids re-initializing sessions, filesystem watchers, and config mid-session.
- **Running processes check on project switch:** if any toolbar processes are running at the moment the user triggers Open Folder or Open Recent, the same confirmation dialog as on app close is shown immediately before any other action:
  ```
  ┌────────────────────────────────────────┐
  │  2 processes are still running.        │
  │  Close AIDE anyway?                    │
  │                                        │
  │           [ Yes ]   [ No ]             │
  └────────────────────────────────────────┘
  ```
  - **Yes** → terminate all running toolbar processes, then proceed with the project switch
  - **No** → dismiss dialog, cancel the project switch
- The Project Picker and the Editor are **always separate Electron windows**. Opening a project from the Picker closes the Picker window and opens a new Editor window. Going back to the Picker (via any project-switching action) closes the current Editor window and opens a new Picker window. The Picker is never "embedded" — it is always a fresh instance.
- Edit commands are enabled only when the code editor has focus.
- Find/Replace: not implemented in v1.
- View menu: not needed in v1.

---

## 7. File Tree

Displays the file/directory structure of the current working directory.

### 7.1 Filtering rules

- **Hidden:** all entries whose name starts with `.` (dot-prefixed = technical artifacts)
- **Everything else:** shown, including `node_modules`, binary files, etc.
- Directories render with expand/collapse triangles. Files are leaves.
- Single click on a directory → expand/collapse. Single click on a file → open in editor.
- Sorting: directories before files, alphabetical within each group.

**"Modified only" mode** maintains the full directory tree structure — directories are shown as needed to display the path to each modified file. Only unmodified files are hidden; the directory hierarchy is preserved for context. If no files are modified, the tree shows a centered label: *"No changes in project"*.

### 7.2 File tree toolbar (small)

Small buttons in a thin toolbar strip positioned directly below the main toolbar, within the file tree column only. Does not extend into the editor/terminal area.

- **Refresh** — rescans directory (or re-runs `git status` if "Modified only" is active)
- **Modified only** toggle — shows only files with uncommitted changes (`git status`). If git is not initialized or unavailable, the tree shows a centered label: *"Git is not available"*
- **Commit** — opens the Commit Dialog

### 7.3 File interactions

- **Single click** — opens file in editor; the previously open file loses focus, triggering auto-save which writes any unsaved changes to disk
- **Right-click → View Diff** — attempts to open diff view in editor panel. If the file has no diff to show (untracked or identical to HEAD), the no-diff dialog is shown instead (section 9.0).

### 7.4 Visual indicators

- All files with uncommitted changes are visually marked with a single uniform change indicator (distinct color or dot) — no distinction between modified/added/renamed/untracked. The indicator signals only that the file differs from HEAD.
- Deleted files are not shown in the file tree at all (they no longer exist on disk). They appear only in the Commit Dialog (section 13.1).
- The "Modified only" mode applies the same rule: deleted files are not shown in the tree, but all other changed files are.

### 7.5 Filesystem watcher

A watcher runs on the entire project directory for the lifetime of the session. It handles:

| Event | Action |
|---|---|
| File created | Add to file tree |
| File deleted | Remove from file tree; if that file is open in editor → close editor panel |
| File modified (external) | If that file is open in editor → immediately trigger auto-save: if no local changes, silently reload from disk; if local changes exist, show the conflict resolution dialog (section 8.3) |
| Directory created/deleted | Update file tree accordingly |

The watcher respects the same filtering rules as the tree (dot-prefixed entries ignored).

---

## 8. Code Editor

Monaco Editor instance. Single file open at a time — no tabs.

### 8.1 Editor panel header

Thin header bar above the Monaco instance. Contains:
- Relative file path from project root (e.g. `src/components/App.tsx`)
- **Diff toggle button** — attempts to load diff for the current file. Label: `[Diff]` when in editor mode, `[Edit]` when in diff mode. Always active — if the file has no changes, the no-diff dialog is shown instead (see section 9.0).
- **Close button (×)** on the right — closes the current file entirely (both editor and diff view disappear, editor panel is hidden)

The × button always closes the file, regardless of whether editor or diff view is currently active.

### 8.2 Auto-save

Auto-save is triggered in two cases:
- **Focus loss** — editor loses focus (switching files, clicking terminal, clicking file tree, etc.)
- **External modification detected** — filesystem watcher reports the open file was changed on disk; auto-save fires immediately regardless of focus

No manual save, no prompts.

If auto-save is triggered by **external modification** and the editor content has not changed since the file was read from disk — the file is **silently reloaded** from disk. There is nothing to conflict: the user has no local changes to protect.

If auto-save is triggered by **focus loss** and the editor content has not changed — auto-save does nothing (no write, no `mtime` update).

### 8.3 File conflict on save

If the file on disk has been modified externally since it was opened (detected by comparing `mtime` at open time vs save time), auto-save is suspended and a modal dialog is shown:

> **File conflict**
> `src/components/App.tsx` was modified externally while you were editing it.

| Button | Action |
|---|---|
| **Reload** *(Discard my changes)* | Load current disk version into editor; user edits are lost |
| **Keep mine** *(Discard external edit)* | Overwrite disk with editor content; external changes are lost |
| **Backup & Open** | Save editor content to `App.tsx.<timestamp>.backup` in the same directory; open that backup file in the editor |

Auto-save resumes after the user makes a choice. The dialog cannot be dismissed without choosing — the conflict must be resolved.

**Event suppression while dialog is open:** all incoming auto-save triggers (both focus-loss events and filesystem watcher notifications) are silently ignored while the conflict resolution dialog is visible. Once the user resolves the conflict, normal auto-save behavior resumes.

Future: built-in merge tool as a fourth option.

### 8.4 Large and binary files

All files are treated as text and opened in Monaco regardless of type or content.

- **File size ≤ `maxFileSizeMb`** (default 5 MB, configured in app config) → open directly
- **File size > `maxFileSizeMb`** → show confirmation dialog:
  > *"This file is 47 MB. Opening large files may cause performance issues. Open anyway?"*
  - Yes → open in Monaco
  - No → cancel

Future: per-type handlers (HEX viewer, image preview, etc.)

---

## 9. Diff View

Opened via right-click → "View Diff" in the file tree context menu, or via the **[Diff]** toggle button in the editor panel header.

The diff view renders inside the same editor panel, replacing the Monaco editor instance. Switching back is done via the **[Edit]** toggle button in the header. The × (close) button always closes the file entirely — it does not toggle between views.

Compares: `HEAD` version (`git show HEAD:<filepath>`) vs current file on disk.

### 9.0 No-diff scenario

Diff is always attempted when requested. If no diff can be shown, a dialog appears with an appropriate message:

| Condition | Message |
|---|---|
| File is identical to HEAD | *"File has not changed since last commit."* |
| File is untracked (no HEAD version) | *"File is not tracked by git — there is no diff to show."* |

- **If triggered from file tree context menu** (editor not open): buttons `[ Open Editor ]` `[ Cancel ]`
- **If triggered from `[Diff]` button in editor header** (editor already open): button `[ OK ]` only — offering "Open Editor" would be redundant

### 9.1 Display: Monaco DiffEditor

Monaco's built-in `DiffEditor` component:
- Side-by-side view with syntax highlighting on both sides
- Color-coded changes (green = added, red = removed)
- Word-level inline decorations
- Synchronized scrolling
- Collapsed unchanged regions
- Read-only — no editing in diff view

---

## 10. Terminal

### 10.0 PTY architecture

Each terminal tab runs a **PowerShell** process as the PTY host. The working directory is always the project root. Claude Code is launched as a command within that shell:

```
node-pty → PowerShell
               └─ claude --resume <id>   (or claude)
```

When Claude Code exits (user types `exit`, task completes, or crash), the user is returned to the PowerShell prompt within the same tab. The terminal remains fully interactive — it is not frozen. The user can run arbitrary shell commands or restart Claude manually.

xterm.js connected to node-pty.

- Full ANSI color and cursor support (required for Claude Code's TUI)
- Fit addon auto-resizes the PTY on panel resize

If PowerShell or `claude` is not found at startup, the terminal displays the launch error — sufficient signal for a developer audience.

### 10.1 Terminal panel header

```
[ swirling-stargazing ][ brave-debug ][ + ]       [ collapse ]
```

- **Session tabs** — labeled with the Claude Code session slug. Each tab is an independent PTY + xterm.js instance, all running continuously in the background.
- **Tab overflow:** if session tabs exceed the available header width, the tab strip scrolls horizontally (mouse wheel or drag). No tab wrapping — always a single row.
- **[ + ]** — opens the session picker
- **[ collapse ]** — collapses panel to the 20px vertical strip

When a Claude Code process exits (e.g. user typed `exit`), the tab remains open showing the final terminal state. The process is not restarted automatically — the user may have exited intentionally to run a shell command.

### 10.2 Sessions

All sessions are Claude Code sessions (`claude` process), not plain shells.

#### Session registry

```typescript
interface SessionTab {
  tabId:     string
  sessionId: string   // Claude Code session UUID
  slug:      string   // human-readable name from JSONL
  pty:       IPty
  terminal:  Terminal
}

const openSessions = new Map<string, SessionTab>() // sessionId → tab
```

#### Session storage on disk

```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

`<encoded-project-path>` replaces path separators with `--`
(e.g. `E:\Projects\AIDE` → `E--Projects-AIDE`).

The filename (without `.jsonl`) is the session UUID. The `slug` field is found by scanning JSONL lines for the first entry containing `"slug"`.

If the slug has not yet been generated (new session, no interactions yet), the tab label shows **"Claude Code"** as a placeholder. AIDE watches the JSONL file for changes and updates the tab label as soon as the slug appears. There is no timeout — the label remains "Claude Code" indefinitely until the slug is written by Claude Code.

#### Auto-start on project open

```
1. Read ~/.claude/projects/<encoded>/*.jsonl
2. If files exist:
     sort by LastWriteTime → take newest → sessionId = filename
     register sessionId in openSessions immediately
     send to PowerShell PTY: claude --resume <sessionId>
3. If no files exist:
     send to PowerShell PTY: claude
     register sessionId once new .jsonl appears (filesystem watcher)
```

No stdout parsing — session ID is known from disk before the command runs.

#### Session picker ([ + ] button)

```
┌─────────────────────────────────────────────────────┐
│  Sessions                                    [×]    │
│  ─────────────────────────────────────────────────  │
│  ●  swirling-stargazing-tome    Today 12:01         │  ← running → switch tab
│     brave-debugging-quest       Yesterday           │  ← resume
│     curious-refactor-moon       Feb 20              │  ← resume
│                                                     │
│                          [ New session ]            │
└─────────────────────────────────────────────────────┘
```

The session picker is a **separate native OS window** (not an in-app modal). It has a standard system close button (`[×]`) in the title bar — closing it without selecting anything is the standard way to dismiss.

- Sessions sorted by last modified time (newest first)
- Maximum number of sessions shown is configured via `sessions.maxSessionsInPicker` in app config (default 20)
- Session slug + last modified time shown per entry
- `●` = already open → click switches to that tab, no new process
- No marker = not running → click spawns `claude --resume <sessionId>`
- **New session** → spawns `claude`, registers once new `.jsonl` appears in directory (detected via filesystem watcher on `~/.claude/projects/<encoded>/`; the new file's name is the sessionId)
- Selecting a session or clicking New session closes the picker window automatically

---

## 11. Log Panel

Horizontally tabbed output panel. General-purpose output sink for all background operations — git, build, tests, linters, or any future tool.

### 11.1 Architecture

```typescript
interface LogChannel {
  id:        string
  label:     string
  lines:     string[]
  attention: boolean
}

// LogManager — singleton
logManager.createChannel('Git')
logManager.append('Git', '> git commit -m "fix"')
logManager.clear('Git')
```

Any app subsystem creates a channel by name and appends to it. Existing channels accumulate output.

### 11.1.1 Performance

The log panel must remain responsive regardless of output volume. Implementation requirements:

- **Virtualized rendering** — only the visible rows are in the DOM at any time. Use a windowed list (e.g. `react-window` or equivalent). Appending thousands of lines must not cause slowdowns.
- **Max buffer per channel:** 10 000 lines. When the limit is reached, the oldest lines are dropped (circular buffer). A note is prepended: *"[Older output truncated]"*.
- **Text selection and copy:** standard browser text selection within the visible area. `Ctrl+C` copies selected text. No custom copy button needed.
- **No ANSI rendering:** ANSI escape codes are stripped before display. Output is plain text. If stripping is not applied, escape sequences appear literally — this is acceptable only if stripping is trivially simple; otherwise strip.

### 11.2 Channels

All channels are **on-demand** — created automatically when output is first appended. No channels exist at startup.

| Channel | Created when | `attention` |
|---|---|---|
| `Git` | First git operation runs | `false` — succeeds quietly |
| `Build Output` | Build command runs | `false` |
| `Build Errors` | Build command produces stderr | `true` |

Any channel can be closed by the user (section 11.5) and will be re-created automatically on next use.

### 11.3 Attention system

`attention: true` on a channel triggers when new content arrives:
1. Log panel expands if collapsed
2. That channel's tab becomes active
3. Tab label blinks until the user clicks it
4. **Keyboard focus is not stolen** — editor or terminal keeps focus

`attention: false`: content appended silently.

### 11.4 Panel behavior

- **Collapsed by default** — shows as a thin strip with a toggle button `[∧]`
- Strip height = the minimum needed to fit the toggle button. When no tabs exist, only the button is shown on the strip — no wasted space.
- The strip may be empty at startup (no channels until a git operation or build runs)
- Expanded height is configured via `ui.logPanelExpandedHeightPx` in app config (default 200px)
- Click tab label or `[∧]` → panel expands to show content
- Click `[∨]` → collapses back to strip
- `attention` expands the panel if it was collapsed
- Output is plain monospace text (no ANSI parsing — this is not a terminal)

### 11.5 Tab context menu

Right-click on any tab:

```
Clear
──────
Close
```

- **Clear** — empties channel output; tab remains open
- **Close** — removes tab; channel unregistered. If new output is later appended to a closed channel, the channel is automatically re-created.
- The log panel can be fully empty (no tabs). An empty panel shows a blank area.

---

## 12. Status Bar

Thin bar at the bottom. Configurable set of **sensors** — small read-only indicators.

### 12.1 Architecture

```typescript
interface StatusBarSensor {
  id:              string
  position:        'left' | 'right'
  render:          () => string | ReactNode
  onClick?:        () => void
  refreshInterval?: number               // ms, optional auto-refresh
}

const sensors: StatusBarSensor[] = [
  gitBranchSensor,       // left:  "main"
  fileStatusSensor,      // left:  "M" / "?" / clean
  cursorPositionSensor,  // right: "Ln 42, Col 7"
  fileLanguageSensor,    // right: "TypeScript"
  encodingSensor,        // right: "UTF-8"
]
```

Adding a sensor = adding one entry to the array.

### 12.2 Built-in sensors

| Sensor | Position | Content | When hidden |
|---|---|---|---|
| Git branch | Left | Current branch name | Git not initialized |
| File git status | Left | `●` changed / `?` untracked / nothing (clean) | No file open |
| Cursor position | Right | Ln N, Col N | No file open |
| File language | Right | Language name | No file open |
| File encoding | Right | UTF-8 / other | No file open |

**File git status detail:** no distinction between modified/renamed/staged — a single `●` indicator signals "this file differs from HEAD in any way". Untracked files (not known to git at all) show `?`. Clean files show nothing.

---

## 13. Git — Commit Dialog

Opened via the Commit button in the file tree toolbar.

The scope of git integration is intentionally narrow: **commit only**. AIDE is not a full git client — its git feature exists to create snapshots during vibe-coding sessions. For push, pull, merge, rebase, or anything else, use a dedicated git client.

### 13.1 Normal state

- Lists all changed files with checkboxes (all checked by default): modified tracked files, staged files, untracked new files, and **deleted files**. Deleted files are shown with a strikethrough or `[deleted]` label so the user can identify them.
- Text input for commit message
- Single **Commit** button
- On confirm: the Commit Dialog closes and a **Git Progress Dialog** opens (modal, blocks UI)

### 13.2 Git Progress Dialog

Shown during the commit operation. Blocks all UI interaction.

```
┌─────────────────────────────────┐
│  Committing...                  │
│  ─────────────────────────────  │
│  > git add src/App.tsx          │
│  > git commit -m "fix bug"      │
│  [master 3f2a1b4] fix bug       │
│   1 file changed, 3 insertions  │
│                                 │
└─────────────────────────────────┘
```

- Output is streamed in real time (mirrors the `Git` log channel)
- No close or cancel button — dialog closes automatically when the operation finishes
- On success: dialog closes silently; the file tree is automatically refreshed (git status re-read). In "Modified only" mode this will clear all indicators for the committed files — if no other changes remain, the tree shows *"No changes in project"*.
- On error: dialog closes and a toast notification appears with the full error message

### 13.3 Edge cases

| Situation | Behavior |
|---|---|
| No uncommitted changes | Dialog does **not open**; a toast notification appears: *"Nothing to commit — working tree clean"* |
| Git not initialized | Dialog does **not open**; toast: *"Git is not initialized. Run `git init` to get started."* |
| No files selected | Commit button disabled |
| Empty commit message | Commit button disabled |

---

## 14. Keyboard Shortcuts

Not implemented in v1. All user-triggerable actions are registered as named **commands** (command pattern), making hotkey binding a future add-on:

```typescript
const commands = {
  'editor.focusTerminal': () => focusPanel('terminal'),
  'editor.focusEditor':   () => focusPanel('editor'),
  'git.openCommitDialog': () => openCommitDialog(),
  // ...
}

// v2: key binding registry maps keys → command IDs
```

---

## 15. Launch — Project Picker

**Window sizes:**
- **Project Picker:** default 500×400 px, resizable, centered on screen
- **Session Picker:** default 500×400 px, resizable, centered on screen (or centered over the main AIDE window)
- Size and position of picker windows are not saved between sessions.

When launched without a directory context (via executable or Start Menu), shows a Project Picker:

```
┌─────────────────────────────────────┐
│  AIDE                               │
│                                     │
│  Recent Projects                    │
│  ───────────────────────────────    │
│  › E:\Projects\MyApp       2h ago   │
│  › E:\Projects\AIDE        1d ago   │
│  › C:\Work\backend         3d ago   │
│                                     │
│           [ Open Folder... ]        │
└─────────────────────────────────────┘
```

- Click recent project → validate path exists → open editor
- Path no longer exists → inline error, offer to remove from list
- "Open Folder..." → native folder picker
- Launch detection logic (in priority order):
  1. **CLI argument** — `aide.exe <path>` or `aide.exe .` → validate path exists → open specified path as project. If path does not exist: show error *"The specified path does not exist: `<path>`"* → then show Project Picker.
  2. **Service directory present** — if `process.cwd()` contains a `.aide/` subdirectory → recognized as a previously-opened AIDE project → open it directly
  3. **Neither** → show Project Picker

### 15.1 Auto-start on project open

See section 10.2 — session auto-start logic handles the `claude --resume` vs `claude` decision based on whether sessions exist in `~/.claude/projects/<encoded>/`.

---

## 16. Decisions Log

| Topic | Decision |
|---|---|
| Tabs | No tabs. Single file. Navigation via file tree. |
| File tree | Not collapsible — primary navigation tool. Fixed width from app config. |
| Terminal layout | Side by side with editor (both full height). |
| Status bar | Yes — sensor array architecture. |
| Theme | Monaco `vs-dark` theme used everywhere — editor and all UI chrome. No separate design system. |
| .gitignore | AIDE auto-adds `.aide` to project `.gitignore` on first open (creates file if missing). |
| Session picker | Separate native OS window. Closed via standard system [×] button. |
| Project picker | Separate Electron window. Opening a project closes picker, opens editor. Going to picker closes editor. |
| App config split | Static settings in `aide-config.json`; dynamic state (recent projects) in `aide-state.json`. Separate files so a write crash cannot corrupt hand-edited config. |
| Editor config | All Monaco settings (font, size, minimap, etc.) in `aide-config.json`. Restart to apply. |
| Toolbar running | Animated spinner on button while process is alive. |
| App close | If toolbar processes running: confirmation dialog before closing. Confirmed → kill all, close. |
| Hotkeys | Not in v1. Architecture supports them via command registry. |
| Launch | Project picker with recents + open folder dialog. |
| Single instance | Lock file (`.aide/lock`) per project directory. Multiple instances allowed across different projects. |
| Window state | Default size 1280×720. Size and position not saved between sessions. |
| Config reload | On restart only. Future: status bar sensor for "Restart to apply". |
| Hidden files | All dot-prefixed files and directories hidden in file tree. |
| Binary files | Opened as text in Monaco. Large files (> 5 MB) prompt before opening. |
| File conflict | Backup file created, user notified, manual merge required. Future: merge tool. |
| No-diff scenario | Diff always attempted. If no changes (untracked or identical to HEAD) → message shown with Open Editor / Cancel options. |
| Terminal after exit | PTY runs PowerShell; claude runs inside it. When claude exits, user returns to PS prompt — terminal remains interactive. |
| Session naming | Tabs show Claude Code slug (e.g. `swirling-stargazing-tome`). Placeholder "Claude Code" shown until slug is available — no timeout. |
| Session start | `claude --resume <id>` if sessions exist, `claude` if not. `claude -c` not used. |
| Session picker | Sorted by last modified date. Max shown configured in app config. |
| Log panel default | Collapsed to thin strip. Strip may be empty at startup — channels are on-demand. |
| Log panel height | Expanded height configured in app config. |
| Git scope | Commit only. No push, pull, merge, or rebase. Use a dedicated git client for those. |
| Git UI | Commit blocks UI. Progress shown in modal dialog with streamed output. No cancel. |
| Toolbar process | Each button bound to a background child_process. Re-click while running → Kill / Kill & Restart / Cancel dialog. |
| Terminal collapse | Always available. Terminal collapse state is preserved when editor closes. |
| PTY cwd | Always project root. |
| Auto-save | Triggered on focus loss or external file modification. On focus loss with no changes: does nothing. On external modification with no local changes: silent reload. On external modification with local changes: conflict dialog. |
| Panel resize | Instantaneous. Triggered by the panel that receives focus, not the one that loses it. |
| Toolbar overflow | Scroll buttons `[<]` `[>]` appear when buttons exceed toolbar width. |
| Config hot reload | Not supported. Restart required. |
| Toolbar layout | Main toolbar is full application width (below menu bar). File tree toolbar is a separate smaller strip below the main toolbar, scoped to the file tree column. |
| Log panel performance | Virtualized rendering (windowed list). Max 10 000 lines per channel (oldest dropped). ANSI codes stripped. |
| Log panel copy | Standard text selection + Ctrl+C. No custom button. |
| Git status display | Single uniform indicator for any changed file — no distinction between M/A/R/etc. Deleted files hidden from file tree, shown in commit dialog only. |
| File status sensor | `●` changed / `?` untracked / nothing (clean). No letter codes. |
| Commit: deleted files | Deleted files included in commit dialog with strikethrough or `[deleted]` label. |
| Post-commit refresh | File tree auto-refreshes after successful commit; git status re-read. |
| Project switch + running processes | Same "processes running" confirmation dialog shown immediately on Open Folder / Open Recent. |
| Terminal tab overflow | Tab strip scrolls horizontally. Single row, no wrapping. |
| Auto-save conflict suppression | All auto-save triggers ignored while conflict resolution dialog is open. |
| Picker window sizes | Project Picker and Session Picker: 500×400 px default, resizable, not persisted. |
