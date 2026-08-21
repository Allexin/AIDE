# Codex SQL Session Migration Plan

## Status

Proposed implementation plan.

This document records the decision to replace AIDE's Codex JSONL session
integration with the SQL-backed Codex app-server protocol. It covers session
listing, history, status, binding, live updates, usage data, and removal of
Smart Compact.

## Decision

AIDE will stop reading, scanning, watching, parsing, and modifying Codex
rollout JSONL files.

The Codex app-server v2 protocol will be the only AIDE integration surface for
persisted Codex session data and lifecycle events. Requests that list threads
must use the state-database-only mode. Paginated thread history will be read
through app-server history methods backed by Codex's history database.

AIDE will not open `state_N.sqlite` or `thread_history_N.sqlite` directly. The
databases and their schemas are internal and versioned; app-server is the
stable facade over them. This still gives AIDE a SQL-only data path while
avoiding dependencies on database filenames, migrations, WAL details, and
private table schemas.

There will be no JSONL compatibility fallback. If the installed Codex version
does not provide the required app-server v2 capabilities, AIDE will report the
Codex integration as unsupported and ask the user to update Codex.

## Why We Are Doing This

The current Codex scanner treats every rollout whose `session_meta.cwd`
matches the project as a picker session. That creates several problems:

- subagent and guardian rollouts appear beside user sessions;
- related threads can appear as separate sessions after compaction or
  branching;
- listing requires walking the complete `~/.codex/sessions` tree;
- preview and history code must understand an evolving rollout format;
- file watching is used as an indirect session lifecycle protocol;
- live binding depends on timing, directory scans, and fallback heuristics;
- reading large transcripts has previously caused excessive main-process
  memory use;
- AIDE's Smart Compact modifies storage owned by another application.

Codex already maintains the information AIDE needs in its state and history
databases and exposes it through app-server:

- interactive versus subagent source kinds;
- logical `sessionId` and concrete thread ID;
- cwd, title, preview, creation time, update time, and archive state;
- cursor-based listing;
- turn history and normalized thread items;
- active, idle, waiting, and error state;
- thread, turn, history-item, compaction, and archive notifications.

Using that model removes duplicate parsers and lets Codex remain the authority
for its own storage.

## Confirmed Codex Capabilities

The plan targets the app-server v2 contract present in Codex CLI 0.148.0.
Implementation must capability-check methods and fields during initialization
rather than compare a hard-coded version string.

Required request methods:

- `initialize`
- `thread/list`
- `thread/read`
- `thread/turns/list`
- `thread/loaded/list`
- `thread/resume` where appropriate
- the account rate-limit read method exposed by the installed protocol

Required notifications:

- `thread/started`
- `thread/status/changed`
- `thread/archived`
- `thread/unarchived`
- `turn/started`
- `turn/completed`
- thread-item started, updated, and completed notifications needed by history
  and thinking UI
- context compaction notification
- account rate-limit update notification

The exact generated TypeScript protocol bindings should be produced during
development from the installed or minimum-supported Codex binary. Generated
bindings should be checked in only if we decide to pin the protocol snapshot;
runtime messages must still be validated defensively.

## Session Identity

Codex exposes two identifiers with different meanings:

- `thread.id` identifies a concrete thread and is the value used for resume;
- `thread.sessionId` identifies the logical session tree shared by related
  threads.

AIDE currently assumes one rollout ID equals one user-visible session. That
assumption must be removed.

The picker will contain one row per logical `sessionId`. When several eligible
threads share a `sessionId`, AIDE selects the most recent interactive thread as
the resumable thread and keeps the other thread IDs internal. This prevents
compaction or related session-tree transitions from producing duplicate rows.

Open terminal tabs remain bound to a concrete thread ID. The picker row is
considered open when any currently open tab is bound to its selected thread or
another thread in the same logical session tree.

## Which Threads Are Visible

The picker query must:

- set `useStateDbOnly: true`;
- filter by the normalized project cwd;
- request non-archived threads only;
- sort by `recency_at` descending;
- use the opaque cursor returned by app-server;
- request only interactive source kinds.

Expected interactive source kinds include `cli`, `vscode`, and `appServer`.
The final allowlist should include only sources AIDE can resume correctly.

The following sources must not appear as top-level picker rows:

- `subAgent`
- `subAgentReview`
- `subAgentCompact`
- `subAgentThreadSpawn`
- `subAgentOther`
- `exec`, unless non-interactive sessions are deliberately added as a separate
  feature later

Do not infer source from titles, messages, timestamps, or rollout filenames.

## Legacy Threads

The SQL state database contains metadata for both legacy and paginated
threads, so legacy threads can still be listed and resumed without AIDE reading
their rollout files.

The limitation applies to history, not resume:

- AIDE can show a legacy row using SQL-backed thread metadata;
- AIDE can run `codex resume <thread-id>` for that row;
- Codex remains responsible for loading or migrating the legacy rollout;
- AIDE cannot show preview messages or full history when app-server has no
  persisted paginated history for the thread;
- the History action should be disabled or show an English explanation such as
  `History becomes available after this session is resumed by Codex.`

This is an accepted trade-off. We prefer one clean SQL-backed implementation
over maintaining a second parser for old sessions. Users can always resume a
legacy thread in Codex, including directly with `codex resume <thread-id>`.

Implementation must verify whether resuming a legacy thread causes Codex to
project or migrate it into paginated history. If it does, AIDE should refresh
the row when the corresponding event arrives and enable History without an app
restart.

## User-Visible State Model

AIDE should not collapse process state, thread state, and turn state into one
ambiguous boolean.

Use the following model:

| AIDE state | Source | Meaning |
| --- | --- | --- |
| `running` | AIDE PTY registry | A live terminal tab owns this concrete thread |
| `active` | app-server thread status | Codex is processing a turn |
| `waitingOnApproval` | active flag | Codex is waiting for approval |
| `waitingOnUserInput` | active flag | Codex is waiting for structured user input |
| `idle` | app-server thread status | Thread is loaded but has no active turn |
| `notLoaded` | app-server thread status | Thread is persisted but not loaded in app-server memory |
| `systemError` | app-server thread status | The loaded thread encountered a system error |
| `archived` | thread metadata/event | Thread is hidden from the default picker |

PTY ownership remains authoritative for whether an AIDE terminal is open.
App-server state remains authoritative for what Codex is doing. A stale
`inProgress` row in persisted turn history must not by itself be displayed as a
currently running process.

## Event-Based Session Binding

### Goal

Bind a newly launched or resumed Codex TUI to its AIDE tab without scanning the
session directory, polling SQLite, comparing mtimes, or walking the OS process
tree.

### Required correlation

`thread/started` alone is insufficient when two tabs start concurrently: cwd
and timestamp do not identify the owning tab. Every launch therefore needs an
AIDE-generated correlation token.

For each Codex tab AIDE will generate and retain:

- `tabId`;
- a random launch token;
- the expected operation: new or resume;
- the expected thread ID for resume;
- a creation deadline.

The token must be passed into the Codex process environment. The preferred
binding mechanism is a native Codex `SessionStart` hook that posts the Codex
thread/session identity plus the inherited AIDE token to AIDE's existing hook
server. The hook request is authenticated with the existing per-launch hook
secret.

The binding flow is:

1. AIDE registers the pending launch before writing the command to the PTY.
2. Codex starts or resumes the thread.
3. The Codex session-start hook sends the thread ID, logical session ID, cwd,
   and AIDE launch token to the hook server.
4. The hook server validates the secret and resolves the exact pending tab.
5. `PtyManager` binds the concrete thread ID and logical session ID to the tab.
6. AIDE subscribes to app-server events for that thread and clears the pending
   launch.
7. If no valid event arrives before the deadline, startup health fails with a
   diagnostic message; AIDE does not guess another tab.

Before implementation, run a focused compatibility spike to confirm the
installed Codex hook payload and configuration syntax. Also test whether a
shared app-server daemon emits `thread/started` for a separately launched TUI.
If it carries the launch token and is sufficient for exact correlation, the
extra hook callback may be omitted. If it does not, the authenticated
`SessionStart` hook is mandatory.

No sole-waiting-tab, newest-thread, mtime, PID-owner, or cwd-only fallback is
allowed for Codex after this migration. A visible startup failure is safer than
binding the wrong conversation.

### Resume binding

For resume, AIDE already knows the concrete thread ID. The event must confirm
that ID before the tab is bound. A mismatch is treated as startup failure.

### Rebinding and compaction

Context compaction is an event inside a logical session, not a new picker
session. A compaction notification refreshes status/history but does not create
a tab or picker row. If Codex changes the concrete thread while preserving the
logical `sessionId`, the lifecycle event updates the tab's concrete thread ID
atomically.

## App-Server Connection Ownership

Create one long-lived Codex app-server client in the Electron main process,
shared by all project windows. It should:

- start or connect lazily when Codex is activated;
- perform one initialize handshake;
- parse JSON-RPC incrementally;
- multiplex requests by request ID;
- fan notifications out by thread ID and project cwd;
- restart with bounded exponential backoff;
- reject pending requests when the connection dies;
- re-query open projects after reconnection;
- attach permanent process/stream error handlers;
- write lifecycle failures to main-process diagnostics.

Renderer processes must never access Codex databases or app-server directly.

## Session Catalog Changes

Introduce a richer Codex session DTO while keeping generic CLI tools isolated:

```ts
interface CodexSessionEntry {
  sessionId: string
  threadId: string
  title: string
  preview: string
  cwd: string
  createdAt: number
  updatedAt: number
  recencyAt: number
  historyAvailable: boolean
  archived: boolean
  status: CodexThreadStatus
}
```

Do not force non-Codex tools to implement Codex concepts. Either extend
`CliSession` with optional generic fields or add a tool-specific paged catalog
capability.

The existing IPC handler scans every activated tool completely and paginates
only after merging. Add a paged tool capability so the Codex adapter can pass
the app-server cursor through instead of loading all threads first. If a mixed
multi-tool globally sorted list must be retained, define a merge cursor rather
than reverting Codex to an unbounded scan.

The desktop picker and remote `/api/sessions` endpoint must consume the same
catalog service so filtering and deduplication cannot diverge.

## History and Thinking UI

Replace Codex JSONL history parsing with normalized app-server thread items.

- Initial history comes from `thread/read` or `thread/turns/list`.
- Additional pages use app-server cursors.
- Live additions and updates come from thread-item and turn notifications.
- Reasoning items feed the existing thinking UI.
- User and agent messages feed preview and history UI.
- Tool calls and outputs map to existing `HistoryBlock` types where possible.
- Unknown future item types are ignored safely and recorded in diagnostics at
  a rate-limited level.

Remove the Codex dependency on `getSessionFilePath`, file offsets, `fs.watch`,
and five-second history polling. The generic ThinkingWatcher should use
`subscribeToSessionHistory` for Codex and retain file watching only for tools
that still require it.

History availability must come from the protocol response, not from checking
whether a rollout file exists.

## Usage and Rate Limits

`codexUsage.ts` currently scans rollout tails for rate-limit records. That is a
JSONL dependency and must be removed as part of this migration.

Use the app-server account rate-limit read request for the initial value and
the rate-limit update notification for refreshes. Preserve the existing cache
only as a short-lived UI resilience cache; it must not be populated by rollout
scanning.

## Remove Smart Compact

Smart Compact is out of scope for the new storage architecture and will be
removed, not ported.

Remove:

- the Codex `smartCompact` capability;
- Smart Compact IPC handlers and preload APIs;
- terminal dialog and renderer state;
- `SmartCompactCapability` and related generic types if no other tool uses
  them;
- `smartCompactJsonl.ts` if it becomes unused;
- Smart Compact documentation and settings references.

Native Codex compaction continues to work and is observed only through the
context compaction notification.

## Code Removal

After the SQL-backed path is complete, remove Codex-specific JSONL code from
`codexScanner.ts`, including:

- recursive rollout discovery;
- metadata head/tail reads;
- session metadata cache use;
- synchronous ID scans;
- rollout-file lookup;
- preview and history JSONL parsers;
- session-directory watcher;
- session-file watcher and polling;
- Codex thinking-line parser.

Do not delete shared cache or watcher code still used by Claude Code or another
CLI tool.

## Delivery Phases

### Phase 0: Compatibility spike

- Generate app-server v2 bindings from the minimum-supported Codex build.
- Confirm `thread/list` with `useStateDbOnly: true` returns both legacy and
  paginated metadata without rollout repair.
- Confirm logical `sessionId` behavior for normal turns, compact, fork, and
  resume.
- Confirm history methods do not silently read legacy JSONL when SQL history is
  absent.
- Confirm app-server notification visibility for a separately launched TUI.
- Confirm `SessionStart` hook payload, environment inheritance, authentication,
  and concurrent-launch behavior.
- Record the minimum supported capability set.

Stop the migration if deterministic event binding cannot be achieved. Do not
replace it with polling heuristics.

### Phase 1: App-server client

- Add the main-process JSON-RPC client and capability negotiation.
- Add typed request/notification decoding.
- Add reconnection, diagnostics, and shutdown handling.
- Add tests with a fake stdio app-server.

### Phase 2: SQL-backed catalog

- Implement state-DB-only thread listing.
- Filter subagents and archived threads.
- Group by logical `sessionId`.
- Implement cursor pagination and project-path normalization.
- Route desktop and remote session lists through the same service.
- Keep existing JSONL code temporarily behind an internal comparison flag only
  for development; never use it as a production fallback.

### Phase 3: Event binding and status

- Add the authenticated launch correlation registry.
- Add the Codex session-start hook or verified equivalent event.
- Replace Codex session-directory watching and assignment heuristics.
- Drive status from thread and turn notifications.
- Reconcile active tabs after app-server reconnect.

### Phase 4: SQL-backed history

- Implement paginated history mapping.
- Implement live item updates and thinking subscriptions.
- Add the legacy-history unavailable state.
- Remove Codex rollout history and preview reads.

### Phase 5: Usage and cleanup

- Replace rollout usage scanning with app-server rate-limit APIs.
- Remove Smart Compact.
- Remove remaining Codex JSONL scanner/watcher/parser code.
- Remove dead IPC/preload/renderer APIs.
- Update architecture documentation.

### Phase 6: Remove comparison code

- Run one release cycle with diagnostics for catalog mismatches and event
  failures.
- Delete the development-only comparison flag and old scanner implementation.
- Keep no JSONL fallback in the release path.

## Failure Behavior

Failures must be explicit and bounded:

- unsupported Codex: show an update-required message;
- app-server unavailable: disable Codex session listing and new/resume actions;
- app-server reconnecting: retain existing UI rows as stale and disable
  mutations until reconciliation completes;
- missing SQL history: keep resume enabled and mark History unavailable;
- event binding timeout: keep the tab unbound, report startup failure, and
  allow the user to close or retry it;
- malformed future protocol item: ignore only that item, not the whole thread.

AIDE must never fall back to scanning rollout files after an app-server error.
Otherwise the application would silently retain two competing sources of
truth.

## Validation Matrix

Automated and manual validation must cover:

- new session in one tab;
- two simultaneous new sessions;
- simultaneous new and resume;
- resume of a paginated thread;
- resume of a legacy thread;
- missing history for a legacy thread;
- legacy thread becoming paginated after resume, if Codex supports it;
- manual and automatic native compaction;
- fork/branch behavior and logical-session deduplication;
- guardian and spawned subagents excluded from the picker;
- nested subagents excluded;
- archive and unarchive;
- active, idle, approval-waiting, input-waiting, error, and not-loaded states;
- interrupted and failed turns;
- app-server crash and reconnect;
- Codex TUI exit before session-start event;
- AIDE restart with saved open tabs;
- remote session listing and resume;
- projects whose paths differ only by `\\?\` prefix, slash direction, case, or
  trailing separator;
- large session catalogs with cursor pagination;
- no reads below `~/.codex/sessions` during normal AIDE operation.

## Acceptance Criteria

The migration is complete when:

- no production Codex code enumerates or reads `~/.codex/sessions`;
- no production Codex code watches rollout files or directories;
- no AIDE code modifies Codex-owned session storage;
- the picker contains only eligible interactive logical sessions;
- compact and subagents do not create duplicate picker rows;
- new and resumed sessions bind deterministically under concurrency;
- status updates arrive without filesystem or database polling;
- paginated history and thinking update live from protocol events;
- legacy sessions remain listable and resumable, with history explicitly
  unavailable when absent from SQL;
- usage information no longer comes from rollout tails;
- desktop and remote lists return the same sessions;
- Smart Compact and all associated UI/API code are removed;
- app-server failures never activate a JSONL fallback.

## Consequences

The main benefit is one authoritative model instead of two partially matching
implementations. AIDE becomes smaller, avoids expensive transcript scans, and
can represent Codex state accurately.

The deliberate cost is loss of AIDE-rendered history for legacy threads that
have not been projected into Codex's SQL history. Their metadata and resume
path remain available. This cost is temporary for users who resume or migrate
those threads and is preferable to carrying legacy JSONL parsing indefinitely.
