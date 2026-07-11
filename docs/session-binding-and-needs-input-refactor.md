# Refactor: deterministic session binding via Claude Code hooks

> Status: **Part 1 (session binding) is spec-ready and approved for implementation.**
> Part 2 (needs-input) is gathered knowledge for later — see the explicit scope
> note. All hook behaviour below is **verified empirically against Claude Code
> CLI 2.1.206** (real payloads captured, not inferred from docs).

This repairs real bugs on its own merits (thinking panel, session picker, anything
reading "the current transcript of a tab"). It also unblocks the Linux port: the
current binding relies on a Windows-only PowerShell process-tree query that cannot
be ported.

---

## Verified facts (CLI 2.1.206)

Captured by installing logging hooks via `--settings` and running claude both
headless (`-p`) and interactively (driven through a real PTY). See
[Test harness](#test-harness) to reproduce.

### Every hook carries the binding fact

Every hook receives on **stdin** a JSON object that always includes:

- `session_id`
- `transcript_path` — absolute path, e.g.
  `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`. The directory encoding
  matches AIDE's existing `encodeProjectPath()` (`E:\Projects\X` → `E--Projects-X`).
- `cwd`
- `hook_event_name`
- (most events also carry `permission_mode`, `effort`, `prompt_id`)

**This is the entire foundation of Part 1: the binding is handed to us, on every
event, as a verified fact. Nothing is inferred.**

### Command hooks fire in both modes

Command hooks execute in **headless `-p`** *and* **interactive** sessions. (The
`--include-hook-events` output stream, by contrast, emits nothing in headless —
irrelevant to us; we use command hooks.)

### `--settings` merges, never replaces

`claude --settings <file-or-json>` exists in 2.1.206. Help text: "load
**additional** settings from". Verified: with a hook in the project's
`.claude/settings.json` **and** a different hook passed via `--settings`, **both
fire for the same session**. So AIDE can inject its hooks via `--settings`
**without touching the user's repository**, and the user's own project hooks keep
working. It accepts either a file path or an inline JSON string.

### Lifecycle transitions and how `transcript_path` behaves

| Trigger | Events fired | session_id / transcript_path |
|---|---|---|
| startup | `SessionStart{source:"startup", model}` | initial |
| a turn | `UserPromptSubmit` → `PreToolUse` → `PostToolUse` → `Stop` | unchanged; **current path on every event** |
| `/compact` | `PreCompact{trigger:"manual"}` → `SessionStart{source:"compact"}` | **same** id, **same** path (no rebind needed) |
| `/clear` | `SessionStart{source:"clear"}` | **new** id, **new** path |
| `/branch` | `SessionEnd{reason:"resume"}` (old) → `SessionStart{source:"resume", session_title:"…(Branch)"}` (new) | **new** id, **new** path |
| `/exit` | `SessionEnd{reason:"prompt_input_exit"}` | — |

`SessionStart.source` observed: `startup`, `resume`, `clear`, `compact`.
`SessionEnd.reason` observed: `resume`, `prompt_input_exit`.

**The open question "does `/branch` fire a hook?" is answered: yes.** It emits
`SessionEnd(resume)` + `SessionStart(resume)` with the new transcript path. So the
discipline **"always trust `transcript_path` from the current payload, never
cache"** covers every transition — startup, clear, compact, branch, resume — with
no exceptions. `/compact` is a no-op for binding (path is stable).

`Stop` additionally carries `last_assistant_message` (the full final text), so a
content consumer can read the answer straight from the payload without opening the
JSONL.

---

## Part 1 — Deterministic tab ↔ session binding

### Today (the heuristic being removed)

There is no direct link between a PTY tab and its Claude Code session. AIDE
reconstructs it from indirect signals:

1. `watchForNewSessions()` watches `~/.claude/projects/<encoded>/` for a new
   `*.jsonl` file (mtime-ordered, 300 ms write-settle delay, directory polling).
2. `resolveOwnerPid()` runs a PowerShell `Get-CimInstance Win32_Process` query,
   builds the full parent/child PID map, walks `claude*` ancestry to a candidate
   PTY PID, and on ambiguity **picks the highest PID**.
3. `ThinkingWatcher` binds `tabId → filePath` from that guess and tails the file.

Failure modes: mid-session id changes (`/branch`, `/clear`, `--resume`,
compaction) leave the tab bound to a dead file; mtime/PID races; ambiguity under
concurrency; and it is slow and Windows-only.

**Root cause: AIDE infers the binding instead of being told it.** Hooks tell it.

### Target architecture

```
spawnPty(tabId)                claude (interactive PTY)             AIDE
  env += AIDE_TAB=<tabId>   ── inherits env ──> lifecycle hook ── POST ──> hook endpoint
         AIDE_HOOK_PORT                          (bundled helper:          (127.0.0.1:PORT/hook)
         AIDE_HOOK_TOKEN                           env + stdin JSON)          validate token
                                                                             update Map<tabId, path>
newSessionCommand()/resumeCommand()                                              │
  append: --settings <static-hooks-file>                          startWatching(tabId, sid, path)
                                                                    (ThinkingWatcher re-binds)
```

### Components & confirmed injection points

1. **Per-tab env injection** — in `PtyManager.spawnPty(tabId, tool)`
   (`ptyManager.ts`, where `env` is assembled and `getEnvOverrides()` is merged).
   `tabId` is in scope here. Inject:
   - `AIDE_TAB=<tabId>`
   - `AIDE_HOOK_PORT=<port>` (the hook server's port)
   - `AIDE_HOOK_TOKEN=<random-per-app-launch>`

   claude inherits this env (same mechanism the proxy vars already use). The hook
   config itself is **static and shared**; all per-tab routing is via these env
   vars. `getEnvOverrides()` keeps its current job (proxy) — the hook vars are
   set directly in `spawnPty` because they need `tabId`.

2. **Hook installation via `--settings`** — append `--settings <file>` to the
   command strings built in `claudeCode.ts` `newSessionCommand()` /
   `resumeCommand()` (these are written to the PTY stdin). Use a **static settings
   file** (written once to app data / temp), not inline JSON, to avoid PowerShell
   command-line quoting. The file's hooks invoke the bundled helper by absolute
   path. Repo untouched; user's project hooks preserved (merge verified).

3. **The helper** — a small **bundled Node script** (Node ships with Electron;
   absolute path is under our control, so PATH is a non-issue and it is
   cross-platform for the Linux port). Reads `AIDE_TAB`/`AIDE_HOOK_PORT`/
   `AIDE_HOOK_TOKEN` from env and the hook JSON from stdin, then fire-and-forget
   POSTs `{ tabId, event, session_id, transcript_path, token }` to
   `127.0.0.1:<port>/hook`. Must exit fast with a short timeout — it runs
   synchronously inside the turn and must never stall it. (Validated: a
   `node "<script>" <label>` hook command works.)

4. **The hook endpoint** — a **dedicated, always-on localhost HTTP server** owned
   by the binding module. Note: the existing `ownServer`/`ownPort` in
   `src/main/remote/index.ts` is a candidate, **but it is gated by the optional
   `remote.enabled` feature** — binding must work regardless, so a small dedicated
   server (or an unconditionally-started one) is safer. On POST it: validates the
   token; updates `Map<tabId, { session_id, transcript_path, updatedAt }>`
   (last-write-wins by `updatedAt`); ignores payloads for unknown/closed tabs.

5. **Rebind wiring** — the existing seam is
   `PtyManager.onSessionAssigned = (tabId, sessionId, tool) => startWatching(tabId, sessionId, projectPath, tool.getSessionFilePath(...), tool)`
   (`editor.ts`). Drive this from the binding map instead of the PID-walk: on each
   hook update, call the equivalent with `session_id` + `transcript_path` straight
   from the payload. `ThinkingWatcher.startWatching()` already stops the previous
   watcher first, so re-binding on `/clear` / `/branch` is automatic — only the
   **source** of `(sessionId, path)` changes.

6. **Deletion after cutover** — `resolveOwnerPid()` (PowerShell CIM) and the
   mtime/newest-file logic inside `watchForNewSessions()` become dead for binding.
   Remove them once the hook path is proven.

### Version robustness (no version parsing — detect capabilities)

- **`--settings` support:** feature-detect once via `claude --help` (cache the
  result); if absent, the hook-install path simply doesn't activate.
- **Degradation when hooks are silent** (old CLI, or `--settings` unsupported):
  if no hook callback arrives for a tab within a timeout after session start,
  session-bound features (thinking panel) show "unavailable — update Claude Code."
  **No PowerShell fallback** (it can't port to Linux, and we are removing it). The
  glyph attention signal keeps working independently (see Part 2).
- Build only on the **stable core** (`transcript_path` + the oldest events
  `SessionStart`/`Stop`); never on version-fragile fields.

### Dependency: trust must stay pre-seeded

Interactive claude blocks on a "Do you trust this folder?" dialog on first launch
in an untrusted directory — **before any hook fires**. AIDE's `prepareProject()`
already pre-seeds trust in `~/.claude.json`; this must keep working or hooks never
run. (Observed live: the dialog gates all startup hooks until answered.)

---

## Part 2 — needs-input detection (gathered knowledge, not yet scoped)

### The glyph stays — explicitly out of scope

`detectTitleEvent()` (`claudeCode.ts`) sniffs the OSC terminal title and emits
`completeAndWait` when it starts with `✳` (U+2733). This detects **"the CLI has
exhausted its actions and needs input"** — it deliberately does **not**
distinguish "approval required" from "turn complete." That is correct for its job:
an attention signal (a beep when the user is doing something else). It is
title-based, therefore **cross-platform**, and in Claude Code specifically it
works without a single break.

**Decision: leave the glyph untouched.** It is not broken, it is not
Windows-specific, and it does its one job well. The earlier idea of "replace the
glyph with `Notification`/hooks" is **withdrawn**. Hook infrastructure is
justified by binding (Part 1) alone.

### If/when an audio client needs "operation requires approval"

For an eyes-free flow where the user reacts to a specific approval request, the
glyph is insufficient (no payload, can't tell approval from completion). Verified
options, to be chosen when that feature is built — **not now**:

1. **Glyph → read the (now reliably bound) transcript.** The glyph says "something
   needs you"; the consumer reads the tab's transcript — bound deterministically
   after Part 1 — to decide whether it's a completed turn or a pending approval,
   and speaks accordingly. No new hook. Open question to verify then: whether a
   *pending* (unapproved) permission request is written to the JSONL before
   approval.

2. **`PermissionRequest` hook** — rides free on the Part 1 hook pipe (one line in
   the static hook config). Verified behaviour (2.1.206, interactive):
   - Fires **~132 ms after `PreToolUse`**, exactly when the approval dialog
     appears — instant, unlike `Notification`.
   - Payload carries `tool_name`, `tool_input`, and `permission_suggestions` (the
     exact allow-rule that approval would add) — enough to voice *what* is asked
     and offer approve/deny.
   - **Interactive only** (in headless the turn just `Stop`s without executing —
     but AIDE runs claude interactively, so this is our case).

### Why `Notification` is *not* the primary signal

`Notification{notification_type:"permission_prompt", message:"Claude needs your
permission"}` does fire — but **~6 seconds after** `PermissionRequest` (it is
throttled by the desktop-notification idle threshold). It was silent in a fast
interactive session because turns/auto-approvals beat the threshold. Fine as a
secondary/idle signal (`idle_prompt`), unusable as a real-time approval trigger.

---

## Test harness

To reproduce the captures (used to verify everything above):

- **Logging hook:** a Node script that appends `argv-label + raw stdin` to a log
  file, wired to each event in a `--settings` JSON.
- **Env:** AIDE-style proxy vars (`HTTP(S)_PROXY`, `NO_PROXY=localhost,127.0.0.1,::1`)
  — direct `claude` launch is proxy-gated on this machine.
- **Headless:** `claude -p "<prompt>" --settings <file>` — good for payload shapes
  and `--settings` merge, but does **not** fire the interactive-only permission
  events.
- **Interactive:** drive `claude` through **node-pty** run under Electron
  (`ELECTRON_RUN_AS_NODE=1 electron.exe driver.js`) — node-pty is a native module
  built for Electron's ABI, so it must run under Electron, not plain Node. The
  driver scripts keystrokes with delays and streams PTY output to a file (so it
  never lands in the console). This is how `/branch`, `/clear`, `/compact`, and the
  `PermissionRequest` dialog were captured.
