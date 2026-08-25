# Linux Migration Plan

Status: **Stages 1–3 implemented** (from-source launch + tool parity + Linux build config + polish). On-Linux smoke test and artifact test still owed (no Linux box in the implementing session).
Target: run AIDE on Linux (x64) in addition to Windows. macOS is out of scope for now, though the same platform-abstraction layer keeps the door open.

AIDE is Electron + React + TypeScript. Electron, React, Monaco, xterm.js, and Zustand are all cross-platform, so the renderer needs almost no work. Every real blocker lives in the **main process**, where the app shells out to `powershell.exe`, queries WMI (`Get-CimInstance Win32_Process`), and reads Windows-specific paths. The strategy is to funnel all of that through a small **platform abstraction layer** so the rest of the code stays platform-agnostic.

The work is split into three stages:

1. **Stage 1 — Minimal working launch.** The app starts on Linux, opens a project, the terminal spawns, a Claude Code session starts and is correctly bound to its tab, the editor and git work. Everything needed to actually use AIDE.
2. **Stage 2 — Important features.** The remaining CLI tools, install detection, session-owner resolution for every tool, and a proper Linux build artifact.
3. **Stage 3 — Final polish.** Toolbar defaults, updater, Unreal/Unity integrations, packaging niceties, CI.

---

## Platform abstraction layer (foundation for all stages)

Create `src/main/platform/` with a single module that the rest of the main process imports. This is the core of the migration — do it first, then the per-feature changes become thin.

Proposed surface (`src/main/platform/index.ts`):

```ts
export const isWindows = process.platform === 'win32'
export const isLinux = process.platform === 'linux'
export const isMac = process.platform === 'darwin'

/** Interactive login shell for the integrated terminal. */
export function defaultShell(): { file: string; args: string[] }
// win32 → { file: 'powershell.exe', args: [] }
// linux → { file: process.env.SHELL || '/bin/bash', args: ['-l'] }

/** Snapshot of all processes as {pid, ppid, name}. Backend differs per OS. */
export function listProcesses(): Promise<ProcInfo[]>
// win32 → Get-CimInstance Win32_Process (existing query)
// linux → read /proc/<pid>/stat + /proc/<pid>/comm  (no shell-out)

/** Resolve an executable on PATH (replaces `where` / PowerShell Get-Command). */
export function findExecutable(name: string): Promise<boolean>
// win32 → `where` + PowerShell alias/function check
// linux → `command -v` / access() over PATH with X_OK

/** Process start time in epoch ms, for lock-file staleness checks. */
export function processStartTimeMs(pid: number): Promise<number | null>
// win32 → PowerShell Get-Process StartTime
// linux → /proc/<pid>/stat field 22 (starttime) + btime from /proc/stat

/** Force-kill a process tree. */
export function killTree(pid: number): void
// win32 → taskkill /pid <pid> /f /t
// linux → kill process group (SIGTERM), or walk children via listProcesses()
```

Everything below references these helpers. The WMI process-tree walk (`resolveOwnerPid`) is duplicated across four CLI tools today — extract that shared logic into `platform/processTree.ts` so it consumes `listProcesses()` and each tool only supplies its process-name predicate (`claude*`, `codex*`, `agent*`, `opencode*`).

**As implemented (Stage 1) — two deviations from the surface above:**
- `processStartTimeMs(pid)` is **synchronous** (`number | null`, not a Promise). Its sole caller is lock validation on the synchronous project-open path; making it async would ripple through `openProjectAndTrack` and every caller. Both backends are cheap (one `execSync` on Windows, one `/proc` read on Linux).
- `killTree(pid)` is **not implemented yet** — no Stage 1 caller needs it (`toolbar/processManager.ts` already has its own win32/POSIX kill branch). Add it when a shared consumer appears.
- `platform/processTree.ts` exposes `resolveOwnerPidFromSnapshot(procs, candidatePids, namePredicate)`; Claude Code (§1.2) already consumes it, and the other three tools will in Stage 2 (§2.1).

---

## Stage 1 — Minimal working launch (from source) ✅ implemented

Landed: `src/main/platform/{index,processTree}.ts` (abstraction layer), shell spawn via `defaultShell()`, Claude Code `resolveOwnerPid` + all five tools' `isInstalled` via the platform layer, lock validation via `processStartTimeMs`, and `BUILDING-linux.md`. Verified to typecheck + build on Windows; on-Linux smoke test still owed (no Linux box in this session).

Goal: **run AIDE from source** on Linux via `npm run dev` (`electron-vite dev`) — no packaging, no installable artifact yet. Open a project, get a working terminal with a correctly-bound Claude Code session, edit files, use git. This is the smallest set that makes the app usable. Producing a distributable build is deferred to Stage 2.

### 1.1 Terminal shell — **hard blocker**
- **File:** `src/main/pty/ptyManager.ts:533`
- **Now:** `nodePty.spawn('powershell.exe', [], …)`
- **Change:** `const { file, args } = defaultShell(); nodePty.spawn(file, args, …)`
- Without this the terminal never starts.

### 1.2 Session-owner resolution for Claude Code — **hard blocker**
- **File:** `src/main/pty/cliTools/claudeCode.ts:517` (`resolveOwnerPid`)
- **Now:** shells out to `powershell.exe` → `Get-CimInstance Win32_Process` and walks ParentProcessId.
- **Change:** call `platform.listProcesses()` and reuse the shared tree walk. The ancestor-chain logic is already OS-agnostic; only the data source changes.
- Without this, new sessions are misassigned to tabs (or not bound at all), which breaks resume and titles.

### 1.3 Lock-file validation
- **File:** `src/main/lock.ts:69` (`getProcessStartTimeMs`)
- **Now:** PowerShell `Get-Process … StartTime`.
- **Change:** `platform.processStartTimeMs(pid)`. `isProcessRunning` (line 60) already uses `process.kill(pid, 0)` and is cross-platform.
- Impact if skipped: stale locks may be treated as live (or vice versa) → false "project already open" errors.

### 1.4 Install detection for **all** CLI tools — **hard blocker**
This is not optional or Claude-only: tool activation is hard-gated on `isInstalled`. In `src/main/ipc/index.ts:427` the `cli-tools:activate` handler does:
```ts
const installed = await tool.isInstalled()
if (!installed) return { ok: false, error: 'Not found in PATH' }
```
Every tool's `isInstalled` shells out to `where <bin>` + `powershell.exe … Get-Command`. On Linux `where` does not exist (execFile errors → `false`) and the PowerShell fallback also fails → **`isInstalled` returns false for every tool → nothing can be activated → no CLI can run at all**, including Claude Code. So install detection for the whole tool set must land in Stage 1.

- **Change:** route every `isInstalled` through `platform.findExecutable(<bin>)` (`command -v` / PATH+X_OK on Linux).
- **Files:**
  - `src/main/pty/cliTools/claudeCode.ts:173` (`claude`)
  - `src/main/pty/cliTools/codex.ts:~275` (`codex`)
  - `src/main/pty/cliTools/cursorAgent.ts:~482` (`agent`)
  - `src/main/pty/cliTools/openCode.ts:~108` (`opencode`)
  - `src/main/pty/cliTools/qwenCode.ts:~217` (`qwen`)
- Once `platform.findExecutable` exists this is a one-line swap per tool.
- **Note:** activating a non-Claude tool in Stage 1 lets it spawn, but *automatic session binding* for those tools depends on their `resolveOwnerPid`, which is fixed in Stage 2 (§2.1). Claude Code — the Stage 1 target — gets both here (§1.2 + §1.4).

### 1.5 Native modules rebuild (still needed for `dev`)
- `node-pty` and `better-sqlite3` are native and must match Electron's ABI — this is required **even to run from source**, not just for packaging. After `npm install` on Linux, run `npm run rebuild` (already wired: `electron-rebuild -f -w node-pty,better-sqlite3`). Needs `build-essential`, `python3`, and Electron's headers on the machine. Capture these prerequisites in a short `BUILDING-linux.md`.

### 1.6 Sanity checks that should already pass
- `src/main/index.ts:64` already guards with `process.platform !== 'darwin'` — verify the Linux path is correct (window-all-closed behavior).
- `src/main/toolbar/processManager.ts:38` already has a POSIX branch (`SIGTERM`). Confirm it's reached for terminated toolbar processes.
- File watcher, git runner, Monaco, xterm — no platform code; smoke-test only.

### Stage 1 exit criteria
- `npm run dev` boots the app on Linux (no packaging required).
- Project Picker → open folder → editor opens.
- Every installed CLI tool can be **activated** (the `isInstalled` gate passes for tools present on PATH).
- Terminal spawns `bash`; `claude` starts, banner detected, session bound to the tab.
- Resume an existing session works; titles update.
- Open/edit/save a file; git status indicators appear; diff view works.

---

## Stage 2 — Important features ✅ implemented

Landed: codex/cursorAgent/openCode `resolveOwnerPid` now route through `platform/processTree.ts` (`qwenCode` has no owner resolution, so nothing to port); `cursorAgent` config path gained macOS + Linux (XDG `~/.config/Cursor`) branches; `electron-builder.yml` gained a `linux` target (AppImage + deb, x64) plus `asarUnpack` for the native `.node` modules, and `package.json` gained `pack:linux`. Typechecks + builds on Windows; producing/launching the actual AppImage on Linux is still owed.

Goal: the other CLI tools work at parity, and there is a real installable Linux artifact.

### 2.1 Remaining CLI tools' `resolveOwnerPid`
Install detection for these tools already landed in Stage 1 (§1.4). What remains is automatic session binding — each still resolves the owning PID via `powershell.exe` + WMI:
- `src/main/pty/cliTools/codex.ts` (`resolveOwnerPid` ~411)
- `src/main/pty/cliTools/cursorAgent.ts` (`resolveOwnerPid` ~562)
- `src/main/pty/cliTools/openCode.ts` (`resolveOwnerPid` ~223)
- `src/main/pty/cliTools/qwenCode.ts` (`resolveOwnerPid`, if present)

Once `platform/processTree.ts` exists, each becomes a few lines (supply the process-name predicate). Until this ships, these tools launch on Linux but their sessions may not auto-bind to the tab.

### 2.2 Tool config paths
Audit per-tool home directories — most already use `homedir()` and XDG-friendly paths, which work on Linux as-is:
- `claudeCode.ts` → `~/.claude.json`, `~/.claude/` ✓ cross-platform
- `codex.ts` → `~/.codex` ✓
- `openCode.ts` → `~/.config/opencode`, `~/.local/share/opencode` ✓ (already XDG)
- `qwenCode.ts` → `~/.qwen` ✓
- **`cursorAgent.ts:129-130`** → uses `process.env.APPDATA` with a Windows fallback (`AppData/Roaming/Cursor`). **Needs a Linux branch** (`~/.config/Cursor` or XDG). This is the only tool with a hard Windows path.

### 2.3 Linux build target — **blocker for distribution** ✅
- **Was:** `electron-builder.yml` existed but had only a `win` (7z) target. (Earlier note said no config file existed — that was wrong.)
- **Done:** added a `linux` target (`AppImage` + `deb`, x64) with `category: Development`, `icon: app_icon.png` (388×388 — electron-builder may warn; a 512² set is a Stage 3 nicety), `maintainer`; added `asarUnpack` for `**/*.node` + `node-pty`/`better-sqlite3`; added `pack:linux` script.
- **Owed:** run `npm run pack:linux` on Linux and confirm the AppImage launches with a working terminal + sqlite.

### 2.4 CLI launch ergonomics
- Confirm `aide .` / cwd-with-`.aide/` detection (Stage 1 startup options) resolves paths correctly with Linux separators. Path handling uses `path.join`, so this is mostly verification, but test symlinked and relative project paths.

### Stage 2 exit criteria
- Codex, Cursor Agent, OpenCode, Qwen: install-detected, sessions bound, resume works.
- `npm run pack:linux` produces a launchable AppImage (and/or `.deb`) with working terminal + sqlite.

---

## Stage 3 — Final polish ✅ implemented

Goal: remove the remaining Windows-isms and make Linux a first-class, maintainable target.

### 3.1 Default toolbar ✅
- **File:** `src/main/config/toolbarConfig.ts`
- **Done:** added `openFolderCommand()` — `explorer.exe .` (Windows) / `open .` (macOS) / `xdg-open .` (Linux) — used by both the default toolbar and the `general` preset (the two former `explorer.exe .` entries; tooltip now "Open project in file manager"). Unreal/Unity presets are kept Windows-only: `detectProjectType` skips `.uproject`/Unity detection off Windows, and a new `getAvailablePresetGroups()` filters the `unreal`/`unity` groups out of `toolbar:get-presets` on non-Windows. The `cmd /c … start` VS/Unity commands live only inside those now-hidden groups, so no separate branch was needed.

### 3.2 Updater ✅
- **File:** `src/main/updater/updater.ts`
- **Outcome:** no code change needed. The updater is notify-only — it parses the releases page for newer version strings and (elsewhere) opens that page; it constructs no artifact URL and auto-installs nothing, so it is already OS-agnostic. The releases page hosts both the Windows `.7z` and the Linux AppImage/deb.
- **Done:** the hardcoded help prompt at `src/main/ipc/index.ts:1217` now uses `osDisplayName()` (new platform helper) instead of the literal "Windows 11".

### 3.3 Unreal / Unity integrations ✅
- **File:** `src/main/unreal/engineFinder.ts` — both `findUnrealEngineDir` and `findUnrealVersionSelector` now early-return `null` when `!isWindows`, so the registry `reg query` never runs off Windows and callers soft-fail.

### 3.4 Packaging & CI ✅ (with a deviation)
- **Done:** `BUILDING-linux.md` expanded with a Packaging section (`npm run pack:linux` → AppImage + deb in `release/`) and a Platform-behavior notes section; the stale "Stage 1/2 limitations" were replaced.
- **Deviation — no GitHub Actions matrix:** the repo is hosted on **gitverse.ru**, not GitHub, so a `.github/workflows` file would never run. Instead the cross-platform validation steps (`npm ci` → `rebuild` → `typecheck` → `build` → `pack`/`pack:linux`) are documented in `BUILDING-linux.md`, to be mirrored into a gitverse pipeline if/when one is configured.
- **Icon:** left as `app_icon.png` (388×388); electron-builder upscales to Linux desktop sizes with minor quality loss. A ≥512² replacement is noted as a future nicety in `BUILDING-linux.md`. Desktop-entry/MIME association not added (AppImage runs standalone).

### Stage 3 exit criteria
- ✅ Toolbar works out-of-the-box on Linux (open folder via `xdg-open`).
- ✅ Update flow is coherent on Linux (notify-only, no dead Windows-only buttons).
- ✅ Windows-only features (Unreal/Unity) hidden and gracefully unavailable.
- ⚠️ CI: documented manual matrix instead of an automated one (host is gitverse.ru, not GitHub).

---

## File change summary

| File | Line(s) | Issue | Stage |
|------|---------|-------|-------|
| `src/main/platform/*` | — | **New** abstraction layer | Foundation |
| `src/main/pty/ptyManager.ts` | 533 | Hardcoded `powershell.exe` shell | 1 |
| `src/main/pty/cliTools/claudeCode.ts` | 517 | `resolveOwnerPid` via WMI | 1 |
| `src/main/ipc/index.ts` | 427 | Activation gate — `isInstalled` must work on Linux | 1 |
| `src/main/pty/cliTools/claudeCode.ts` | 173 | `isInstalled` via `where`/PowerShell | 1 |
| `src/main/pty/cliTools/codex.ts` | ~275 | `isInstalled` via `where`/PowerShell | 1 |
| `src/main/pty/cliTools/cursorAgent.ts` | ~482 | `isInstalled` via `where`/PowerShell | 1 |
| `src/main/pty/cliTools/openCode.ts` | ~108 | `isInstalled` via `where`/PowerShell | 1 |
| `src/main/pty/cliTools/qwenCode.ts` | ~217 | `isInstalled` via `where`/PowerShell | 1 |
| `src/main/lock.ts` | 69 | `getProcessStartTimeMs` via PowerShell | 1 |
| `package.json` | 14 | `rebuild` native modules (needed for dev) | 1 |
| `src/main/pty/cliTools/codex.ts` | ~411 | `resolveOwnerPid` via WMI | 2 |
| `src/main/pty/cliTools/cursorAgent.ts` | ~562, 129 | `resolveOwnerPid` + `APPDATA` path | 2 |
| `src/main/pty/cliTools/openCode.ts` | ~223 | `resolveOwnerPid` via WMI | 2 |
| `src/main/pty/cliTools/qwenCode.ts` | ~(owner) | `resolveOwnerPid` via WMI (if present) | 2 |
| `package.json` / `electron-builder.yml` | 11 | Linux build target | 2 |
| `src/main/config/toolbarConfig.ts` | 50,68,148,160,171,202 | Windows-only commands | 3 |
| `src/main/updater/updater.ts` | — | Windows-oriented update flow | 3 |
| `src/main/ipc/index.ts` | 1217 | "Windows 11" in help prompt | 3 |
| `src/main/unreal/engineFinder.ts` | — | Windows registry read | 3 |

## What does NOT need changes
- Renderer (`src/renderer/`) — React/Monaco/xterm/Zustand are cross-platform.
- File watcher, git status runner — use Node fs + `git`, no platform code.
- `src/main/toolbar/processManager.ts:38` — already has a POSIX (`SIGTERM`) branch.
- `src/main/index.ts:64` — already platform-guarded.
- All `homedir()`-based tool paths except `cursorAgent.ts` (see 2.2).

## Risks & unknowns
- **node-pty on Wayland/tty edge cases** — generally solid on Linux, but verify resize and OSC-title parsing (title-based session detection in `claudeCode.ts:584` relies on OSC sequences the CLI emits identically on Linux — likely fine, confirm).
- **/proc parsing** — process names in `/proc/<pid>/comm` are truncated to 15 chars; use `/proc/<pid>/cmdline` if a full name/predicate match is needed for `claude`/`opencode`.
- **AppImage + native modules** — ensure `.node` files are unpacked from asar and the AppImage bundles the right glibc baseline.

## Suggested effort
- Stage 1: ~2–3 days (abstraction layer + shell + Claude `resolveOwnerPid` + lock + `isInstalled` for all 5 tools + native rebuild + smoke test).
- Stage 2: ~2–3 days (four tools' `resolveOwnerPid`, `cursorAgent` path, build config, artifact testing).
- Stage 3: ~2–3 days (toolbar, updater, integrations, CI, packaging).
