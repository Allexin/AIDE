# Task tracker — implementation of build steps 2 and 4

Status: §1–§7 (shared types, file format, store, service, MCP tools, tab binding, snapshot, orientation
and tails) are implemented; §8 (the Tasks tab) is not. The `by` of an agent uses the number of its tab id
(`tab-3` → `allex/tab 3`): the tab strip shows titles, not numbers. Choices the §6–§7 implementation made
are noted at the end of those sections.

The concept is `docs/task-tracker-spec.md`; read it first, §The task, §Current task, §Context delivery,
§Storage and §MCP tools in particular. This document turns build steps 2 (storage, schema, tools,
views) and 4 (tab binding, snapshot, orientation) into code. Drift, close candidates and the
Documenter (steps 5–7) are **not** part of this work: where a field or tool depends on them, it is
stored or stubbed as said below and nothing more.

Follow the existing plan code as the model for structure and style: `src/main/pipeline/plan/`
(`planFile.ts` validation and serialisation, `planStore.ts` disk access, `planService.ts` the service),
`src/main/pipeline/mcp/planTools.ts` (MCP tools), `src/renderer/src/components/pipeline/PlanView.tsx`
and `src/renderer/src/store/usePlanStore.ts` (UI). Project conventions in `CLAUDE.md` apply (English UI
text, `logManager` in the renderer, `logEvent` in main, no timers in place of events, the preload
interface kept in sync in three places).

## 1. Shared types — `src/shared/task.ts`

```ts
export type TaskStatus = 'backlog' | 'planned' | 'active' | 'blocked' | 'done' | 'cancelled'

export interface TaskFile {
  id: string                       // slug: [a-z0-9][a-z0-9-]{0,63}
  title: string
  status: TaskStatus
  rank: number | null              // order among planned/backlog; fractional, smaller first
  tags: string[]
  docs: string[]                   // project-relative paths, optional #anchor
  code: string[]                   // globs relative to the project root
  reason: string | null            // blocked / cancelled
  blockedFrom: TaskStatus | null   // status to return to on unblock
  label: string | null
  claim: string | null
  decidedAgainst: string | null
  reopened: boolean
  history: { at: string; by: string | null; reason: string } | null
  confirmed: { at: string; by: 'close' | 'documenter' | 'user' | 'migration'; files: Record<string, string> } | null
  acknowledged: { at: string; by: string; kind: 'keep' | 'restore'; note: string } | null
  check: { at: string; result: 'ok' | 'suspect'; note: string } | null
  source: string | null
  activeBy: string[]
  created: string                  // ISO
  closed: string | null
  description: string              // Markdown body section "## Description"
  journal: string[]                // lines of section "## Journal", without the leading "- "
}
```

`confirmed`, `acknowledged` and `check` are stored and preserved by every write, but nothing in this
work computes them (drift is step 5). A migrated claim is written with `confirmed: null`.

## 2. File format — `src/main/tasks/taskFile.ts`

- Path: `<project>/aide/tasks/<id>.md`. Front matter between `---` lines, YAML, then the body with two
  sections, `## Description` and `## Journal` (each journal line `- <text>`).
- Use the `yaml` npm package (add it to `dependencies`) to parse and stringify the front matter. Keys
  are written in the order of `TaskFile` above; `description` and `journal` are not front-matter keys.
- `parseTask(text, fileName): { task: TaskFile } | { errors: string[] }` validates every field (types,
  enums, slug, `id` equal to the file name, `rank` only for backlog/planned, `claim` and `label`
  together, `history` only on done/cancelled). Unknown keys are an error, so a typo is not lost
  silently.
- `serializeTask(task): string` is the inverse; `parseTask(serializeTask(t))` round-trips exactly.
- `revisionOf(text): string` — the first 12 hex chars of SHA-256 of the file's bytes. Revision is never
  stored in the file (spec §Storage).
- A hand-written file may leave out every key but `id`, `title`, `status` and `created`; the others
  read as their empty value (`null`, `[]`, `false`). The description is stored without surrounding
  blank lines and trailing whitespace; it is everything between the first `## Description` line and
  the last `## Journal` line, so it may hold headings of its own. Non-blank text before
  `## Description`, and a journal line not starting with `- `, are errors (they would be lost).
- Unit tests: round trip, every validation error, CRLF input, a hand-edited file with extra blank lines.

## 3. Store — `src/main/tasks/taskStore.ts`

`class TaskStore(projectPath, userDir)` where `userDir` is `.aide/users/<user>/tasks`.

- `list(): { id, file, task | null, revision | null, error | null }[]` — every `*.md` in `aide/tasks/`,
  reading the files each time (as `PlanStore` does: a hand edit or another AIDE on a shared folder is
  seen at once).
- `read(id)`, `exists(id)`.
- `write(changes: { task: TaskFile; baseRevision: string | null }[])` — the only write path:
  1. For each change, read the current file; if `baseRevision` does not match its revision (or the file
     exists when `baseRevision` is null), throw a conflict error naming every changed task. Nothing is
     written.
  2. Take the write lease (below), write each file atomically (temp file + rename), the last change of
     the array last, release the lease.
  3. Return the new revisions.
- **Write lease** — `aide/tasks/.write-lock`, JSON `{ user, host, pid, expires, token }` (`token`
  tells two writers of one process apart when a takeover is confirmed; a lease file that cannot be
  read expires by its mtime). Taken by creating the
  file exclusively (`wx`); if it exists and `expires` is in the past, it is replaced (re-read after
  writing to confirm ownership). Expiry is 10 s ahead; a write never takes that long, so no renewal is
  needed in this step. If the lease is held and not expired, retry on the lease file's change (fs
  watch) bounded by its expiry — no polling sleeps. A writer that has waited 30 s in total (others keep taking the
  lease) gives up with an error naming the holder. Revisions are checked before the lease and again
  under it; a current file that is invalid is not overwritten.
- **Load check** — `problems(): { kind: 'duplicate-id' | 'invalid' | 'dangling-history', ids, message }[]`:
  files whose front-matter `id` repeats, invalid files, a task in history whose `history.by` names a
  task that is not closed.
- `config()` — `aide/tasks/config.json`, missing file means defaults; in this step it holds only
  `{ "snapshotLabelBudget": 12000 }` (characters).
- `aide/tasks/` is never staged by AIDE and is excluded like `aide/plans/`: extend `isPlanPath` users
  (run diff, commit coverage, dirty-tree warning, shadow snapshot) with an `isTrackerPath` helper.
- Unit tests with a temp directory: conflict refuses all, ordered writes, lease held/expired, problems.

## 4. Service — `src/main/tasks/taskService.ts`

One instance per project, created where `PlanService` is created, given the user name and a way to
notify the renderer (IPC `tasks:changed` with the project path) after every write and when the
`aide/tasks/` directory changes on disk (the existing FS watcher skips dot paths; `aide/` is not one, so
subscribe to its events for that directory).

Operations (each validates, applies, writes through `TaskStore.write`):

- `create(fields, by)` — id from `fields.id` or generated from the title (slug, de-duplicated with
  `-2`, `-3`…); status `backlog` unless given (`backlog` or `planned` only); `created` now; journal line
  `created by <by>`.
- `update(id, baseRevision, fields, by)` — title, description, tags, docs, code, rank, reason; status
  transitions: backlog↔planned, any of backlog/planned/active → blocked (records `blockedFrom`),
  blocked → `blockedFrom`, active → planned (pause; clears the tab bindings of that task). Other status
  changes are refused with the rule.
- `note(id, text, by)` — appends a journal line `YYYY-MM-DD <by>: <text>`.
- `start(id, tabId, user)` — status `active`, adds `user` to `activeBy`, binds the tab (§6).
- `closeSimple(id, baseRevision, { outcome, label?, claim?, code?, decidedAgainst?, supersedes? }, by)` —
  **interim close for this step**, without candidates or drift: sets status, claim, `closed`; moves
  superseded tasks to history with `by` = this id; a task without claim and without `decidedAgainst`
  goes to history itself. It is replaced by the full close in step 6; the tool says so in its
  description.
- `reopen(id, reason, by)`, `toHistory(id, reason, by)`, `restore(id, by)`.
- `search({ query?, status?, tags?, history? })` — case-insensitive substring match over id, title,
  label, claim, tags, description; history excluded unless `history: true`; returns
  `{ id, title, status, label, claimFirstLine, tags }[]`, at most 50, planned by rank first.
- `get(id)` — the task, its revision, its claim chain (follow `history.by` backwards and forwards),
  the tabs bound to it, the plans that list it in `solves` (empty until step 8).

`by` is `"<user>/tab <n>"` for an agent (tab number as shown in the tab strip) or `"<user>"` for the UI.

Details the implementation fixed: `create` takes `label`/`claim` only with `status: "done"` (migration);
blocking needs a `reason`, unblocking clears it; `activeBy` is cleared when the task is paused or closed
and kept while it is blocked; status changes, closes, supersedes, reopen, history moves and restores
each write a journal line; only a closed task can be superseded; a search hit also carries `history`
(true for a task in history); `get` returns the chain as `{ earlier, later }`, the oldest first.

## 5. MCP tools — `src/main/pipeline/mcp/taskTools.ts`

Registered next to `planTools.ts` on the same server. Every write tool requires `context.tabId` to name
a live tab of this AIDE; otherwise it fails with "Writing to the tracker needs an AIDE terminal tab;
this session can read only." Read tools work without a tab.

| Tool | Args | Notes |
|---|---|---|
| `task_guide` | — | Returns `resources/docs/task-guide.md` (write it: the agent-facing rules from the spec — boundaries, granularity, claims and labels, `code` globs naming where the feature lives, closing, decided against, never a TODO in a file). |
| `task_snapshot` | — | §7 |
| `task_search` | query?, status?, tags?, history? | |
| `task_get` | id | |
| `task_create` | id?, title, description?, tags?, docs?, code?, status?, rank?, label?, claim?, source? | `label`/`claim` allowed at creation for migration: such a task is created `done` with `confirmed: null` when `status: "done"` is passed |
| `task_update` | id, baseRevision, fields | |
| `task_start` | id | binds the calling tab |
| `task_note` | id, text | |
| `task_close` | id, baseRevision, outcome, label?, claim?, code?, decidedAgainst?, supersedes? | the interim close |
| `task_reopen` | id, reason | |
| `task_to_history` / `task_restore` | id, reason? | |

Results are short text or compact JSON as the plan tools do. Every result of a **task** tool ends with
the tail of §7 when there is something new for this tab; the tail is added to plan and pipeline tool
results too (one helper used by all three tool sets).

Tests: `taskTools` with a fake context — write refused without a tab, round trips of each tool,
`baseRevision` conflict text.

## 6. Tab binding

- `.aide/users/<user>/tasks/bindings.json`: `{ "<tabId>": { "task": "<id>", "since": "<ISO>" } }`.
- Set by `start`; removed when the tab closes (hook into the PTY manager's tab-close path), when the task
  leaves `active`, when the same tab starts another task.
- On a shared folder, `TaskService` reads every `.aide/users/*/tasks/bindings.json` to know which tasks
  are worked on by whom; a binding whose tab does not exist in this AIDE belongs to another user or
  host and is shown as theirs.
- The terminal tab shows its current task: a small label after the tab title (`· <task title>`, cut to
  30 chars) and "no task" in the tab's tooltip when none. Renderer gets bindings with the task list.

As implemented (`src/main/tasks/taskBindings.ts`, `TaskService.bindings`):

- Each binding also records `user`, `host` and `pid` (the AIDE process). Readers take the user from the
  entry, never from the directory name (`.aide/users/` names are `DOMAIN.user--hash`), and the user is
  the same one recorded in `activeBy`. Tab ids restart at `tab-1` in every AIDE process, so a binding of
  this user on this host counts only when its `pid` is this process and the tab is open
  (`liveTab`); the left-overs of a crashed or earlier process are ignored and dropped by the next bind.
  A binding of this user on another host is shown as `<user> on <host>`.
- A binding counts only while its task is `active` (and not in history), so a paused or closed task
  loses the bindings of every user at once; this user's own entries are also removed from the file.
- Closing a window removes the bindings of all its tabs, as closing each tab does
  (`PtyManager.onTabClosed`).
- `start` writes a journal line `<by>: started` (with the status change when there is one), so the tail
  can say who started a task; it sends one `tasks:changed` per call.
- The renderer reads the tabs' tasks through `tasks:tab-tasks` (`useTaskStore`) and reads again on
  `tasks:changed`; the Tasks tab (§8) will add the task list next to it.

## 7. Snapshot, orientation and tails

**Orientation** — extend `serverInstructions()` in `src/main/pipeline/mcp/tools.ts` with a tracker
part, **at most 2,500 characters in total including the rule**, rule first so a cut never removes it:

```
Task tracker (task_* tools): the project's state — what is in it, what we do, what we decided not to do.
Call task_snapshot before you start work. A work item goes to task_create, never into a TODO in a file;
a task is what the user would ask about a week later, anything needed only for the current work belongs
in a plan. Rules: task_guide.
Tags (claims): terminal 12, pipeline 31, … Planned next: <title>; <title>; … (as of session start)
```

It is computed at every `initialize` (the instructions are already a function). A project with no
`aide/tasks/` gets only the first three sentences.

**`task_snapshot`** returns text in this order (spec §Context delivery), within
`snapshotLabelBudget` for section 0:

0. Claims as labels grouped by tag (a task with several tags is listed under its first), reopened marked
   `(reopened)`, unverified marked `(unverified)` (`confirmed: null`); decided against as labels.
   Over budget: keep whole tags in this order — tags of active tasks, tags of the first 5 planned tasks,
   tags by most recent `closed`; the rest as `tag (N claims)`; end with "N claims left out — task_search".
1. This tab's current task: title, id, description (first 600 chars), last 5 journal lines, docs.
2. Problems: load-check problems; stale actives (active, bound to no tab anywhere and no plan run, or
   not changed for 7 days). Drift problems join in step 5.
3. Active tasks with who works on them; blocked with reasons.
4. Tasks closed or moved to history in the last 7 days.

**Tail** — per connection (tab), AIDE remembers the time it last returned a tail; a later tool result
gets, when anything changed since, one block:

```
— tracker since your last call: task X closed by allex/tab 2; task Y started by bob; 1 new problem (task_snapshot).
```

At most 5 items, then "and N more". Nothing when nothing changed.

As implemented (`src/main/tasks/taskSnapshot.ts`, `taskTail.ts`, `withTrackerTail` in
`src/main/pipeline/mcp/taskTools.ts`):

- The orientation is a paragraph of its own between the pipeline/plan sentences and the work instruction.
  With a tracker the rule ends with "Rules: task_guide."; without one it is the three rule sentences
  only. The instructions function receives the connection (`RequestContext`), and `initialize` also
  starts that connection's tail.
- Section 0 keeps tags up to the first that does not fit (in the priority order), reserving room for the
  "Other tags" line and the count, so the section stays within the budget. Decided-against tasks are
  listed in their tag as `<label> (decided against)`. An invalid `config.json` falls back to the default
  budget and is listed under problems.
- "No plan run" for stale actives is read as "no pipeline run of the project is going": plans do not
  name their tasks until `solves` (step 8).
- The tail is kept per MCP connection (the shim process, one per agent session). A change event (a write
  or the FS watcher) only marks the project for a new reading; the tail compares task revisions and
  problem keys between readings, so the watcher's echo of a write adds nothing and changes made by
  another AIDE are seen. `by` comes from the task's last journal line; items made by the connection's
  own tab are left out. A connection's first call starts its tail from that moment; `task_snapshot`
  counts as seen and carries no tail.

## 8. UI — the Tasks tab

Placement: a **Tasks** tab button in the terminal panel's tab strip, next to the Pipeline tab button,
shown when the project has `aide/tasks/` or always from a menu entry "Show tasks" (decide by what the
pipeline tab does: mirror it). The view (`src/renderer/src/components/tasks/TasksView.tsx`, store
`useTaskStore.ts`, IPC `tasks:list`, `tasks:get`, `tasks:create`, `tasks:update`, `tasks:changed`):

- Left: sections **Now** (problems, active with tabs/users, blocked), **Planned** (by rank, drag to
  reorder writes fractional `rank`), **Backlog**, **Project** (claims by label grouped by tag; unverified
  and reopened marked), **Decided against**, and a search box over everything including history
  (a toggle "include history").
- Right: the task card — title, status, label and claim, description (Markdown), journal, docs (click
  opens the file in the editor), code globs, tabs working on it; actions: start is not offered in the UI
  (tabs start tasks), but pause, block/unblock, move to planned/backlog, to history, restore, and quick
  edits of title/tags/description are.
- Quick add at the top of Planned and Backlog: a title field; Enter creates the task with a generated id.
- All text in English. Use the look of `PlanView.tsx` (fonts, colours, spacing).

## 9. Not in this work

Fingerprints, drift states, candidates and the full close (`answers`, `mechanical`, `globs`, `dryRun`),
`task_acknowledge`, `task_amend_claim(s)`, proposals, the Documenter, `solves` on plans, the remote page.
