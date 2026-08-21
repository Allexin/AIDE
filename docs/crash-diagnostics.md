# Crash Diagnostics — Where To Look When AIDE Dies

Start here when AIDE disappears, freezes, or a terminal session dies unexpectedly.

## The one-line answer

```
npm run diagnose
```

It reads the crash trail, reconstructs how every session of the app ended, and
prints the events leading up to each death. If it reports nothing, the rest of
this document explains where else to look and how to tell the failure modes
apart.

## Why this exists

AIDE used to die leaving no evidence at all. The forensic picture was:

- No Windows Error Reporting entry for `electron.exe` or `AIDE.exe`
- No Crashpad minidump (`crashReporter` was never started, so Crashpad never ran)
- No log on disk — the Log Panel lives in renderer memory and dies with the app
- `.aide/session-debug.log` is truncated at every startup, so the next launch
  destroys the evidence of the previous crash

The recorder in `src/main/diagnostics/` closes that gap.

## Reading the failure mode

Two facts localize almost any AIDE crash before you open a single file.

**All windows die together → the main process died.** Every open project is a
`BrowserWindow` inside one shared main process (`openProjects` in
`src/main/index.ts`). Windows cannot die independently of it. If a single window
vanished and the app survived, that is a renderer death instead, and it is
recorded as `render-process-gone`.

**No OS record → not a native fault.** Windows logs an Application Error only
for native faults (access violations and similar). If the app died but Windows
saw nothing, it was an unhandled JavaScript exception, an explicit quit, or an
out-of-memory kill. The analyzer says so explicitly when it detects that
combination.

Do not be alarmed by the process count: one AIDE instance is normally **five**
`electron.exe` processes — main, GPU, network utility, audio utility, plus one
renderer per window. To confirm they belong to a single instance:

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Select-Object ProcessId, ParentProcessId,
    @{n='Type';e={ if($_.CommandLine -match '--type=([a-z-]+)'){$Matches[1]}else{'MAIN'} }}
```

Everything should point at one MAIN pid. Parents pointing at a dead pid mean
genuinely orphaned processes.

## Where the data lives

All paths are under the Electron user-data directory,
`%APPDATA%\aide` on Windows:

| Path | What it holds |
|---|---|
| `diagnostics\events.jsonl` | The event trail — one JSON object per line, appended synchronously |
| `diagnostics\events.prev.jsonl` | Previous trail, kept across one rotation (rotates at 8 MB) |
| `diagnostics\session.json` | Liveness marker for the running session |
| `Crashpad\reports\*.dmp` | Native minidumps, if a native fault did occur |

Nothing is uploaded anywhere; `crashReporter` runs with `uploadToServer: false`.

### How a silent death is detected

A session cannot report its own hard death — by definition nothing ran
afterwards. So `session.json` is written at startup with `cleanExit: false` and
refreshed by a heartbeat every 5 seconds. A clean shutdown flips the flag. If the
**next** startup finds `cleanExit: false`, the previous run never reached its
exit path, and it logs `previous-session-died-hard` with the last heartbeat
timestamp — which brackets the moment of death to within 5 seconds.

This is why the verdict for a crash always appears in the session *after* it, and
why you must **launch AIDE once more after a crash** before the analyzer can
report it.

## Analyzer usage

```bash
npm run diagnose                      # standard report
node scripts/analyze-crashes.mjs --json      # machine-readable
node scripts/analyze-crashes.mjs --limit 50  # more crashes in the listing
node scripts/analyze-crashes.mjs --no-os     # skip the Event Log query (faster)
node scripts/analyze-crashes.mjs --dir <path>   # a trail copied from elsewhere
```

The report has four parts: a session tally, the events preceding each hard
death, fatal signatures grouped by shape with stack frames, and corroboration
from Crashpad and the Windows Application log.

## Event reference

Recorded by `src/main/diagnostics/index.ts`:

| Event | Meaning |
|---|---|
| `session-start` / `session-exit` | App lifecycle, with version and exit reason |
| `previous-session-died-hard` | **The crash verdict** — includes uptime and last-alive time |
| `uncaught-exception` | Unhandled throw in main, with code, message, stack |
| `unhandled-rejection` | Rejected promise nobody caught |
| `render-process-gone` | A window's renderer died — reason and exit code |
| `child-process-gone` | GPU, utility, or helper process died |
| `renderer-unresponsive` / `responsive` | Event loop blocked, then recovered |
| `preload-error` | A preload script threw — that window is broken |
| `pty-spawn` / `pty-exit` | Terminal lifecycle with exit code and signal |
| `hook-server-*`, `remote-*`, `aggregator-*` | Server-level socket failures |
| `memory-sample` | RSS, heap, heap as a percentage of the V8 cap, and pty/IPC traffic since the previous sample |
| `heap-pressure-entered` / `left` | Heap crossed 60% of the cap — sampling tightens to 2s |
| `fs-event-rate` | Watcher events per 10s window, sent and skipped |
| `git-status-slow` | A `git status` over 1s, with the number of entries returned |
| `index-rebuild-start` / `done` / `failed` | File-index rebuilds; `discarded: true` means the result was thrown away |
| `project-opening` | A project is being opened, from any entry point |
| `power-suspend` / `resume` / `shutdown` | Sleep and shutdown, which mimic crashes |

### Memory sampling is adaptive

The baseline interval is 10s, but once the heap crosses 60% of the V8 cap the
recorder switches to 2s and logs `heap-pressure-entered`. A runaway allocation
covers the remaining distance in seconds, and a coarse interval leaves exactly
the final moments — the ones that identify the culprit — unrecorded.

`npm run diagnose` draws the heap trend as a sparkline beneath each crashed
session and flags a final sample far above the preceding trend, which
distinguishes a runaway allocation from a steady leak. A second sparkline shows
terminal throughput on the same time base: if the heap climbs while pty traffic
stays flat, the memory is coming from somewhere other than the terminal.

Once the heap crosses the pressure threshold, samples also carry `spaces` — the
V8 heap spaces holding more than 16 MB. `large_object_space` points at big
buffers or strings, `old_space` at many ordinary retained objects.

### Naming the retainer outright

Run `dev-heap-snapshot.bat` in the project root — it sets `AIDE_HEAP_SNAPSHOT=1`
and starts the dev server. The first time pressure is detected the recorder
writes one `.heapsnapshot` into the diagnostics directory. Open it in Chrome
DevTools under Memory to see exactly what holds the heap.

This is off by default because it is expensive: the file is roughly the size of
the heap and the process is frozen while it is written. Turn it on for a session
you expect to crash.

## Dev-server restarts are not crashes

Under `electron-vite dev`, replacing the source tree — copying a fresh build over
a running one, for instance — makes the dev server terminate the main process and
start a new one. From inside, that is indistinguishable from a crash: the process
never reaches its exit path, so the liveness marker is never flipped.

`session-start` therefore records a fingerprint of the running main bundle
(path, mtime, size). If the session that follows a death carries a *different*
bundle, the analyzer classifies it as `restart` and excludes it from the crash
count. Same bundle means the process really did die on its own.

The practical consequence: **do not copy over a running AIDE_Stable and then read
the crash count.** Copy, let the dev server settle, and treat only same-bundle
deaths as real.

### Uncaught exceptions do not kill the app by default

`FATAL_ON_UNCAUGHT` in `src/main/diagnostics/index.ts` is `false`: an uncaught
exception is recorded and the process keeps running. A stray `'error'` event
from a socket is rarely a reason to lose the whole editor. Set it to `true` to
restore fail-fast behaviour when you want a crash to be unmissable.

The trade-off is real: surviving an exception can leave state inconsistent. If
the app behaves strangely *after* an `uncaught-exception` appears in the trail,
that is the likely reason — restart it.

## The class of bug this was built for

An `'error'` event on a Node `EventEmitter` with **no listener attached** is not
swallowed — it is thrown. In the main process that kills every window at once,
with no OS record. Servers are the usual source, and the trap is subtle: a
listener attached only for the duration of `listen()` and removed on success
leaves the server unguarded for the rest of the app's life.

`src/main/hooks/hookServer.ts` had exactly that shape and now keeps a permanent
`'error'` handler plus a `clientError` handler. `src/main/remote/index.ts` has
the same guards on its own server, its WebSocket servers, and the aggregator.

When adding any new server or long-lived socket to the main process, attach a
permanent `'error'` listener. It is not optional.

## Main-process memory and the file index

The second class of silent death is out-of-memory. V8 aborts on heap exhaustion
without raising a JavaScript exception, so it produces no `uncaught-exception`
entry — only a heap trend that ends abruptly.

The file index is the largest single consumer, and it scales with the project
rather than with anything the user did. Three properties keep it bounded, none
of which depends on recognising particular directory names:

- **One rebuild at a time.** A change arriving mid-build sets a dirty flag, and
  exactly one rebuild follows. Concurrent walks used to be possible, and each one
  that reached `postMessage` deserialised its whole result into the main heap
  before the generation check could discard it.
- **The debounce floor adapts to the measured walk time.** A full walk of a large
  project takes longer than the 500 ms window that triggers it (measured: 1359 ms
  against 135k files, versus 168 ms for 13.6k). Scheduling no sooner than the
  last walk took keeps small projects responsive and makes large ones back off in
  proportion to their own cost.
- **The index stores relative paths only.** The absolute path, the base name and
  the constant `type` field are all derivable, and are reconstructed only for
  entries a query matches. Measured on 135k files: 52 MB of per-file objects
  against roughly 19 MB of path strings.

Watcher events are also coalesced into one IPC message per 50 ms window, with
repeats on the same path collapsed. The renderer-facing `onFsChanged` callback
still fires once per path — the batching is unwrapped in the preload.

If a project is large enough to be a problem, `fs-event-rate`,
`git-status-slow` and `index-rebuild-done` (watch for `discarded: true`) show
which of the three is doing the damage.

### Still open

The index is still rebuilt in full on every change — the mitigations above bound
that work but do not remove it. Replacing it with incremental updates is planned
and specified in [`file-index-incremental-plan.md`](./file-index-incremental-plan.md).

`searchProjectFileIndex` returns every match. A two-character query against a
large project can produce thousands of results, and the whole array crosses IPC
to the renderer. Capping the result count would bound it, at the cost of
silently truncating results.

## If the analyzer finds nothing

Work down this list:

1. **No `diagnostics` directory.** The running build predates the recorder.
   Check `src/main/diagnostics/` exists in the copy you actually launched — a
   snapshot copied before this change will not have it.
2. **Trail exists but no hard deaths.** Every session ended through its normal
   path, so what you are seeing is a *deliberate* quit, not a crash. Look for
   `window-all-closed` and `app-before-quit` in the trail: something is calling
   `app.quit()`.
3. **A crash you just saw is missing.** Launch AIDE once more — the verdict is
   written by the following session.
4. **Native fault suspected.** Check `Crashpad\reports` for a `.dmp`, and:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000; StartTime=(Get-Date).AddDays(-7)} |
  Where-Object { $_.Message -match 'electron|aide' } |
  Select-Object TimeCreated, @{n='M';e={($_.Message -split "`n")[0..2] -join ' | '}}
```

5. **Whole machine froze or rebooted.** Then it was not AIDE:

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddDays(-7)} |
  Where-Object { $_.ProviderName -match 'BugCheck|WHEA|Kernel-Power' }
```

Also check `%WINDIR%\LiveKernelReports` for GPU timeout (TDR) reports.

## Testing a copy

Sessions are keyed by a random id, so trails from different builds can be merged
or inspected separately. To analyze a trail copied off another machine, pass
`--dir`. Note that both a source tree and a copy of it write to the **same**
`%APPDATA%\aide\diagnostics` — they share one user-data directory, and their
sessions interleave in one trail. The `appVersion` field on `session-start` is
what tells them apart.
