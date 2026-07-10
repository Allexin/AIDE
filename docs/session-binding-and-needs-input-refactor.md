# Refactor: deterministic session binding + needs-input via Claude Code hooks

> Status: problem statement / knowledge dump. **Not a spec.** The goal here is to
> record what is known: how it works today, why that is fragile, and the
> alternative worth building. Design decisions are deliberately left open.

This is a fix that AIDE needs on its own merits — it repairs real bugs in
existing features (thinking panel, session picker, anything that reads "the
current transcript of a tab"). It is **not** scoped to any downstream consumer.

---

## Part 1 — Tab ↔ session binding

### How it works today (heuristic)

There is no direct link between a PTY tab and the Claude Code session it is
running. AIDE reconstructs the link from indirect signals:

1. `watchForNewSessions()` (`claudeCode.ts` → `watchSessionsDir` in
   `claudeCodeScanner.ts`) watches `~/.claude/projects/<encoded>/` for a new
   `*.jsonl` file to appear. Encoding of the project path is done by
   `encodeProjectPath()` (e.g. `E:\Projects\X` → `E--Projects-X`).
2. When a new file appears, `resolveOwnerPid()` (`claudeCode.ts`) runs a
   PowerShell `Get-CimInstance Win32_Process` query, builds the full
   parent/child PID map, and walks the ancestry of every `claude*` process to
   find one descended from a candidate PTY PID. When several tabs are waiting it
   **picks the highest PID** ("most recently started") and calls that the owner.
3. `ThinkingWatcher` (`src/main/thinking/thinkingWatcher.ts`) then binds
   `tabId → filePath` and tails the file via `subscribeToSessionHistory()` /
   `parseHistoryLine()`, filtering for `thinking` blocks.

So the binding rests on a stack of guesses: "newest file on disk" + "process
ancestry" + "highest PID" + a 300 ms write-settle delay + directory-existence
polling.

### Why it is fragile

- **Mid-session session-id changes break it.** `/branch`, `/clear`, `--resume`,
  and compaction can create a *new* session id (new `.jsonl`) or switch the
  active session while the tab keeps running. The tab stays bound to the old
  file. Symptoms: the thinking panel shows thinking from a dead session; any
  consumer that reads "the current transcript for this tab" reads the wrong
  file; and in some cases the binding is simply never (re)established.
- **Race conditions.** Ordering by mtime, the 300 ms delay hack, and polling for
  the directory to appear are all timing-dependent.
- **Ambiguity under concurrency.** Two tabs launching `claude` at nearly the
  same time make "highest PID owns the newest file" a coin flip.
- **Cost / portability.** A PowerShell CIM process-tree query per new session is
  slow and Windows-specific.

The root cause: **AIDE infers the binding instead of being told it.**

### The alternative: let Claude Code announce the binding (hooks)

Claude Code hooks give a direct, event-driven source of truth. Confirmed from
the hooks reference (https://code.claude.com/docs/en/hooks):

- **Every hook receives `session_id` and `transcript_path` on stdin** (plus
  `cwd`, `hook_event_name`, etc.).
- **Hooks run in interactive mode**, at lifecycle points during a normal
  conversation.
- **Command hooks inherit the environment `claude` was launched with.**

That is everything needed:

1. At PTY spawn, inject a per-tab marker into the environment — e.g.
   `AIDE_TAB=<tabId>` and `AIDE_HOOK_URL=http://127.0.0.1:<ownPort>/hook`. The
   `getEnvOverrides()` hook on the `CliTool` interface already exists as the
   injection point (currently used only for proxy vars). The remote server's own
   port is known at spawn time, so the callback URL is concrete.
2. Register hooks that call a tiny helper. The helper reads `$AIDE_TAB` (which
   tab) and `transcript_path` from the hook payload (which file) and POSTs the
   **raw fact** back to AIDE: `{ tabId, event, session_id, transcript_path }`.
3. AIDE now has an authoritative `tabId → current transcript_path` map, updated
   as an event on every lifecycle transition.

Relevant hook events (from the reference):

- `SessionStart` — fires on `startup`, `resume`, `clear`, `compact` (matcher via
  a `source` field). This is where re-binding after `/clear` / resume /
  compaction happens.
- `Stop` — fires when Claude finishes responding; **carries `transcript_path`**.
- `UserPromptSubmit`, `PreToolUse`, `PostToolUse` — turn / activity boundaries.

**The discipline that makes `/branch` a non-issue:** never cache the path across
events. Always trust the `transcript_path` in the *current* hook payload. If a
branch or any other operation swaps the transcript, the next lifecycle hook
carries the correct path and we re-read from it. Nothing is inferred, so nothing
can drift.

**Separation of concerns:** the helper reports *facts only* (ids + path). All
interpretation — reading the transcript, parsing blocks — stays inside AIDE,
where the per-tool parsing logic (`parseHistoryLine`, `parseHistoryBlocks`)
already lives.

### Open questions / where to look

- **Hook installation mechanism.** Two candidates:
  - Merge our hooks into the project `.claude/settings.json` (must **merge**,
    never clobber the user's own hooks). `prepareProject()` is the natural
    injection point — it already writes trust config to `~/.claude.json`.
  - Pass a temporary settings file at launch (`claude --settings <file>`) so the
    user's repo is never touched. Cleaner, but **verify the CLI supports this**
    and that it merges rather than replaces the user's settings.
- **How the helper reaches AIDE.** A curl/HTTP POST to `AIDE_HOOK_URL`, or a
  small bundled binary. Needs to be cheap and non-blocking so it never stalls a
  turn.
- **Does `/branch` fire a hook at all?** Not listed explicitly in the reference.
  The "always trust the latest payload" discipline covers it either way (the
  next `Stop`/`SessionStart` corrects the path), but worth confirming behaviour.

---

## Part 2 — needs-input detection

### How it works today (heuristic on the terminal title)

`detectTitleEvent()` in `claudeCode.ts` sniffs the OSC terminal title. When
Claude finishes and is waiting, it sets the title to a string starting with a
particular glyph (the code checks `codePointAt(0) === 0x2733`, "✳"; historically
this has been described as the "snowflake"). On the transition
non-waiting → waiting, it emits a `completeAndWait` signal via the per-tab
handler registered through `registerSignalHandler()`.

### Why it is bad

- **Glyph/format-dependent.** It keys off one exact code point at the start of
  the title. A CLI change to the indicator, title format, or version breaks it
  silently.
- **Conflates two different states.** "Turn is complete" and "blocked on a
  permission / elicitation prompt that needs a y/n answer" both surface as the
  same title change. Downstream there is no way to tell "Claude is done" from
  "Claude is waiting for *you* to approve something" — which matters a lot for
  any eyes-free / screen-off consumer.
- **No payload.** A title glyph carries no information about *what* is being
  asked.

### The alternative: hooks give the state directly

- `Stop` → turn complete (distinct, structured).
- `Notification` → Claude needs attention; payload has `message` and
  `notification_type`.
- Permission/elicitation-related hooks (see below) → a real "needs input" event
  with context, instead of a glyph.

### Open questions / where to look

The hooks reference lists several events not yet inspected that likely carry the
needs-input taxonomy — **look here before designing this part**:

- `Notification` — confirmed to carry `message` + `notification_type`.
- `PermissionRequest`, `PermissionDenied` — likely the structured "asking to
  approve a tool" signal.
- `Elicitation`, `ElicitationResult` — likely structured prompts for input.
- `MessageDisplay` — **worth a look**: it may carry the rendered assistant
  message text directly. If so, a content consumer could get the answer text
  from the hook itself and skip reading the JSONL transcript entirely. Payload
  contents unverified.
