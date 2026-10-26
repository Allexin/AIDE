# Timers

A timer must never stand in for an event: "wait N ms, the thing has probably happened by
now" is a race that loses on a slow machine, a loaded disk or a cold start. When code waits
for something, it waits for the signal that the thing happened (a process `exit`, an fs
event, a hook, output from the PTY) and a timer only bounds that wait.

This file lists the timers that remain in the code on purpose and why each is not a race.
A new timer should fit one of these categories; if it does not, it is probably a race.

## Safety limits on event waits

The wait is on an event; the timer only stops it from hanging forever and is reported as a
failure, never treated as success.

| Where | Limit | Waits for | On timeout |
|---|---|---|---|
| `PtyManager.startHealthCheck` (`READY_TIMEOUT_MS`) | 15 s | the CLI's ready/dead signal in its output | verdict `unknown`; a queued prompt is not sent and a line is logged |
| `PtyManager.submitPastedInput` (`ECHO_TIMEOUT_MS`) | 2 s | the CLI rendering a bracketed paste before Enter is sent | logs and submits anyway |
| `PtyManager.closeTabAndWaitExit` (`EXIT_TIMEOUT_MS`) | 5 s | the PTY's `onExit` before a session is resumed again | `pty-restart-exit-timeout` diagnostics event, resume proceeds |
| `toolbar/processManager.forceKill` (`KILL_TIMEOUT_MS`) | 5 s | `taskkill` and the process `exit` | the restart proceeds |
| `pipeline/processRunner` | per call | the child process | process is killed, `process-timeout` event |
| `pipeline/mcp/tools` wait, `pipelineServer` wait | per request | a significant pipeline event | returns a `timeout` result to the caller |

## Debounce

Coalesces a burst of events into one piece of work. The delay is the burst window, not a
guess about when something finishes.

- `filetree/watcher` — git refresh (300 ms) and FS change batches.
- `filetree/fileIndex` — index rebuild; the delay grows with the last build time.
- `toolbar/toolbarWatcher` — toolbar config reload.
- CLI scanners (`codexScanner`, `devinScanner`, `openCodeScanner`, `cursorAgentStoreScanner`) — re-scan after watch events.
- `cliTools/sessionMetaCache` — persisting the cache to disk.
- Renderer file filter (`FileTree`) — search as you type.

## Polling as a fallback for unreliable change notification

`fs.watch` misses events (SQLite WAL files, network drives, a directory that does not exist
yet). Polling here is the backstop, not the primary signal; a late poll costs latency, not
correctness.

- Session scanners poll every 2–5 s alongside their watchers.
- Waiting for a directory or file that does not exist yet (`claudeCodeScanner`,
  `cursorAgentScanner`, `openCodeScanner`, `thinkingWatcher`) — `fs.watch` cannot watch a
  path that is not there. Watching the parent instead would remove this; low priority.

## Periodic work

The interval is the point: heartbeats, sampling, refresh.

- Remote: aggregator heartbeat and registry cleanup; remote page refreshes (tabs, usage, projects).
- `pipelineServer` SSE heartbeat — keeps idle connections alive and reveals dead peers.
- `diagnostics` memory sampling and the crash-log heartbeat.
- `updater` — daily update check.
- Renderer `AccountUsage` — usage refresh, faster while the window has focus.

## Scheduled at a known time

- `pipeline/engine/runner` limit timer — resumes a run when the provider's usage limit resets
  (a timestamp the provider gave us, plus a minute of clock slack).

## Retry pacing

- Remote page WebSocket reconnect — exponential backoff up to 10 s.
- Aggregator port (`remote/index.ts`, `AGGREGATOR_RETRY_*`) — when another process holds the
  port, registration is retried with backoff from 500 ms to 30 s. The other holder may be an
  instance that is not serving yet, or something else entirely, so there is no event to wait for.
- `pipeline/engine/runner` unavailable-CLI retry (`UNAVAILABLE_RETRY_MS`, `UNAVAILABLE_WINDOW_MS`) —
  a step whose CLI failed because the service is unavailable (model at capacity, overloaded,
  network) is retried every minute; 20 minutes after the first failure the orchestrator gets an
  engine escalation. Nothing announces that the service is back, so the attempt is the probe.

## UI durations

How long something stays on screen is a design choice, not a synchronisation.

- Toasts, "Copied" / "Saved" confirmations, attention blinking (500 ms), elapsed-time ticks (1 s).
- Session Picker hover delay before loading a preview — avoids flicker on fast mouse-overs.
- Remote page long-press (550 ms) — the gesture's definition.
- `EditorPanel.useDialogCooldown` — ignores input for a moment after a dialog opens so a key
  pressed for the editor does not answer the dialog.
- `utils/sound` — closes the audio context after the last note has played.

## Known heuristics, kept for lack of a signal

- **Inactivity as "waiting for input"** — Qwen Code, OpenCode, Devin and Cursor Agent emit
  `completeAndWait` after 5 s without PTY output. These CLIs give no other signal that a turn
  has ended. Replace per CLI when it gains hooks (as Claude Code and Devin's session binding have).
- **Startup health markers** — `checkStartupHealth` in Cursor Agent accepts any ANSI escape
  (`\x1b[`) as "ready". ConPTY and PowerShell emit escape sequences before the CLI starts, so
  `ok` can come early. Not a timer, but the same kind of guess. Codex and OpenCode use the
  TUI-specific marker (`tuiReadyForInput`: alternate screen entered, then the cursor shown).
