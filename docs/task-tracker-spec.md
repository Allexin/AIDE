# Task tracker and Documenter

Draft, 2026-11-20, fifth revision (after four reviews). Implemented so far: the task file format
and the store of build step 2 (`src/shared/task.ts`, `src/main/tasks/`; see
`docs/task-tracker-implementation.md` §1–§3); the service, tools and views are not. The concept is
settled; the details of drift are to be tuned on data from shadow mode (§Scope, build order step 5).

## Problem

Agents keep project state in files because a file is the only durable memory they have and writing
one is the cheapest thing they can do. State spreads over `STAGES.md`, `PLAN.md`, "Status:" lines in
specs, "Planned rework" in `CLAUDE.md`, TODO sections in research notes and the agent's own memory.
Each copy is a status glued to prose that nobody updates, so the project's context grows, repeats
itself and goes stale. The user cannot see what is going on without guessing which file holds it.

Documentation goes stale for the same reason: updating it is part of nobody's workflow. A periodic
"bring the docs up to date" pass helps, but it has to reconstruct afterwards what the agent that made
the change knew at the moment of the change, it cannot tell "outdated" from "planned" from "a bug",
and it does not see what was removed.

## Idea

The tracker is **the snapshot of the project's state, current and planned**: one place that answers
"what are we doing" and "what is in the project now". Its visible content is the state; whatever is
no longer true leaves view and goes to history. Keeping it true is part of closing work, when the
knowledge is at hand. AIDE watches the code under each claim for **drift**, and a Documenter role
checks drifted claims and looks for work no claim covers.

Three principles:

1. **AIDE observes, it does not ask agents to report.** What changed is computed by AIDE from the
   files; agents only add what AIDE cannot know (meaning: the claim, what it supersedes).
2. **No pushes.** Nothing is typed into a terminal and no hooks are used for the tracker. The state
   reaches agents as context (§Context delivery) and the user through the UI.
3. **Only those with the long view write.** The user and interactive agents write to the tracker;
   headless agents read it.

The unit AIDE watches is the claim, not the commit. Tying every commit to a task was tried in an
earlier revision and every review found new holes in it (branches, rebase, squash, merges, guessing
who made a commit, typo commits piling up): bookkeeping that serves the truth of the claims only
indirectly and needs a person clicking through it daily. Drift asks the question directly — *this code
changed, and nobody has confirmed the claim about it since* — from the files alone.

## Boundaries

| Thing | Answers | Lifetime | Granularity |
|---|---|---|---|
| **Tracker** | What are we doing, what is in the project, what we decided not to do | The project | A feature or decision the user would ask about a week later |
| **Plan** (`aide/plans/`, `plan-mode-spec.md`) | How a pipeline gets one piece of work done | Until the work is done | As fine as execution needs: research, intermediate steps |
| **Documentation** (`docs/`) | How and why, where one line is not enough | While a visible claim links to it | Specs, protocols, rationale |
| **`CLAUDE.md`** | How to work here: rules, conventions, a short map | Changes rarely | Rules |
| **Agent memory** | Facts about the user and how they want to work | Per user | Facts |

- The tracker is not a plan, and plans do not become tracker tasks. A plan may solve one task or
  several (`solves`); a task may have no plan, one, or several over time (a dropped attempt, then one
  that finished). The tracker never sees a plan's inner tasks, only "plan P solves this, 4/9".
- `CLAUDE.md` loses everything about state; it keeps rules and a short map.
- Rules for agents, in the tracker guide and the server instructions:
  - *A tracker task is what the user will ask about a week from now; anything needed only to get the
    current task done belongs in the plan.*
  - *A work item goes to `task_create`, never into a TODO in a file.*

### Who writes, and how a caller is known

| Caller | Reaches AIDE through | May |
|---|---|---|
| The user | The UI | Everything |
| Interactive agent | AIDE's MCP server of its CLI tab (`docs/aide-mcp-launch.md`), identified by a live `AIDE_TAB_ID` | Everything through `task_*` except confirming a claim |
| Headless agent (pipeline step, Orchestrator, Documenter) | Generated context. Most headless CLIs run with no MCP server at all; OpenCode steps get a per-step AIDE endpoint carrying only `submit_result` | Read what its context carries. Findings go to the plan's `followups` or to the Documenter's result |
| AIDE | Itself | Statuses it observes, fingerprints and drift, the Documenter's results, history entries |

Write tools exist only on the tab server and require an `AIDE_TAB_ID` that names a live tab of this
AIDE; a call without one (a session started outside AIDE) gets read tools only. Headless agents need
no refusal rule: the tools they could misuse are never given to them. Later, read-only `task_search`
and `task_get` may be added to the per-step endpoint where a CLI has one.

## The task

### States

```
            ┌──────── blocked ◀───────┐
            ▼            ▲            │
backlog ◀─▶ planned ◀─▶ active ─▶ done ───────┐
   │           │          ▲        │          ├─▶ history (out of view, searchable)
   │           │          └────────┘ reopen   │
   └───────────┴──────────────────▶ cancelled ┘
```

- `backlog`: an idea or need, not committed to.
- `planned`: we intend to do it; ordered by `rank`.
- `active`: someone works on it now (§Current task). Back to `planned` when the work is paused.
- `blocked`: from backlog, planned or active, with a `reason` (free text; no structured dependency
  in v1). Unblocking returns it to where it came from.
- `done`: finished. If it carries a claim, the claim is true.
- `cancelled`: we decided not to do it.
- **History** is not a status but a flag (`history`) on a `done` or `cancelled` task: no longer true
  or no longer relevant. Found by search, never shown in the snapshot. The UI calls it History and
  never shows the combinations of status and flag as separate things.
- **Reopen**: a `done` task goes back to `active` (the work turned out unfinished). Its claim stays
  visible but is shown as *reopened* everywhere until the next close.

The tasks not in history make up **the project's state**, shown to the user as the *Project* view.

**Decided against**: a visible task with a `decidedAgainst` text and no claim, whatever its outcome:
a `cancelled` idea ("We do not do X because Y"), or a `done` removal that should not be proposed again.

No due dates, milestones, estimates or assignees beyond §Current task: deliberately, every field is
one more thing to go stale.

### The claim

A task that adds something to the project ends with a **claim**: a statement about the project in
the present tense, with a short noun **label**.

> Task title: Add titles to terminal tabs
> Label: Terminal tab titles
> Claim: Terminal tab titles are stored in `.aide/Titles/{sessionId}.txt`; the default is "Claude Code";
> the session picker shows the saved title.

- The claim is one to three lines and checkable against the code.
- The label is what the Project view and the snapshot show. The task title stays the action it was;
  the label names the thing, so it does not drift when the claim is rewritten.
- `code`: globs, relative to the project root, of the files **the feature lives in** — not every file
  it passes through. A claim about an IPC-backed feature names its own module, not `ipc/index.ts` and
  the preload files every such feature touches. `task_close` warns about globs that match a hub file
  or a whole tree.
- A claim refined several times lives in a chain of tasks (each superseding the previous one);
  `task_get` follows the chain and returns its journal lines in order.

## Drift

### The hash and the map

- **One hash function everywhere** — at close, for drift, for the Documenter: AIDE's own hash of a
  file's **working-tree** content, normalised (line endings to LF; by default also whitespace-
  insensitive, so a formatter sweep does not drift claims; per-project setting). It does not depend on
  git, so it is the same in every mode (root, repos, no-commit, no-git), for files outside every repo,
  and with `autocrlf`.
- **Ignore rules** (`aide/tasks/config.json`) take files or lines out of hashing. Defaults: lockfiles
  (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`…), build output
  (`dist/`, `out/`, `build/`, `node_modules/`), `aide/`, and the `"version"` line of `package.json`
  (bumped on every build in this repo).
- A claim's state of the code is a **map** `{path: hash}` over the files its `code` matches after the
  ignore rules. `confirmed` stores the map at the last confirmation. Comparing maps tells which files
  changed, appeared or disappeared; a single combined hash would not.

### Hub files

A file matched by more than `max(8, 3 % of visible claims)` claims is a **hub**. Hubs are applied only
when maps are compared — their entries are skipped — so a file becoming a hub changes nothing stored
and is never itself a drift. Hub changes are not lost: they go to the Documenter's uncovered-work input.
A claim whose every matched file is a hub or ignored has **no signal**, shown as such in the Project
view, with the advice to narrow its `code`.

### Recompute

AIDE's watcher reports changed paths; AIDE rehashes those that any claim's globs match and updates the
affected claims' drift. A checkout, a pull or a rebase arrive as file changes like any other edit, so
nothing about drift depends on commits, branches or authors. (The watcher must pass changed paths on;
today the file index only signals "updated" — v1 work, see `docs/file-index-incremental-plan.md`.)

### Drift states of a claim

| State | Meaning | A problem? |
|---|---|---|
| `clean` | The map equals `confirmed` (hubs skipped) | No |
| `in progress` | Drifted while a task is active in the project (a tab bound, or a plan run going) | No; it is a candidate at that task's close |
| `outside` | Drifted while no task was active: work done outside the tracker | **Yes** |
| `acknowledged` | Someone answered for it (§Closing, `task_acknowledge`); waits for the Documenter | No |
| `suspect` | The Documenter found the claim untrue | **Yes** |
| `broken` | Its globs match no file | **Yes** |
| `unverified` | Migrated; never checked (§Migration) | No; worked off by the Documenter in the background |
| `no signal` | Every matched file is a hub or ignored | No; shown in the Project view |

Only the three problem states appear in Now, in the live snapshot and in tool-result tails. A tail
shows counts and the newest few, never every drifted claim, and nothing `in progress`, so agents in
unrelated tabs are not invited to "fix" other work.

## Closing a task

`task_close(id, baseRevision, outcome, claim?, decidedAgainst?, supersedes, answers, mechanical?, globs?)`

- `outcome`: `done` or `cancelled`.
- `claim`: present or absent. Absent means internal work (a refactor, a fix that restores a claim) or
  a removal; such a task goes to history on close, unless it carries `decidedAgainst`. A new claim's
  `confirmed` map is the working tree at close.
- `supersedes`: visible tasks this work makes untrue. They go to history with a pointer to this task.
  **Refining** a claim is a supersede plus a claim that states the combined result.
- **Candidates** are every claim `in progress` or `outside`. No baseline is recorded at `task_start`,
  so a task never started, started late or worked from several tabs is handled the same way.
- `answers`: one per candidate not superseded — `{claim, kind, note}` with `kind`:
  - `keep`: still true after this change; becomes `acknowledged`.
  - `restore`: this work makes it true again (a bug fix); becomes `acknowledged`.
  - `elsewhere`: the drift belongs to another active task (named); stays `in progress` for that task.

  A close that leaves a candidate unanswered is refused. Answers go to the closing task's journal and
  to the Documenter's queue; kept and restored claims are confirmed only by the Documenter.
- `mechanical: { reason }` answers every remaining candidate as `keep` at once, for a rename, a
  formatter or a lint fix; those claims are queued to the Documenter at low priority.
- `globs`: new `code` for claims whose files moved (a rename), applied in the same close, so a refactor
  does not need a second round of amends. A claim that went `broken` and gets new globs is answered
  with them.

`task_close` with `dryRun: true` writes nothing and returns a ready-to-submit skeleton: the candidates
with the files that changed in each and empty answers, the claims matching by label and tags (optional,
no answer needed), glob warnings, `broken` claims with guessed new paths when files were moved, the size
of the project's state and of each tag group. A tag group above a set size gets a suggestion to fold
claims.

**Removing a feature** closes `done`, supersedes the feature's claim and adds no claim. If the feature
should not be proposed again, it carries `decidedAgainst` and stays visible under Decided against.

### Outside a close

- `task_acknowledge(claims, kind, note)`: answers `outside` drift (`keep` or `restore`) when the work
  was done without a task. Same effect as an answer at close.
- `task_amend_claim` / `task_amend_claims`: rewrite label, claim or `code` of visible claims — a badly
  phrased claim, globs broken by a rename. Writes a journal line; the claim becomes `acknowledged`. It is
  meant for wording, not for change: when the claim is wrong because the project changed, that is work
  and goes through a task. AIDE cannot check this; it is a rule for agents, and the journal line with
  the reason makes misuse visible.
- **Confirming** a claim (recording the current map as `confirmed` without the Documenter) is done by
  the user in the UI only. Agents acknowledge; they never confirm.

### Fields

```markdown
---
id: terminal-tab-titles
title: Add titles to terminal tabs
status: done
rank: 3.5
tags: [terminal, sessions]
docs: [docs/session-binding-and-lifecycle-events-spec.md#titles]
code: [src/main/pty/titles.ts, src/renderer/src/components/terminal/TabTitle.tsx]
reason: null              # for blocked and cancelled
label: Terminal tab titles
claim: >
  Terminal tab titles are stored in .aide/Titles/{sessionId}.txt; the default is
  "Claude Code"; the session picker shows the saved title.
decidedAgainst: null
reopened: false
history: null             # or { at, by: <taskId>|null, reason }
confirmed:                # null for a migrated, unverified claim
  at: 2026-11-21T15:00:00Z
  by: close               # close | documenter | user
  files: { src/main/pty/titles.ts: 3f9a…, src/renderer/src/components/terminal/TabTitle.tsx: 81c2… }
acknowledged: null        # or { at, by, kind, note } until the Documenter checks it
check: null               # last Documenter result: { at, result: ok|suspect, note }
source: null              # where a migrated task came from, e.g. "STAGES.md"
activeBy: []              # users who started it; see §Current task
created: 2026-11-20T10:00:00Z
closed: 2026-11-21T15:00:00Z
---

## Description
Why and what, as long as needed and no longer. Long specs live in docs/ and are linked.

## Journal
- 2026-11-20 allex/tab 3: decided to keep titles out of JSONL.
- 2026-11-21 close: claim; supersedes session-slug-labels; keep terminal-panel-layout (titles do not change the layout).
```

- `id`: a slug, unique in the project, never changed. An agent may choose it; a quick add in the UI
  generates it from the title. The same slug chosen on two branches is found by the load check.
- Computed, never stored: drift state, the plans that solve the task, the tabs working on it, the docs'
  back-links. The task card shows the commits made while the task was active as information only.
- The journal holds short decisions and findings that outlive a plan, written with who and where. It is
  not a transcript.

## Current task

`task_start(id)` makes a task `active` and binds it to the **calling tab**. AIDE's MCP server runs per
tab, so the binding survives `/clear` and compaction, which keep the tab and the server. The binding
ends when the tab closes, the task closes or is paused, or the tab starts another task. A tab has at
most one current task; a task may be current in several tabs.

- The tab shows its current task; a tab with none shows "no task", visibly.
- `activeBy` in the task file records the users who started it, so collaborators see who works on it.
- Tab bindings are per user, `.aide/users/<user>/tasks/bindings.json`. On a shared folder AIDE reads
  every user's bindings: another user's live work counts as active (drift during it is `in progress`,
  not `outside`) and is not shown as stale. Over git, bindings are not shared; a task active by another
  user is shown as "active by B", and their work reaches this copy through a pull, when their closes have
  already confirmed it.
- A run of a plan that solves a task counts as working on it: AIDE marks the task `active` when the run
  starts.
- **Stale**: active by the current user with no tab bound and no plan run going, or with no journal line
  and no `in progress` drift for a set number of days. Shown in Now; nothing else happens.

## Context delivery

No hooks, no typed messages, no tool lists changed during a session. State is split by how fast it
changes, because what is written at `initialize` stays in the system prompt, frozen, for the whole
session (including after `/clear` and compaction):

| Channel | Carries | When |
|---|---|---|
| Server `instructions` | **Stable part**: a short orientation and the rule to call `task_snapshot` (below) | At `initialize`, when the tab's CLI starts |
| `task_snapshot` description | A short pointer to the tool (no state in it) | Whenever the client loads tool descriptions |
| `task_snapshot` result | The project's claims as labels and the **live part** (below) | When the agent calls it |
| Tail of every `aide` tool result | What changed since this tab last heard: new problems (counts and the newest few), tasks closed or started by others, plans finished, new Documenter proposals | Only when the agent calls an `aide` tool |
| UI | Everything | Always |

Nothing volatile is ever in the instructions: a frozen "current task: none" after a `task_start` would
be worse than no snapshot. Tool descriptions are not updated mid-session (`tools/list_changed`): they
sit at the start of the cached prompt, and every change would rewrite the whole cache. The tail is
appended at the end of the context and costs nothing extra. A session that never calls an `aide` tool
sees only the stable part it started with; the user sees the rest in the UI.

### Stable part (instructions)

What the CLIs keep of server instructions and tool descriptions was measured (§Measurements): Claude
Code keeps only the first ~4 KB of the instructions and loads tool descriptions on demand; Devin puts
neither into the context at start. The instructions therefore cannot carry the project's state. They
carry a **short orientation** that makes the agent fetch the state, within a hard budget of what is
left of ~4 KB after AIDE's existing text (about 1 KB today), and with the rule first so that a cut
never removes it:

1. The rule: call `task_snapshot` before starting work; a work item goes to `task_create`, never into
   a TODO in a file; granularity in one sentence.
2. The project's tags with claim counts, and the number of problems at `initialize` (as a hint only,
   marked as of session start).
3. Planned tasks by rank (top 5), as titles.

The labels of all claims, grouped by tag, move into `task_snapshot`'s result, where size is not cut by
the client; claim text stays one `task_search` or `task_get` away.

For Devin, which does not show instructions, the orientation reaches the agent only when it discovers
AIDE's server through its MCP listing; AIDE adds nothing else for it (no hooks, no files).

### `task_snapshot`

0. The project's claims as labels, grouped by tag; reopened ones marked; decided against as labels.
   Over a size setting it degrades by relevance: tags of active and soonest-planned tasks and recently
   confirmed claims keep their labels; other tags collapse into headings with counts, and the result
   says what it left out.
1. This tab's current task: title, description, journal tail, links.
2. Problems: `outside`, `suspect` and `broken` claims (counts, then the newest), stale actives,
   load-check findings, uncovered files waiting for the Documenter (count), Documenter proposals
   waiting for a decision.
3. Active tasks and who works on them; blocked tasks with reasons; claims `in progress`.
4. Closed or moved to history in the last N days.

Headless agents get the tracker through their generated context: the Orchestrator the stable part plus
problems, a pipeline step the task(s) its plan solves with their claims.

## Storage

- One file per task: `aide/tasks/<id>.md`, YAML front matter and a Markdown body. One file per task
  keeps merge conflicts between collaborators to the task actually touched; a person can read and grep
  it. Settings (ignore rules, hash options, hub threshold, budgets, Documenter cadence and budget) in
  `aide/tasks/config.json`; rejected Documenter proposals in `aide/tasks/rejected.jsonl` (append-only).
- AIDE writes the files, through MCP tools and the UI. A hand edit is picked up at the next read; an
  invalid file is shown as an error and AIDE refuses to write it until it is fixed (as with plans).
- **Revision** is a hash of the file's content, not a counter in it, so a hand edit changes it too.
  Every write passes `baseRevision` and is refused if the file changed.
- **Writes that touch several files** (a close with supersedes or answers): AIDE checks every revision
  first and takes the project's tracker write lock, `aide/tasks/.write-lock`, as a **lease**: owner user
  and host, an expiry a few seconds ahead, renewed while the write lasts; an expired lease may be taken by
  anyone, on any host. Other tasks are written first and the closed task last, so an interrupted close
  leaves tasks pointing at a task that is not closed, which the load check finds. A revision conflict
  before the first write refuses the whole close with the changed tasks.
- **Load check**: at every load AIDE shows, as problems in Now, a task pointing at a closing task that is
  not closed (an interrupted close, repaired with one action) and two files with the same `id`.
- Caches in `.aide/`: the search index, the current file hashes, the hash manifest of the last
  Documenter pass, and the content of claim files at confirmation (content-addressed, best effort) so the
  Documenter can be given a diff.
- Whether `aide/tasks/` is committed is the project's choice. AIDE never stages it, and it is left out
  of a run's diff, the commit coverage check and the shadow snapshot, as `aide/plans/` is.

## Documenter

Keeps claims and docs true, and finds work that no claim covers. A pipeline machine `documenter`, built
from the docs actualizer that already works. Headless: it writes no task; AIDE applies its result.

**Triggered by events, not a clock**: after N tasks closed since the last pass, when problems or the
acknowledged queue exceed a set count, after a migration, or by hand.

**Budget** in tokens per pass (setting). The input is cut to fit, in priority order.

**Input** (generated context), in priority order:

1. Claims to check: `outside`, then `acknowledged` (restores before keeps, mechanical last), then
   `suspect` re-checks after edits, then `unverified`, then the least recently checked. Each with its
   claim, `code`, linked docs, its current map and, where the cache has it, the diff since `confirmed`.
2. **Uncovered files**: AIDE compares the hash manifest with the last pass and lists changed files
   (after the ignore rules) that no claim's globs match, or only hubs match — computed without a model.
   With them, the rejected proposals that touched the same files, as "do not propose again".

**One pass:**

1. Checks each claim against the code: `ok` or `suspect` with a note.
2. Checks the docs linked from those claims and proposes doc edits through the machine's review loop;
   they land as the run's commit, or in the working tree in no-commit and no-git modes, as any run's
   work does.
3. Judges the uncovered files: a feature or decision the user would ask about that no claim covers. At
   most 3 proposals per pass (setting).

**Result** (the step's result schema):

```json
{
  "claims": [{ "task": "terminal-tab-titles", "result": "ok", "note": "" },
             { "task": "session-picker-sort", "result": "suspect", "note": "Sort is by title now, claim says by date" }],
  "proposals": [{ "title": "Native drag from the file tree", "label": "File tree drag-out",
                  "claim": "Files dragged from the tree are dropped as native files into other apps.",
                  "code": ["src/main/filetree/nativeDrag.ts"], "evidence": "nativeDrag.ts added" }]
}
```

**Applying**: an `ok` is applied only if the claim's map is still the one the pass was given; the map
then becomes `confirmed`. If the files changed during the pass, the result is dropped for that claim and
it stays in the queue. A `suspect` is recorded in `check`. Proposals wait in Now and the live snapshot
until the user or an interactive agent accepts one (it becomes a `done` task with that claim, confirmed),
edits it, or rejects it (recorded in `rejected.jsonl` with its files and summary). The Documenter never
rewrites a claim or moves a task to history.

Problems are not pushed anywhere. If they pile up, the pile is visible; shadow mode measures whether the
Documenter's budget keeps up with the drift rate before agents see any of it.

**Later (see §Scope):** at close, an answer for every linked doc; orphan docs (files in `docs/` linked
from no visible task) with an allowlist for docs that are rules; the Docs view.

## MCP tools

On the tab server only.

| Tool | Writes | Does |
|---|---|---|
| `task_guide` | | The agent-facing rules (boundaries, granularity, claims, `code`, closing) |
| `task_snapshot` | | The live part for this tab |
| `task_search(query, status?, tags?, history?)` | | Matching tasks: id, title, status, label and claim's first line |
| `task_get(id)` | | The task with drift (changed files), plans, tabs, back-links, its claim chain, commits while active |
| `task_create(fields)` | ✓ | A new task, `backlog` by default |
| `task_update(id, baseRevision, fields)` | ✓ | Title, description, tags, docs, code, rank, reason; status among backlog, planned, blocked, and active → planned (pause) |
| `task_start(id)` | ✓ | `active`, bound to the calling tab |
| `task_note(id, text)` | ✓ | A journal line |
| `task_close(…)` | ✓ | §Closing; `dryRun` returns the skeleton |
| `task_reopen(id, reason)` | ✓ | `done` → `active`, claim marked reopened |
| `task_acknowledge(claims, kind, note)` | ✓ | Answer `outside` drift |
| `task_amend_claim(…)` / `task_amend_claims([…])` | ✓ | Rewrite wording or globs |
| `task_proposal(id, accept\|reject, edits?)` | ✓ | Decide a Documenter proposal |
| `task_to_history(id, reason)` / `task_restore(id)` | ✓ | By hand, outside a close |

`plan_create` and `plan_edit` gain `solves: [taskId]`. When a plan that solves tasks finishes, its
`plan_attention` asks the Strategist to close them and to decide each open follow-up: promote it to a
task, add it to a task's journal, or drop it. Closing is never automatic: a plan can finish without
solving its task. Commits keep the existing `Plan-Task: <plan>/<task>` trailer; the tracker adds none.

## UI

A Tasks view (placement open, §Open questions):

- **Now**: problems first (`outside`, `suspect`, `broken` claims, stale actives, load-check findings,
  Documenter proposals, uncovered files count), then active tasks with their tabs, users, running plans
  and `in progress` claims, then blocked.
- **Planned / Backlog**: ordered lists, drag to rank, filters by tag, search, quick add (title only).
- **Project**: the claims by label, grouped by tag, with their drift state; hub files and `no signal`
  claims listed. The uncut version of what the agent sees in the stable part.
- **Decided against**.
- **History**: search over everything, with what moved what to history.
- **Task card**: description, label and claim, drift with the changed files, journal, links (a doc opens
  in the editor), plans and their runs, tabs, commits while active; actions start, pause, close, reopen,
  amend, acknowledge, confirm (user only), to history.

Closing from the UI opens with the `dryRun` skeleton: candidates listed **unanswered**, with keep,
restore, supersede and elsewhere to choose for each, so the user decides rather than confirms a pre-filled
answer. A person's answer needs no written note; the Documenter checks it all the same.

## Migration

The Strategist does it interactively with `task_create`: reads `STAGES.md`, `PLAN.md`, "Status:"/"Planned"
lines in `docs/` and the state parts of `CLAUDE.md`, and proposes tasks: claims for what exists,
planned/backlog for the rest. Every migrated claim has `source` set and is `unverified`: its map is
recorded at migration (so later drift is still seen) but it was never checked, because the files it came
from are the stale ones. `unverified` is not a problem; it is shown as such and worked off by the
Documenter in the background, within its budget.

- The user reviews the migrated tasks in the UI (marked as migrated until reviewed).
- After the review, the state is removed from the old files, leaving links; that edit is an ordinary
  commit the user reviews. It does not wait for the Documenter: an `unverified` claim says honestly what
  it is, which a "Status: implemented" line never did.
- The Documenter's first pass after a migration also takes uncovered files over the whole code, to find
  what the old files never mentioned (still at most N proposals per pass).
- Agent memory is per user and outside the repository: left alone; the user decides.

## Engine version

`solves`, the tracker sections in the Orchestrator's context and a step's view of the tasks its plan
solves change generated content for existing machines and plans: `ENGINE_VERSION` is raised with an
`ENGINE_CHANGES` entry, which also states that headless roles, the Orchestrator included, get the tracker
as context and never write it.

## Scope

### v1

- Task files, states (pause, reopen, decided against), label, claim, `code` with glob warnings.
- The hash, ignore rules, maps, hubs, drift states, recompute from the watcher's changed paths.
- MCP tools as listed; `task_close` with answers, `mechanical`, `globs`, `dryRun` skeleton.
- Tab binding, `activeBy`, stale.
- Context delivery: a short orientation in instructions, labels and live state through `task_snapshot`,
  tails.
- Content-hash revisions, write lease, load check.
- The Documenter: claim checks, doc edits, uncovered-work proposals with suppression.
- `solves` on plans and the close prompt when a plan finishes.
- UI: Now, Planned/Backlog, Project, Decided against, History search, task card.
- Interactive migration.

### Later

- Doc answers at close, orphan docs, the Docs view.
- Read-only `task_*` on per-step endpoints for headless agents.
- "Updated since you looked".
- A migration machine.
- The remote page.
- A cross-project view.

### Build order

1. ~~Probe instruction limits~~ — done for Claude Code, OpenCode and Devin (§Measurements); Codex and
   Cursor still to measure.
2. Storage, schema, read tools, Project and Planned views.
3. **Migrate AIDE itself**, to get a real set of a few hundred claims (`unverified`).
4. Tab binding, `task_snapshot`, the stable part.
5. Changed paths from the watcher, the hash, maps and drift in **shadow mode** for a few weeks on AIDE's
   own repository: computed and logged, shown only in a diagnostic view, not in snapshots or tails.
   Measure drifted claims per week, which files become hubs, how many claims have no signal, the number
   of uncovered files, and above all whether a Documenter budget keeps up with the drift rate. Tune the
   hub threshold, ignore rules and hash options before agents see the signal.
6. Candidates and close.
7. The Documenter.
8. `solves`.

## Measurements

2026-11-20. A stdio MCP server with 80 KB of instructions and a 20 KB tool description, both carrying
numbered markers with random words; each CLI was run non-interactively and asked, without calling the
tool, for the last marker it could see (the random words rule out guessing).

| CLI | Server instructions | Tool description |
|---|---|---|
| Claude Code 2.1.329 | In the system prompt, **cut at ~4 KB** (marker at 4065 chars seen, at 4268 not) | Not loaded at start (tool search defers it). With `ENABLE_TOOL_SEARCH=false`: cut at ~4–5 KB |
| OpenCode 2.1.4 | In full (all 80 KB) | Not reported as visible |
| Devin 3000.11.92 | **Not in the context.** Readable in full only through Devin's MCP discovery listing, when the agent asks for it | Through the same listing, cut there |
| Codex 0.167.0 | Not measured: the account's usage limit until 2026-11-21 | — |
| Cursor | Not measured: `cursor-agent` not installed on this machine | — |

Conclusions: the instructions are a place for a short rule, not for state; anything longer than ~3 KB
of tracker text is lost in Claude Code, and nothing in them is guaranteed to be seen at all. State comes
from `task_snapshot`, whose result is not cut. Interactive tabs were not measured, only print mode of the
same CLIs; the limits are expected to be the same but that is an assumption.

## Open questions

1. **Placement of the Tasks view:** a tab next to the pipeline tab, a column beside the file tree, or a
   separate window.
2. **Ordering:** `rank` per task (fractional, conflict-light) or one ordered list file.
3. **Hierarchy:** none (tags only), or an optional `parent` for grouping large features.
4. **Documenter cadence and budget:** the thresholds and the token budget per pass; set from shadow-mode
   numbers.
5. **Several users active on a shared folder:** whether one user's active task should make another
   user's unrelated edits `in progress` rather than `outside` (as written now) or only their own.
6. **Prior art** to study before building: Beads (git-backed agent issue tracker with a dependency graph)
   and Backlog.md (Markdown task files, kanban UI, MCP).
