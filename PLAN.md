# AIDE — Implementation Plan

Each stage is a self-contained logical block. Completion means: Claude tests pass → user confirms → STAGES.md updated → committed → context reset.

---

## Stage 1 — Scaffold + Config + Lock

### What we build
- electron-vite project with React + TypeScript + Zustand
- App-level config read/write (Electron `userData`)
- Project-level config: `.aide/` directory auto-created on project open, `aide/` read if present
- `.gitignore` auto-management (append `.aide` if missing, create if absent)
- Lock file: `.aide/lock` — write PID on open, validate on startup, delete on clean exit
- Two Electron windows defined (Picker, Editor) but only Picker shown at this stage
- Project open call: validates path, writes lock, opens Editor window, closes Picker

### How Claude tests
- `tsc --noEmit` — zero type errors
- `npm run build` — build succeeds
- Start app, verify no unhandled errors in main process log
- Verify `.aide/` directory and `lock` file are created in the target project directory
- Verify `.gitignore` is updated (or created) with `.aide` entry
- Start a second app instance pointing to the same directory — verify it exits without opening a window

### How the user tests
1. Launch the app — Picker window appears
2. Click "Open Folder", select any project directory
3. Confirm `.aide/` folder was created in that project directory
4. Confirm `.gitignore` now contains `.aide`
5. Launch a second AIDE instance pointing to the same folder — confirm error message, no second window opens
6. Close the app — confirm `.aide/lock` is deleted

---

## Stage 2 — Project Picker

### What we build
- Picker window UI: recent projects list with timestamps, "Open Folder…" button
- Recent projects stored in app-level config (`recentProjects[]`)
- Click recent project → validate path exists → open editor; path missing → inline error + offer to remove
- "Open Folder…" → native folder picker → open editor
- Launch detection logic (in priority order):
  1. CLI argument (`aide.exe <path>` or `aide.exe .`) → validate → open or show error + Picker
  2. `process.cwd()` has `.aide/` subdirectory → open directly
  3. Neither → show Picker
- Editor window: shows project path in title bar (`AIDE — <folder name>`), otherwise empty (no layout yet)
- Picker ↔ Editor transitions: opening a project closes Picker, any project-switch from Editor closes Editor and opens new Picker

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Launch with `aide.exe .` from a directory with `.aide/` — verify editor opens directly
- Launch with `aide.exe /nonexistent` — verify error message shown, then Picker
- Verify recent projects list persists across restarts (read userData file)

### How the user tests
1. Launch from Start Menu / exe — Picker appears
2. "Open Folder" → select directory → Editor opens, Picker closes, title bar shows folder name
3. Close Editor, reopen app — recent project appears in list
4. Click the recent project — Editor opens directly
5. Delete the project folder, click it in recents — inline error shown, offer to remove from list
6. Launch from CLI: `aide.exe .` in a project directory — opens directly (no Picker)
7. Drag another folder into "Open Folder" — opens as new instance, previous Editor closes

---

## Stage 3 — Layout + Panel System

### What we build
- Full layout skeleton: main toolbar row (empty), file tree column, editor area, terminal area, log strip, status bar
- File tree toolbar row (empty strip inside file tree column, below main toolbar)
- Zustand `usePanelStore`: `activePanelRatio`, `collapsedWidthPx`, terminal state (active/inactive/collapsed), editor visibility
- Panel sizing behavior:
  - Editor visible + terminal not collapsed → 75/25 split; active side takes 75%
  - Editor hidden → terminal takes full width
  - Terminal collapsed → 20px strip with vertical "Claude Code" label; click to restore
  - Focus on editor → editor becomes active (75%), terminal inactive (25%); and vice versa
- Collapse button in terminal header → collapses to strip; strip click → restores
- Panel resize is instantaneous, no animation
- Panel ratios read from `.aide/settings.json`; file tree width from userData
- Placeholder content in each panel (colored box with label is sufficient)

### How Claude tests
- `tsc --noEmit`, `npm run build`
- App launches, no console errors
- Verify panel store initializes with correct defaults
- Verify `.aide/settings.json` is read if present

### How the user tests
1. App opens — terminal takes full width (no editor visible)
2. Manually trigger "show editor" (dev action or temp button) — editor appears at 75%, terminal at 25%
3. Click in editor area → editor stays at 75%
4. Click in terminal area → terminal expands to 75%, editor shrinks to 25%
5. Click collapse button → terminal shrinks to 20px strip with vertical label
6. Click the strip → terminal restores
7. Close editor (temp button) → terminal expands to full width, stays collapsed if it was
8. Resize window — panels scale proportionally

---

## Stage 4 — File Tree

### What we build
- Read and display project directory structure
- Filtering: all dot-prefixed names hidden (files and directories)
- Directories: expand/collapse on click, sorted before files, alphabetical within group
- Files: sorted alphabetically, single click opens file (editor panel shows placeholder "file opened: path")
- Git status: run `git status --porcelain`, mark changed files with a uniform `●` indicator; deleted files not shown in tree
- "Modified only" toggle: show only changed files with their directory hierarchy; if no changes → *"No changes in project"*; if git unavailable → *"Git is not available"*
- File tree toolbar: Refresh button, Modified only toggle button, Commit button (no-op placeholder)
- Right-click context menu on files: "View Diff" (no-op placeholder)
- Filesystem watcher: file created → add to tree; file deleted → remove from tree (and close editor if that file is open — placeholder behavior); directory created/deleted → update tree
- Watcher respects dot-prefix filter

### How Claude tests
- `tsc --noEmit`, `npm run build`
- App launches with a real project directory, tree populates
- Verify dot-prefixed entries are absent from the tree
- Verify git-changed files show `●` indicator
- Verify "Modified only" mode filters correctly

### How the user tests
1. Open a real project — file tree shows structure, no dot files/folders
2. Expand/collapse directories by clicking
3. Make a change to a file externally — `●` appears on that file
4. Toggle "Modified only" — only changed files visible, directory structure preserved
5. Create a new file externally — appears in tree; delete it — disappears
6. Click Refresh — tree updates manually
7. Click a file — placeholder confirms which file was selected

---

## Stage 5 — Terminal + Sessions

### What we build
- xterm.js terminal connected to node-pty (PowerShell)
- PTY working directory always set to project root
- Auto-start on project open:
  - Scan `~/.claude/projects/<encoded>/` for `.jsonl` files
  - If found: take newest by mtime → `claude --resume <sessionId>` in PTY
  - If none: send `claude` to PTY; watch directory for new `.jsonl` → register sessionId
- Session tab system:
  - Tab labeled with Claude Code slug (read from JSONL); placeholder "Claude Code" until slug appears
  - JSONL file watched for changes → update tab label when slug appears
  - Multiple tabs, each an independent PTY + xterm.js
  - Tab strip scrolls horizontally on overflow
- `[ + ]` button opens Session Picker window (separate OS window, 500×400, resizable)
- Session Picker: sessions sorted by mtime, max from app config, `●` for already-open sessions, "New session" button
- Selecting open session → switch to that tab; selecting closed session → spawn `claude --resume`, open new tab; New session → `claude`, open new tab
- Selecting session or New session closes Picker window
- `[ collapse ]` button → 20px strip; click strip → restore
- Fit addon: PTY resizes when panel resizes
- If PowerShell not found: display launch error in terminal area

### How Claude tests
- `tsc --noEmit`, `npm run build`
- App launches, terminal panel renders xterm.js
- node-pty spawns PowerShell (verify process exists in task manager via PID)
- JSONL scanning finds existing sessions (verify by logging)

### How the user tests
1. Open a project — terminal opens, `claude --resume <id>` or `claude` runs automatically
2. Interact with Claude — confirm full ANSI rendering (colors, cursor movement)
3. Exit Claude (type `exit`) — PowerShell prompt appears, terminal remains interactive
4. Click `[ + ]` → Session Picker opens; existing sessions listed with dates
5. Click a past session → new tab opens, `claude --resume` runs
6. Click "New session" → new tab, new `claude` session
7. Multiple tabs: all run simultaneously; switching tabs works
8. Resize panel → terminal content reflows correctly
9. Collapse terminal → strip shown; restore → terminal intact

---

## Stage 6 — Code Editor + Diff View

### What we build
- Monaco Editor instance (single file, no tabs)
- File open: clicking file in tree loads it into Monaco; `useEditorStore` updated
- Editor panel header: relative path, `[Diff]` / `[Edit]` toggle, `[×]` close button
- Close button: closes file, hides editor panel
- Auto-save:
  - Focus loss → write to disk if content changed; do nothing if unchanged
  - External modification detected (watcher) + no local changes → silent reload
  - External modification + local changes → conflict dialog
- Conflict dialog: Reload / Keep mine / Backup & Open; event suppression while dialog open
- Large file: if > `maxFileSizeMb` → confirmation dialog before opening
- Diff view: Monaco DiffEditor; `git show HEAD:<path>` vs current disk content
- No-diff dialog: file identical to HEAD → *"File has not changed since last commit."*; untracked → *"File is not tracked by git — there is no diff to show."*
  - From file tree context menu: `[ Open Editor ]` `[ Cancel ]`
  - From `[Diff]` button: `[ OK ]` only
- `[Diff]` / `[Edit]` toggle switches between MonacoEditor and MonacoDiffEditor in same panel
- `[×]` always closes the file (both views)
- Monaco options from app config: font, size, minimap, wordWrap, lineNumbers, tabSize
- Theme: `vs-dark`

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Open a file → Monaco renders content
- Verify `git show HEAD:<path>` produces correct output for diff
- Verify auto-save writes to disk (check file mtime after focus loss)

### How the user tests
1. Click a file in tree → opens in Monaco with syntax highlighting
2. Edit content, click terminal → file saved (verify in OS file manager or another editor)
3. Modify the file externally while AIDE is open → conflict dialog appears
4. Choose "Reload" → editor shows new content; "Keep mine" → disk overwritten; "Backup & Open" → backup file created
5. Click `[Diff]` → diff view opens (HEAD vs current); read-only; colors correct
6. Click `[Edit]` → back to editor
7. Click `[×]` → editor hidden, terminal expands
8. Right-click unchanged file → "View Diff" → no-diff dialog with "Open Editor"/"Cancel"
9. Open a file > 5 MB → large file confirmation dialog

---

## Stage 7 — Log Panel

### What we build
- `LogManager` singleton: `createChannel`, `append`, `clear`, unregister
- Log panel UI: horizontally tabbed, collapsed by default (thin strip with `[∧]`)
- Expand: click tab label or `[∧]`; collapse: click `[∨]`
- Channel tabs: on-demand (created on first append, not at startup)
- Virtualized rendering (`react-window` or equivalent) — only visible rows in DOM
- Buffer cap: 10 000 lines per channel; oldest dropped when exceeded; prepend *"[Older output truncated]"*
- ANSI codes: stripped before display
- Text selection enabled; `Ctrl+C` copies selected text
- Attention system: `attention: true` channel → blink tab label until clicked; panel does NOT auto-expand; keyboard focus not stolen
- Tab context menu (right-click): Clear (empties content, tab stays), Close (removes tab; re-created on next append)
- Empty panel (no tabs): blank area shown
- `Git` channel: created by git operations, `attention: false`

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Programmatically append 15 000 lines to a channel — verify DOM row count stays bounded (inspect via DevTools)
- Trigger attention on a channel — verify tab blinks, panel stays collapsed

### How the user tests
1. Run a git operation (Refresh in file tree) — Git channel appears, panel stays collapsed
2. Manually trigger an attention channel (temp dev action) — tab blinks, panel stays collapsed
3. Click blinking tab — blink stops
4. Right-click tab → Clear → content gone, tab stays
5. Right-click tab → Close → tab disappears
6. Run next git operation → Git tab re-appears
7. Append 10 000+ lines (dev action) — no UI lag; truncation notice appears

---

## Stage 8 — Status Bar

### What we build
- Sensor array architecture: each sensor has `id`, `position`, `render()`, optional `onClick`, optional `refreshInterval`
- 5 built-in sensors:
  - **Git branch** (left): current branch name; hidden if git not initialized
  - **File git status** (left): `●` changed / `?` untracked / nothing (clean); hidden if no file open
  - **Cursor position** (right): `Ln N, Col N`; hidden if no file open
  - **File language** (right): Monaco language detection; hidden if no file open
  - **File encoding** (right): UTF-8 or detected encoding; hidden if no file open
- Sensors update reactively (Monaco cursor event, editor store changes)
- Git branch polls or updates on file tree refresh

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Open a file in a git repo — verify all 5 sensors render
- Open with no file — verify file-dependent sensors hidden

### How the user tests
1. Open a project with git — branch name shown in status bar
2. Open a file — cursor position, language, encoding appear
3. Move cursor — Ln/Col updates
4. Edit file — `●` appears in file status
5. Close file — file sensors disappear
6. Open a non-git directory — branch sensor hidden

---

## Stage 9 — Main Toolbar

### What we build
- Load `aide/toolbar.json` and `.aide/toolbar.json`; merge (local wins on same `id`)
- Render buttons: emoji icon or image file path; tooltip on hover; no text labels
- Button process lifecycle:
  - Click with no process running → `child_process.spawn(command, { cwd })`; stdout/stderr → configured log channels
  - Click with process running → Kill / Kill & Restart / Cancel dialog
  - Process exits → button returns to normal state
- Animated spinner overlay while process alive
- Overflow: `[<]` `[>]` scroll buttons when buttons exceed toolbar width
- Running processes check:
  - App close with processes running → confirmation dialog (Yes/No)
  - Open Folder / Open Recent with processes running → same dialog
- `${projectRoot}` variable resolved in `cwd` field
- Icon system: emoji rendered as text; file path loaded as `<img>`

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Load a sample `aide/toolbar.json` — buttons render
- Click a button → verify child process spawned (PID exists)
- Verify log channel receives output

### How the user tests
1. Create `aide/toolbar.json` with a build button (e.g. `echo hello`)
2. Button appears in toolbar with correct icon and tooltip
3. Click button → process runs, output appears in configured log channel
4. Spinner animates while running
5. Click again while running → Kill/Kill & Restart/Cancel dialog
6. Choose Kill & Restart → old process killed, new one starts
7. Create `.aide/toolbar.json` with same button `id` but different command → local version wins
8. Add enough buttons to overflow → scroll buttons appear; scroll works
9. Close app with running process → confirmation dialog

---

## Stage 10 — Commit Dialog

### What we build
- Commit button in file tree toolbar → opens Commit Dialog
- Edge cases checked before opening:
  - No git → toast: *"Git is not initialized. Run `git init` to get started."*
  - No changes → toast: *"Nothing to commit — working tree clean"*
- Commit Dialog:
  - List all changed files (modified, staged, untracked, **deleted** with strikethrough / `[deleted]` label)
  - All checked by default; unchecking excludes from commit
  - Text input for commit message
  - Commit button disabled if no files selected or message empty
  - Confirm → dialog closes, Git Progress Dialog opens
- Git Progress Dialog (modal, blocks UI):
  - Streams git command output in real time
  - No close/cancel button
  - Mirrors output to `Git` log channel
  - On success: closes silently; file tree auto-refreshes (git status re-read); in "Modified only" mode tree updates accordingly
  - On error: closes, toast with full error message

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Run against a real git repo with staged/unstaged/untracked/deleted files
- Verify all categories appear in dialog
- Verify commit produces a real git commit (check `git log` after)

### How the user tests
1. Make changes (modify, create, delete files); click Commit
2. All changed files appear with checkboxes; deleted files shown with `[deleted]`
3. Uncheck some files → Commit button stays enabled; those files excluded
4. Clear message → Commit button disables
5. Commit → Progress Dialog streams output, closes on success
6. File tree refreshes; changed indicators gone for committed files
7. In "Modified only" mode: committed files disappear from tree
8. Test with no git (`git init` not run) → toast message
9. Test with no changes → toast message

---

## Stage 11 — Menu Bar + Command Registry

### What we build
- Command registry: named commands map to functions; all app actions registered
- Native menu via `Menu.setApplicationMenu`:
  - **File:** New Window, Open Folder…, Open Recent (submenu), separator, Exit
  - **Edit:** Undo, Redo, separator, Cut, Copy, Paste
- New Window → new AIDE instance with no project pre-selected (Picker)
- Open Folder / Open Recent → running-processes check → project switch
- Edit commands: enabled only when Monaco editor has focus; wired to Monaco API
- Undo/Redo: `editor.trigger('keyboard', 'undo'/'redo', null)`
- Open Recent submenu populated from `recentProjects` in app config

### How Claude tests
- `tsc --noEmit`, `npm run build`
- Verify menu renders (no crash on startup)
- Verify command registry has all expected keys

### How the user tests
1. File → New Window → new Picker window opens, current unchanged
2. File → Open Folder → folder picker; project switch (running-processes check if needed)
3. File → Open Recent → submenu shows recent projects; click one → project switch
4. Open a file, click in editor, Edit → Undo/Redo/Cut/Copy/Paste — all work
5. Click in terminal, open Edit menu → all Edit items greyed out
6. File → Exit → app closes (running-processes check if needed)

---

## Process per stage

1. Implement the stage
2. Claude runs automated checks (build, type check, file system assertions) — **fix all failures before proceeding**
3. User runs manual test steps listed above
4. **Wait for user to confirm pass.** If issues found → fix and retest from step 2
5. Only after user confirms pass: Claude writes a brief completion note to `STAGES.md`
6. Only after user confirms pass: Commit everything
7. Reset context (start a new conversation referencing PLAN.md + STAGES.md)
