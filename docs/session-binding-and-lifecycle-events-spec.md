# Spec: deterministic session binding + lifecycle events via Claude Code hooks

> Status: **Specification.** This is the buildable design. It supersedes the two
> problem-statement docs it draws on:
> - `session-binding-and-needs-input-refactor.md` (why the current heuristics are
>   fragile, and the hook idea)
> - `remote-protocol-extensions.md` (the downstream consumer that needs a neutral
>   lifecycle event stream)
>
> Where those docs left decisions open, this doc closes them. Open items that
> still require live verification are collected in §14.

---

## 1. Goals / non-goals

**Goals**

1. Replace inferred tab↔session binding with an **authoritative** binding that
   Claude Code itself announces, correct across `/clear`, `/branch`, `--resume`,
   and compaction.
2. Replace the terminal-title glyph heuristic as the **primary** needs-input
   detector with structured hook events; demote the glyph to an independent
   liveness **watchdog**.
3. Expose a small, tool-agnostic **lifecycle event bus** inside AIDE
   (`turn.start`, `turn.end`, `needs-input`, `error-state`) that the future
   remote-protocol layer and the existing thinking panel both consume.
4. Keep the change **cross-platform-ready** (Linux/macOS are planned) — no new
   Windows-only mechanism on the binding path.

**Non-goals**

- The remote wire protocol / mobile client. This spec only produces the internal
  event bus those will later consume.
- `tool-activity` events. Explicitly **dropped** (see §8): high-frequency,
  content-free, prone to alert overload, and the only feature that would have
  forced high-frequency hooks.
- Binding for non-Claude tools. Codex / Cursor / Qwen / OpenCode keep their
  existing `watchForNewSessions` + `resolveOwnerPid` inference path unchanged.

---

## 2. Background (current mechanism, condensed)

Today binding is reconstructed from indirect signals in
`ptyManager.assignNewSession()` (`src/main/pty/ptyManager.ts:397`):

- `watchForNewSessions()` → `watchSessionsDir()` waits for a new `*.jsonl` under
  `~/.claude/projects/<encoded>/`.
- "Sole waiting tab" fast path, else `claudeCodeTool.resolveOwnerPid()`
  (`claudeCode.ts:517`) runs a PowerShell `Get-CimInstance Win32_Process` query,
  builds the PID tree, walks `claude*` ancestry, and picks the **highest PID**.
- The result drives `onSessionAssigned(tabId, sessionId, tool)`
  (`ptyManager.ts:59`), whose consumer (`editor.ts:109`) calls
  `ThinkingWatcher.startWatching()` (`editor.ts:111`).

needs-input is sniffed from the OSC title in
`claudeCodeTool.detectTitleEvent()` (`claudeCode.ts:584`): a transition into a
title whose first code point is `U+2733` ("✳") emits `completeAndWait` via the
per-tab signal handler registered in `spawnPty()` (`ptyManager.ts:508`).

Both mechanisms are timing- and format-dependent; see the refactor doc for the
full failure analysis.

---

## 3. Architecture overview

```
PTY spawn (ptyManager.spawnPty) — the PTY is powershell.exe; claude runs inside it
  └─ inject env: AIDE_TAB=<tabId>, AIDE_HOOK_URL=http://127.0.0.1:<hookPort>/hook,
                 AIDE_HOOK_SECRET=<per-session-random>
        │  env inherited: powershell → claude → hook command
        ▼
Claude Code process ── fires hooks ──▶ hook helper (bundled, cross-platform)
                                          reads $AIDE_TAB/$AIDE_HOOK_URL/$AIDE_HOOK_SECRET
                                          + stdin JSON (session_id, transcript_path, …)
                                          POST {tabId, secret, event, session_id, transcript_path, …}
                                          fire-and-forget, tight timeout
        │
        ▼
AIDE hook receiver — ONE per editor window (127.0.0.1, OS-assigned port),
  co-located with that window's PtyManager/ThinkingWatcher; independent of
  remote.enabled; NOT the RemoteServer (see §7.1). The injected port identifies
  the window, so no cross-window tab routing is needed.
  ├─ validate secret + known tabId
  ├─ update binding:  tabId → { sessionId, transcriptPath }   (always latest)
  │     └─ drives this window's onSessionAssigned → ThinkingWatcher.startWatching
  └─ publish lifecycle event onto the internal event bus
        │
        ▼
Event bus consumers: thinking panel, (future) remote protocol layer
  (RemoteServer subscribes to the bus when remote.enabled — it never owns a receiver)
        ▲
        │  reconciliation
Title watchdog (detectTitleEvent, demoted): title→idle without a matching
  lifecycle event within 2 s ⇒ emit error-state
```

The hook helper reports **facts only** (ids + path + event name + minimal
fields). All interpretation — reading the transcript, parsing blocks — stays in
AIDE where the per-tool parsers already live (`parseHistoryLine`,
`parseThinkingBlocks`).

---

## 4. Hook installation — synthetic per-session settings file

### 4.1 Verified constraint (gates this design)

From the Claude Code settings docs:

- Settings precedence (high→low): managed → **command-line (`--settings`)** →
  local (`.claude/settings.local.json`) → project (`.claude/settings.json`) →
  user (`~/.claude/settings.json`).
- **`hooks` does NOT merge across sources.** Only permission rules merge; every
  other key (including `hooks`) is supplied *entirely* by the highest-precedence
  source that defines it. Precedence is evaluated **per key**: a key absent from
  `--settings` still falls through to lower tiers.

Consequences:

- Naive `--settings <file>` that defines `hooks` **clobbers** the user's own
  project/user hooks for that session. Rejected.
- Naive merge-into-`.claude/settings.json` mutates the user's repo (git noise,
  teardown burden, two-writer hazard the remote doc warns about). Rejected.

### 4.2 Chosen mechanism

At launch, AIDE **synthesizes** a temporary settings file that contains only a
`hooks` key holding **`effectiveUserHooks ⊕ aideHooks`**, and passes it via
`claude --settings <tempfile>`. The repo is never touched; teardown = delete the
temp file.

Steps:

1. Compute `effectiveUserHooks`: read `hooks` from local, project, and user
   settings; per Claude's own rule, the **single highest-precedence** source
   that defines `hooks` is the effective one (do **not** union across the three —
   replicate Claude's override semantics exactly).
2. Merge AIDE's hook entries **per event**: for each event we register, append
   our matcher/command to the array already present under that event in
   `effectiveUserHooks` (never replace an existing array).
3. Write `{ "hooks": <merged> }` to a temp file
   (`<userData>/aide/claude-hooks.<aideSessionId>.json`). Only the `hooks` key —
   every other setting still resolves normally from the user's tiers.
4. Launch every Claude tab with `--settings <tempfile>`. The file is **shared
   across all tabs** in the AIDE session; per-tab identity rides on env (§5), not
   on the file.
5. Delete the temp file on AIDE shutdown; on startup, sweep stale
   `claude-hooks.*.json` from prior crashed runs.

### 4.3 Registered hook events (minimal set)

Only low-frequency events — a handful per turn, never per-tool:

| Hook event | Purpose |
|---|---|
| `SessionStart` | (re)bind — carries `source` ∈ {startup, resume, clear, compact} |
| `SessionEnd` | unbind / reconcile |
| `UserPromptSubmit` | `turn.start` |
| `Stop` | `turn.end` (read transcript, emit answer text) |
| `PermissionRequest` | `needs-input` (carries `tool_name`, `tool_input`) |
| `Notification` | `needs-input` (matcher: `permission_prompt`, `idle_prompt`, `agent_needs_input`) |

`PreToolUse` / `PostToolUse` / `PostToolBatch` are **not** registered (they were
only needed for the dropped `tool-activity`).

### 4.4 The launch integration point

`newSessionCommand()` / `resumeCommand()` in `claudeCode.ts` currently return
`"claude"` / `"claude --resume <id>"`. Both must append
`--settings <tempfile>`. The temp file path is resolved once per AIDE session
(lazily, at first Claude spawn) and cached. `prepareProject()` remains the place
for one-time trust config; temp-file synthesis is a separate step tied to the
Claude tool's first launch, not to the project.

---

## 5. Per-tab identity injection

Every hook receives common fields (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`) and **command hooks inherit the env `claude` was launched
with**. The PTY AIDE spawns is `powershell.exe` (`ptyManager.ts:512`), and
`claude` runs inside it, so the inheritance chain is
**powershell → claude → hook command** — this is what carries the identity env
all the way to the helper. AIDE uses that channel to tell the hook *which tab* it
belongs to.

Because `CliTool.getEnvOverrides()` is **per-tool and argument-less**
(`types.ts:37`, used only for proxy vars), it cannot carry a per-tab value. So
the tab identity is injected **generically by `ptyManager.spawnPty()`**, not
through the tool:

```
env.AIDE_TAB        = <tabId>                                // per tab
env.AIDE_HOOK_URL   = http://127.0.0.1:<hookPort>/hook        // this window's receiver
env.AIDE_HOOK_SECRET= <random, per AIDE session>             // per AIDE session
```

- `<hookPort>` is **this editor window's** hook receiver port (§7.1), OS-assigned.
- **Port handoff + ordering guarantee.** `spawnPty` is **synchronous**
  (`ptyManager.ts:501-534`, fixes `env` at `:502-518` and returns `IPty`), and its
  callers `spawnNewSessionTab`/`spawnResumeTab` (`:435,454`) return
  `SessionTabInfo` synchronously to the IPC handler. So the port must already be
  resolved by the time any spawn runs. Mechanism:
  1. During editor-window setup (`editor.ts`, where `ThinkingWatcher` is created,
     `:107`), create the `HookReceiver` and **`await receiver.start()`** — `start`
     resolves only after `listen(0, …)` reports the port (the pattern at
     `remote/index.ts:134-137`). Spawn IPC for a window cannot arrive before its
     window finishes setting up, so this is a real barrier, not a race.
  2. Hand the resolved port to the window's `PtyManager` (constructor arg or a
     `setHookPort(port)` setter). `spawnPty` then reads it **synchronously** from
     an in-memory field — never eagerly at bind time (when it is still `0`).

  The real barrier is not the `await` itself: every spawn entry point is invoked
  from `ipcMain.handle` (`ipc/index.ts:259,270,279,639,1233`), i.e. only after the
  window's renderer has loaded and called back — strictly after window setup. So
  the port is always resolved before the first spawn regardless. That means the
  handoff can be a non-awaited `receiver.start().then(port => ptyMgr.setHookPort(port))`
  and avoid making `openProjectAndTrack` async (it currently returns
  `{ success, error }` synchronously, consumed at `index.ts:44`). **Prefer the
  `.then()` setter** over a hard `await` to sidestep that async ripple; a hard
  `await` also works but changes the function's signature and its callers. Either
  way this is a `PtyManager` wiring change, not a footnote.
- Injection is gated to hook-capable tools (§9) so non-Claude PTYs stay clean.
- `getEnvOverrides()` is untouched and keeps handling proxy vars.

---

## 6. The hook helper (transport)

A tiny **bundled, cross-platform** executable invoked as the hook command. It:

1. reads `AIDE_TAB`, `AIDE_HOOK_URL`, `AIDE_HOOK_SECRET` from env,
2. reads the hook JSON from stdin,
3. POSTs `{ tabId, secret, event, session_id, transcript_path, …minimal fields }`
   to `AIDE_HOOK_URL`,
4. exits immediately.

Hard requirements:

- **Never blocks the turn.** Fire-and-forget with a tight connect+write timeout
  (≤ 500 ms); on any error (AIDE not listening, timeout) it exits 0 silently.
- **Cross-platform.** No `powershell -c Invoke-RestMethod` (Windows-only, slow
  process spawn). Ship a small binary, or a single portable script with a
  runtime already guaranteed present. **Decision pending §14 (a).**
- **Cheap.** Even though events are low-frequency, per-hook process spawn cost
  should stay negligible.

The helper carries **no parsing logic**. It never reads the transcript.

---

## 7. AIDE hook receiver + binding model

### 7.1 Receiver — a dedicated per-window listener (NOT RemoteServer)

The hook receiver must **not** ride on `RemoteServer`. `RemoteServer.start()` is
a no-op unless the opt-in remote feature is enabled
(`remote/index.ts:103`: `if (!getAppConfig().remote.enabled) return`), its
default is `false` (`appConfig.ts:109`), and it is a process-wide singleton
(`index.ts:33`). Binding-via-hooks is a fix AIDE needs on its own merits, so it
cannot depend on that feature being switched on, and its wiring
(`onSessionAssigned`, `ThinkingWatcher`) is per **editor window**, not
process-wide.

Therefore: a **new, minimal HTTP listener owned by the editor window**, created
in `editor.ts` next to the window's `ThinkingWatcher`
(`editor.ts:107`), bound to `127.0.0.1` on an OS-assigned port, always on
regardless of `remote.enabled`. Tracked in a
`hookReceiverRegistry: Map<BrowserWindow, HookReceiver>` mirroring
`ptyRegistry` / `thinkingRegistry`. Because each window injects **its own**
receiver port into **its own** PTYs (§5), a POST necessarily arrives at the
listener of the window that owns the tab — no cross-window routing, no global
`tabId → window` map.

A `POST /hook` handler. For each request:

1. Reject if `secret !== AIDE_HOOK_SECRET` or `tabId` is not a live tab of **this
   window**'s `PtyManager`.
2. Parse `{ tabId, event, session_id, transcript_path, notification_type?,
   tool_name?, source? }`.
3. Update binding + publish a lifecycle event (below) onto the internal bus.

`RemoteServer`, when enabled, **subscribes** to the lifecycle bus for the remote
protocol; it never hosts the receiver.

### 7.2 Binding = always trust the latest payload

Authoritative map `tabId → { sessionId, transcriptPath }`, updated on **every**
hook that carries a transcript (all of them do). No caching of the path across
events; no inference.

- On `SessionStart` (any `source`) and `Stop`: set/refresh the binding for
  `tabId` by calling a **new `PtyManager.bindSession(tabId, sessionId,
  transcriptPath)`** method (see §7.3 — the receiver lives outside `PtyManager`
  and must not touch its private `tabs` map directly). If `sessionId` or
  `transcriptPath` changed vs the current binding (i.e. `/clear`, `/branch`,
  compaction produced a new transcript), `bindSession` re-drives the
  `onSessionAssigned` path with the **new** values.
  `ThinkingWatcher.startWatching()` already stops the old watcher and starts a
  new one for the tab (`thinkingWatcher.ts:35`), so re-binding is automatic.
- `ThinkingWatcher` should watch the **`transcript_path` from the hook**.
  `startWatching()` **already takes an explicit `filePath` param**
  (`thinkingWatcher.ts:28-34`); today `editor.ts:110` fills it from
  `getSessionFilePath()`. The hook path passes the hook's `transcript_path` as
  that **existing** argument — no redundant parameter. What genuinely needs
  extending is the **`onSessionAssigned` signature** (currently
  `(tabId, sessionId, tool)`, `ptyManager.ts:59`): add an **optional** 4th
  `transcriptPath?` param so the three existing call sites (`ptyManager.ts:314,
  412, 425, 461`) keep compiling and the `editor.ts:109` consumer stays
  backward-compatible. Non-hook tools omit it and keep using
  `getSessionFilePath()`.
  *(Note: the very first bind of a Claude **resume** tab still comes from
  `getSessionFilePath()` via `spawnResumeTab`→`onSessionAssigned`
  (`ptyManager.ts:461`) before any hook fires; it self-heals to the authoritative
  `transcript_path` on the first `SessionStart{resume}`/`Stop`. So the hook path
  is authoritative but not the sole path — the reconstructed path remains the
  bootstrap for resume.)*
- `SessionEnd`: drop the binding, stop the watcher, emit lifecycle end if
  appropriate.
- `/branch` may or may not fire its own hook (§14 c). Irrelevant to correctness:
  the next `Stop`/`SessionStart` carries the correct `transcript_path` and
  re-binds. Nothing drifts because nothing is inferred.

### 7.3 `PtyManager.bindSession` — the single main-process writer

**This is required, not optional.** Today the *only* writers of `PtyTab.sessionId`
for a **new** session are inside `assignNewSession` (`ptyManager.ts:406,410,423`).
§9 turns that path off for Claude tabs — so without a replacement writer,
`tab.sessionId` stays `null`, and everything that reads the **main-process** field
breaks: `getActiveSessions()` (`ptyManager.ts:379-384`, used by tab persistence /
restore at `editor.ts:158`), `getTabs()` (`:224-231`), `resetAllTabs()` (`:318`).
The regression is silent: new Claude tabs would persist as `sessionId: null` and
respawn fresh instead of resuming on restart — undoing commit `6bdb94b`
("restore all terminal tabs reliably").

`bindSession` runs on **every** `SessionStart`/`Stop`, so it must be idempotent:
it re-drives the watcher **only on an actual change**, matching §7.2. It tracks
the last-bound `{ sessionId, transcriptPath }` per tab (a new
`Map<tabId, {sessionId, transcriptPath}>`, since `PtyTab` carries no transcript
path) and compares **both** fields — comparing only `sessionId` would miss the
compaction case (same `sessionId`, new transcript) that §7.2 explicitly calls
out.

```
PtyManager.bindSession(tabId, sessionId, transcriptPath): void
  - look up the tab; ignore if unknown/closed
  - prev = lastBind.get(tabId)                       // {sessionId, transcriptPath} | undefined
  - if prev?.sessionId === sessionId
       && prev?.transcriptPath === transcriptPath:  return   // no change → no thrash
  - if prev?.sessionId !== sessionId:
       tab.sessionId = sessionId
       send('terminal:tab-session-id', { tabId, sessionId })
  - lastBind.set(tabId, { sessionId, transcriptPath })
  - this.onSessionAssigned?.(tabId, sessionId, tab.tool, transcriptPath)   // only on change
  // clear lastBind for the tab in closeTab()/deregister
```

Why the change-gate matters: `onSessionAssigned` flows to
`ThinkingWatcher.startWatching`, which calls `stopWatching` then resets
`blocks:[]`/`offset:0` (`thinkingWatcher.ts:36,40-49`) and re-reads the whole
transcript from offset 0 (`readNew`, `:68`). Calling it unconditionally on every
`Stop` would tear down and full-re-read the (growing) transcript each turn and
reset the panel — so the gate is correctness *and* efficiency.

The per-window hook receiver calls **only** `bindSession` (never the private
`tabs` map). This keeps `PtyTab.sessionId` authoritative in the main process, so
persistence/restore, the session picker, and titles all see the real id. It also
subsumes the `terminal:tab-session-id` send that `assignNewSession` did at
`ptyManager.ts:411`.

### 7.4 Secret + per-process identity

`AIDE_HOOK_SECRET` is **per AIDE process**, but receivers are **per window**, so a
process-global holder is needed:

- A small module (e.g. `src/main/hooks/hookIdentity.ts`) generates, once at boot,
  a random `AIDE_HOOK_SECRET` (`randomUUID()`) and an `aideSessionId` (used to
  namespace the temp settings file §4 and stale-file sweeps). Both are new
  concepts with no existing counterpart in the code.
- `spawnPty` reads the secret from this module for env injection (§5); every
  window's `HookReceiver` reads the same value to validate incoming POSTs. One
  secret, many receivers.

---

## 8. Lifecycle event bus (internal)

A neutral, tool-agnostic in-process event bus keyed by `tabId`. Four event
types (`tool-activity` intentionally absent):

| Bus event | Source hook | Payload |
|---|---|---|
| `turn.start` | `UserPromptSubmit` | `{ tabId }` |
| `turn.end` | `Stop` | `{ tabId, answerText }` — clean assistant text parsed from `transcript_path` |
| `needs-input` | `PermissionRequest` / `Notification{permission_prompt,idle_prompt,agent_needs_input}` | `{ tabId, kind, toolName? }` |
| `error-state` | watchdog (§10) | `{ tabId, reason }` |

Rules:

- **`turn.start` = a genuine new prompt only** (`UserPromptSubmit`). A mid-turn
  permission approval is *not* a new turn and must not emit `turn.start`, else a
  hands-free consumer thinks a fresh answer began.
- **`needs-input` carries a neutral discriminator** `kind ∈
  {permission, input, elicitation}` plus optional generic `toolName` (from
  `PermissionRequest.tool_name`). `toolName` is a generic fact, not tool-specific
  coupling — it lets a screen-off consumer say *what* is being asked
  ("approve Bash") instead of a blind "waiting". Prefer `PermissionRequest` (has
  `tool_name`/`tool_input`) over `Notification/permission_prompt` when both would
  fire for the same block; de-dupe within a short window.
- Consumers map events themselves (voice: `turn.end`→speak,
  `needs-input`→alert, `error-state`→error sound). AIDE emits neutral events and
  knows none of that.
- The two streams per tab (raw PTY, lifecycle bus) are asynchronous to each
  other; **ordering between them is the consumer's concern**, not AIDE's.

The existing thinking panel is refactored to consume this bus / the
hook-driven binding instead of the inference path.

---

## 9. Which tools use hooks (capability gate)

Binding-via-hooks is Claude-only. Introduce an explicit capability so
`ptyManager` knows to skip the inference heuristics for such tools:

- Add optional `readonly bindsViaHooks?: boolean` (or a small
  `authoritativeBinding` sub-object) to `CliTool`. `claudeCodeTool` sets it.
- In `ptyManager`:
  - For hook-capable tools: **do not** call `ensureToolWatcher()` /
    `assignNewSession()` (skip `watchForNewSessions` + `resolveOwnerPid`
    binding); inject the tab-identity env (§5); pass `--settings` (§4).
  - For all other tools: current behavior unchanged.
- The hook receiver feeds `onSessionAssigned` for hook-capable tabs; the
  inference path feeds it for the rest. `onSessionAssigned` stays the single
  choke point into `ThinkingWatcher`.

---

## 10. needs-input watchdog (demoted title heuristic)

`detectTitleEvent()` is **repurposed, not deleted**. It stops being the
needs-input detector and becomes an independent liveness cross-check that
catches the one failure the hook path can't self-heal: a **lost POST**.

Two independent observers per tab:

- PTY title → "idle" (title's first code point flips to the idle glyph).
- Lifecycle bus → an event that *explains* why the tab went idle.

Watchdog rule:

> On a title transition into the idle state, start a 2 s timer. If **no**
> reconciling lifecycle event arrives for that tab before it fires, emit
> `error-state` (reason `"unexplained-idle"`).

Reconciling event set (any one cancels the timer):
`turn.end` (`Stop`) · `needs-input` · a `SessionStart{clear,compact}` · a
`SessionEnd`. Including the last three prevents false errors on `/clear`,
compaction, and normal exit.

Properties:

- **Fixes the lost-POST hole** via a second channel that does not go through
  HTTP.
- **Graceful degradation inverts.** Today the glyph is primary: a CLI change to
  the glyph silently breaks needs-input. After this change, a glyph change only
  disables the *safety net*; the primary (hook) signal still works. Worst-case
  regression drops from "miss real waits" to "lose the watchdog".
- `error-state` semantics = "AIDE cannot explain why Claude went idle" → the
  consumer maps it to an error sound + "go look at the screen". It is an escape
  hatch, not a normal state.

Generalization (not built now): `error-state` is really "divergence between the
two independent observers". The same mechanism could later catch "hooks say
working but PTY silent for N s" (hung CLI). Out of scope; the title→idle case is
the minimal first cut.

---

## 11. Code change map

| File | Change |
|---|---|
| `src/main/pty/cliTools/types.ts` | Add `bindsViaHooks?` capability; add an **optional** 4th `transcriptPath?` param to the `onSessionAssigned` type (`:59`) so existing 3-arg callers keep compiling. |
| `src/main/pty/cliTools/claudeCode.ts` | Set `bindsViaHooks`; append `--settings <tempfile>` in `newSessionCommand`/`resumeCommand`; temp-file synthesis (§4); repurpose `detectTitleEvent` as watchdog (§10). `resolveOwnerPid` **kept** (still used by `suspendCli`). `watchForNewSessions` no longer drives binding for Claude. |
| `src/main/pty/ptyManager.ts` | Add public **`bindSession(tabId, sessionId, transcriptPath)`** (§7.3) — the only main-process writer of `PtyTab.sessionId` for Claude tabs — backed by a new `lastBind: Map<tabId, {sessionId, transcriptPath}>`. **Clear that map's entry in `closeTab` (`:265-279`) and `disposeAll` (`:361-376`)** alongside the existing per-tab maps (`titleBufs`/`titleCache`/…), else it leaks over a long-lived process. Add a `hookPort` field + setter (§5). `spawnPty`: for hook-capable tools inject `AIDE_TAB`/`AIDE_HOOK_URL`/`AIDE_HOOK_SECRET` (URL uses the synchronously-readable `hookPort`). Gate `ensureToolWatcher`/`assignNewSession` off for hook-capable tools. Widen `onSessionAssigned` call sites (`:314,412,425,461`) to pass `transcriptPath` where known. |
| new: `src/main/hooks/hookReceiver.ts` | Per-window minimal `127.0.0.1` HTTP listener (`POST /hook`) with an `await`-able `start()` that resolves the port. Independent of `remote.enabled`. Secret validation; parse payload; call `ptyMgr.bindSession(...)` (never the private `tabs` map); publish to lifecycle bus. **Not** in `RemoteServer`. |
| new: `src/main/hooks/hookReceiverRegistry.ts` | `Map<BrowserWindow, HookReceiver>`, mirroring `thinkingRegistry`. |
| new: `src/main/hooks/hookIdentity.ts` | Process-global `AIDE_HOOK_SECRET` + `aideSessionId`, generated once at boot; read by `spawnPty` (inject) and every receiver (validate). (§7.4) |
| new: `src/main/events/lifecycleBus.ts` | The internal event bus (§8). |
| new: hook helper binary/script | §6. Bundled with the app. |
| `src/main/thinking/thinkingWatcher.ts` | No new param — reuse the existing `filePath` arg of `startWatching` (`thinkingWatcher.ts:28`), fed the hook's `transcript_path`. |
| `src/main/windows/editor.ts` | Create the window's `HookReceiver` next to `ThinkingWatcher` (`editor.ts:107`); hand its resolved port to the window's `PtyManager` via `receiver.start().then(p => ptyMgr.setHookPort(p))` (preferred over a hard `await` to keep `openProjectAndTrack` synchronous — §5). Wire receiver → `ptyMgr.bindSession` / lifecycle bus. Pass the transcript path as `startWatching`'s existing `filePath` arg. Dispose the receiver on window close (`editor.ts:182`). |
| `src/main/remote/index.ts` (`RemoteServer`) | **Subscribe** to the lifecycle bus when `remote.enabled` (for the future remote protocol). Does **not** host the receiver. |

**Deletions (Claude binding path only):** the "sole waiting tab" fast path and
`resolveOwnerPid`-based branch inside `assignNewSession` no longer run for Claude
tabs; the 300 ms settle / directory-poll timing hacks on the Claude binding path
go away. None of the `CliTool` interface methods are removed (other tools rely
on them; `resolveOwnerPid` also serves `suspendCli`).

---

## 12. Security

- The `/hook` endpoint accepts `tabId → transcriptPath` from localhost. Any local
  process could forge a binding. Mitigation: a random `AIDE_HOOK_SECRET`
  generated per AIDE session, injected into the PTY env, and required on every
  POST. Cheap, closes casual spoofing. Single-user localhost keeps the residual
  risk low.
- Reject unknown/closed `tabId`.

---

## 13. Failure modes & degradation

| Failure | Effect | Handling |
|---|---|---|
| Hook receiver down when hook fires (window closing/closed) | Fact lost, no retry | The per-window receiver is always on while the window lives (independent of `remote.enabled`), so the window is the loss boundary. Binding self-heals on the next event; `needs-input` loss caught by watchdog (§10). |
| CLI changes the idle glyph | Watchdog blind | Primary (hook) unaffected; only the safety net degrades. |
| Helper missing / errors | No lifecycle events for that tab | Helper exits 0 silently; never stalls a turn. Watchdog still emits `error-state` on unexplained idle. |
| `--settings` unsupported/misbehaves | Hooks not installed | Detect at launch; fall back to legacy inference path + log. |
| Two AIDE instances / many windows | Each window has its own receiver port; secret is per AIDE process; temp files namespaced by AIDE session id | A hook can only reach the window that injected its port; no cross-talk. |

---

## 14. Open items to verify during implementation

These must be confirmed before the dependent code is finalized. **(e) is
load-bearing** — the whole identity mechanism fails if it is false.

- **(e) GATING — command hooks inherit `claude`'s environment on Windows.** §5's
  per-tab injection (AIDE_TAB / AIDE_HOOK_URL / AIDE_HOOK_SECRET riding env
  through **powershell → claude → hook command**) assumes Claude spawns command
  hooks with its inherited environment and does not sanitize it. This is stated
  as fact in §3/§5 but is **unverified**. If Claude strips or does not forward env
  to hook subprocesses, identity injection fails entirely and no tab is routable.
  Verify first, before building the helper. Fallback if false: pass the identity
  via the hook command's argv in the synthesized settings file instead of env.
- **(a) Helper transport.** Choose bundled binary vs portable script; confirm the
  chosen runtime is present on all target OSes and that fire-and-forget with a
  ≤500 ms timeout is reliable.
- **(b) `MessageDisplay` granularity.** It carries assistant `message` text but
  "streams". If it fires per-chunk it is noise and must **not** replace
  transcript parsing; treat as an optional optimization only. Verify before using
  it for `turn.end` answer text. Default: parse the transcript at `Stop`.
- **(c) Does `/branch` fire a hook?** Not needed for correctness (always-latest
  discipline covers it), but confirm which event re-binds after a branch and how
  fast.
- **(d) `--settings` per-key override.** Confirm empirically that a `--settings`
  file containing only `hooks` overrides *only* `hooks` and leaves the user's
  other settings (permissions, model, …) resolving normally from their tiers.

**Already verified (authoritative), so NOT open** — checked against the Claude
Code hooks reference (https://code.claude.com/docs/en/hooks) and settings
reference (https://code.claude.com/docs/en/settings), fetched 2026-07-03;
re-confirm against those URLs for the CLI version actually shipped: the
existence and payload shapes of `SessionStart`
(`source ∈ {startup,resume,clear,compact}`), `SessionEnd`, `UserPromptSubmit`,
`Stop`, `PermissionRequest` (`tool_name`/`tool_input`), and `Notification` with
`notification_type ∈ {permission_prompt, idle_prompt, agent_needs_input, …}`;
that all hooks receive `session_id` + `transcript_path` on stdin; and that `hooks`
does **not** merge across settings sources (§4.1). Re-confirm only if the CLI
version in use is older than that reference.

---

## 15. Testing plan

1. **Binding under mutation.** Start a Claude tab, run `/clear`, `/branch`,
   `--resume`, force a compaction; assert the thinking panel and the binding map
   always track the live transcript (no stale-session thinking).
2. **Concurrency.** Launch two Claude tabs within the same second; assert each
   binds to its own session (previously a coin flip).
3. **needs-input taxonomy.** Trigger a permission prompt and an idle wait; assert
   distinct `needs-input{kind}` events with `toolName` on permission, and that
   `Stop` yields `turn.end` separately.
4. **Watchdog.** Simulate a dropped POST (block the receiver) and confirm
   `error-state` fires ~2 s after the title goes idle; confirm `/clear` and exit
   do **not** produce false `error-state`.
5. **User-hook preservation.** Put a benign hook in the project
   `.claude/settings.json`; confirm it still fires alongside AIDE's after launch
   (synthetic-merge correctness), and that the repo file is untouched.
6. **Non-Claude regression.** Confirm Codex/Cursor/Qwen/OpenCode binding is
   unchanged.
