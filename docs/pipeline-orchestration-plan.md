# Pipeline Orchestration — Implementation Plan

> Plans, the Strategist and the short-lived Orchestrator came later: see
> `docs/plan-mode-spec.md`. "Orchestrator" below is what is now the Strategist.
>
> Status: **Plan.** Captures the design agreed in discussion (2026-10-09) and the
> phased path to build it. Items marked **[verify]** are assumptions about
> third-party CLIs that Phase 0 must confirm against current documentation and
> live behaviour before anything is built on them.

---

## 1. Concept

AIDE gains a **pipeline mode**: a deterministic state machine, executed by AIDE
itself, drives headless AI agents (Claude Code, Codex, OpenCode, Devin, …)
through a task — implement → check → review → fix → … → commit.

Three actors, strictly separated:

| Actor | What it is | Responsibility |
|---|---|---|
| **Orchestrator** | **Any** interactive agent in an AIDE terminal tab that has connected the AIDE MCP server | Reads spec/plan, picks the next task, chooses a machine, starts it, reads reports, updates the plan, talks to the user. Thinks; never edits files while a run is active. |
| **AIDE engine** | Deterministic code in the main process | Executes the machine: spawns agents, runs checks, routes outputs, enforces budgets, performs approved commits, reports. Makes no judgement calls. |
| **Node agents** | Headless CLI processes, one per agent node | Perform exactly one role (implementer, reviewer, content generator, …) under an explicit contract. |

Key decisions already taken:

- **The loop is run by AIDE, not by an LLM.** The orchestrator is woken only on
  run completion or escalation (management by exception).
- **Machines are a per-project library**, one machine per task *type* (e.g.
  "code feature", "game location content"). The orchestrator selects a machine
  and fills its parameters; it does not invent machines at run time.
- **No git worktree, no locks.** The run executes in the project's working
  tree. The user is never restricted — editor and terminals stay fully usable;
  a warning banner shows while the machine executes (§5.6).
- **Graceful stop** is a first-class operation (Pause / Stop now).
- **Cooperative model, like subagents.** A pipeline is a flow of subagents, and
  nothing is policed: no write tracking, no scope enforcement, no orchestrator
  lock. Agents follow their role instructions. The engine controls only what the
  machine itself needs — output contracts for routing, budgets against hung
  agents, checks it runs itself, and the commit it performs.
- **Commit is a separate step with a review layer on top** (§3.3): code review
  never deals with staging or messages; a commit node reviews the prepared
  commit (algorithmically or by an agent) and, on success, commits.
- **The orchestrator role is defined by the MCP contract, not by a CLI.** AIDE
  publishes an MCP server plus a document describing how to connect it; any
  agent that connects becomes a valid orchestrator. Onboarding is a wizard that
  opens a tab with a ready-made setup prompt, the same pattern as the toolbar
  AI helper (§1A).
- **Orchestrator notification** uses whatever the agent supports, in tiers:
  native background tasks / Monitor on a streamed event feed where available,
  a blocking `pipeline_wait` MCP call otherwise — never PTY input injection.
- **A pipeline tab** in the terminal panel (next to the CLI session tabs, not
  closable while the run is active) always shows the running machine, so
  visibility never depends on the orchestrator remembering it.
- **Transcripts are rendered as Markdown** in a virtualized block list
  (`TranscriptView`), shared with the history viewer.

---

## 1A. Orchestrator onboarding (wizard)

> **Superseded (2026-10-29).** There is no wizard any more: AIDE adds its MCP
> server to every CLI tab it launches, and the server itself tells the agent when
> to turn to orchestration. See `docs/aide-mcp-launch.md`.

### 1A.1 Principle

AIDE does not hard-wire any CLI as orchestrator. It ships:

- `resources/docs/orchestration-mcp.md` — the MCP contract: how to connect, the
  tool list, the orchestrator's rules of conduct, event delivery options.
  Deployed to `.aide/docs/orchestration-mcp.md` exactly like `toolbar.md`
  (`deployToolbarDocs` in `src/main/config/toolbarConfig.ts`).
- An MCP server (§5.4) reachable through a **stable** entry point.

The agent reads the doc and configures the MCP server in its *own* config
format (Claude Code, Codex, OpenCode, … each have their own). AIDE never edits
CLI configs itself — this is what makes every MCP-capable agent eligible.

### 1A.2 Stable entry point

The local server listens on a random port with a random token per launch
(`HookServer` pattern). A config written by an agent would go stale on the next
AIDE start. Therefore the MCP entry point is a **stdio shim**:

- Command: `aide mcp` (the AIDE executable in Node mode via
  `ELECTRON_RUN_AS_NODE`, or a bundled script) **[verify packaging]**.
- On start it reads a discovery file written by the running AIDE instance —
  `.aide/users/<user>/runtime.json` with `{ port, token, pid }` — and proxies
  stdio MCP ⇄ local HTTP.
- stdio is the most widely supported MCP transport across CLIs; the agent's
  config never contains a port or a secret, so it stays valid across restarts.
- If AIDE is not running for this project, the shim answers every call with a
  clear error instead of hanging.

### 1A.3 Wizard flow

Entry: menu / toolbar action **"Set up orchestration…"**.

1. Small dialog (same layout as the toolbar AI helper in `MainToolbar.tsx`):
   CLI dropdown (activated tools), optional free-text notes, button
   **"Ask <CLI>"**.
2. AIDE opens a new tab via `terminalCreateWithPrompt(toolId, prompt)` with a
   prepared prompt: read `.aide/docs/orchestration-mcp.md`, register the AIDE MCP
   server in your configuration (project scope preferred), tell the user whether
   a session restart is required, then call `pipeline_hello`.
3. The dialog stays open in a **"Waiting for connection…"** state. AIDE learns
   about success from the MCP side: the `initialize` handshake (client name /
   version) followed by `pipeline_hello`.
4. Most CLIs load MCP servers only at session start. If the agent reports that a
   restart is needed, the dialog offers **"Restart tab"** (resume the same
   session) and keeps waiting.
5. On success: "Connected: <client>". AIDE records the tool as
   orchestration-capable in user state, and offers the next step — authoring
   pipelines (§2.2) in the same tab.

`pipeline_hello` returns the orchestrator rules in compact form (leave the
working tree to the run while it is active, how to subscribe to events, where
reports live), so the rules reach the agent even if it skimmed the document.
These are instructions, not enforcement — same as with ordinary subagents.

### 1A.4 Consequences of CLI-agnostic orchestration

- **Event delivery** is tiered (§4.2). The overlay guarantees the user sees the
  run regardless of what the orchestrator can do.
- **One active run per project** (concurrent runs in one working tree would
  mix their diffs and commits). Any
  connected agent may query status; only the starter — or the user — controls
  the run.

---

## 2. Q1 — How machines are prepared for a project

Machines are authored **by an agent on user request**, normally once before
development starts and revised as the project evolves. Authoring is an ordinary
interactive session, not a pipeline run.

### 2.1 Artifacts

```
aide/pipelines/                    # shared, committed (same convention as aide/toolbar.json)
  code-feature.json                # machine definition
  location-content.json
  roles/
    implementer.md                 # role instructions, referenced by agent nodes
    code-reviewer.md
    content-author.md
    content-reviewer.md
.aide/users/<user>/pipelines/      # personal machines; win on duplicate id
```

A machine file contains:

- `id`, `name`, **`description` written for the orchestrator** — when to use
  this machine, what it needs, what it produces.
- `params` — typed input schema (e.g. `taskSpec: path`, `acceptance: string[]`,
  `scope: glob[]`). The orchestrator must supply them at start.
- `steps`: a tree built only from the fixed step types (§2.3).
- `defaults` — per-role CLI/model choice, timeouts, iteration limits.

### 2.2 Authoring workflow

1. User asks the agent: "prepare pipelines for this project".
2. The agent calls MCP `pipeline_guide` (authoring rules, primitives, examples)
   and `pipeline_schema` (JSON Schema of a machine file), reads the project
   (CLAUDE.md, docs, build/test commands, asset layout) and interviews the user
   about task types and acceptance standards.
3. It writes machine files and role files.
4. It calls MCP `pipeline_validate` until clean (§2.4).
5. It calls MCP `pipeline_smoke(machineId)`: AIDE runs every `check` command
   once and pings every configured CLI in headless mode with a trivial prompt,
   confirming the machine is executable on this machine/account.
6. The user reviews the machine and commits the files.

The orchestrator may *propose* a new or changed machine during development, but
it goes through the same validate → smoke → user-approval path. A run always
**snapshots** the machine definition at start, so editing a file never affects a
run in progress.

### 2.3 Step types — a tree, not a graph

A machine is a **tree of steps** executed top to bottom, like structured code.
There are no arbitrary jumps: control moves to the next step, into a block, or
back to the start of an *enclosing* loop. (The first implementation used a graph
with `[from, to, condition]` edges; it was replaced because a two-phase machine —
a content loop followed by an integration loop and a commit — did not read as a
flat list, and arbitrary edges gave freedom no real pipeline used while costing
readability everywhere: the run view, the pipeline context, the report.)

| Type | Kind | Behaviour |
|---|---|---|
| `agent` | leaf | Spawns a headless CLI with a role, inputs, permissions, output schema, time budget. `session`: `keep` (default — each visit continues the step's own session), `new`, or `continue:<step>`. Optional `repeatIf` (repeat the loop), `escalateIf` (stop for a decision). |
| `check` | leaf | Runs a shell command in the project root; success = exit code 0. Inside a loop a failure repeats the loop; outside any loop it stops the run for a decision. |
| `gate` | leaf | Waits for approval from the orchestrator or the user; rejection repeats the loop (outside loops: the run fails). |
| `repeat` | leaf | Starts an enclosing loop over (`continue` in code); usually inside an `if`. |
| `commit` | block | Its `prep` agent stages the change and writes the message; AIDE reviews the prepared commit (`algorithmic` or `agent`) and commits. Review problems go back to `prep` as feedback, up to `maxAttempts` (§3.3). |
| `loop` | block | Runs its steps again until a pass completes without a repeat request; `maxIterations` is required, `onLimit`: `escalate` (default) or `fail`. |
| `group` | block | A titled sequence — a phase of the pipeline. |
| `if` | block | Runs `then` or `else` depending on a condition. |

**Repeats and feedback.** A step that asks for another iteration (failed check,
`repeatIf`, rejected gate, `repeat`, failed commit review) ends the pass; the loop
starts over and every agent inside it receives that step's reason and output as
feedback — no `fix` node and no wiring through inputs. `repeatLoop` / `repeat.loop`
target an enclosing loop; the loops nested in it start from scratch. Returning
from a later phase to an earlier one therefore means wrapping both phases in an
outer loop — an explicit, visible construct instead of an arbitrary edge.

Conditions are `<ref> == <literal>` / `!=` over `params.*`, `outputs.<step>.*`
and `run.iteration`. Each step's output is stored as `outputs.<stepId>`; prompts
use templating over `params.*`, `outputs.*` and AIDE-computed values (`run.diff`
— working tree vs HEAD including untracked files, `run.stagedDiff`,
`run.changedFiles`).

Escalations: `step` (`escalateIf`, or a check failing outside loops — answers
continue / retry / stop), `gate`, `limit` (a loop ran out of iterations — retry
grants one more, continue leaves the loop as if it passed), `engine` (the step
could not run — retry / stop).

### 2.4 Static validation (`pipeline_validate`, also on load)

- Shape: known step types, non-empty step lists, `prep` is an agent step.
- Step ids are unique and valid; all referenced role files, CLIs and params exist.
- Every loop has `maxIterations`; a loop nothing can repeat is a warning.
- `repeatIf` / `repeatLoop` / `repeat` only inside loops, and only to an enclosing loop.
- Conditions parse; `outputs.<step>.<field>` references exist in the step's
  output schema; a reference to a step that has not run yet at that point (and
  shares no loop) is a warning.
- `continue:<step>` names an earlier agent step of the same CLI.
- Every `agent` step has an output schema; Codex steps need strict schemas.
- The commit `prep` outputs `commitMessage` and `excluded`.
- Only CLIs that implement the headless capability (§5.2) are allowed.
- The old graph format (`nodes`/`edges`) is rejected with a pointer to the guide.

### 2.5 Example

`resources/docs/pipeline-authoring.md` (the `pipeline_guide` tool) holds the
validated examples: a code feature (one loop + commit) and content-then-integration
(two phases in an outer loop with a `repeat` back to the content). Both are
checked by `manager.test.ts`.

---

## 3. Q2 — How node agents understand their roles and stay in their lane

Principle: **cooperative, like subagents.** Role and contract are explained in
the prompt; agents are trusted to follow them. The engine does not police what
agents touch — it controls only what the machine itself depends on.

### 3.1 What each agent receives (prompt composition by AIDE)

1. **Role instructions** — the role file (`roles/*.md`): who you are, what you do,
   what you never do, how to report.
2. **Task contract** — only the inputs declared for the node: spec path,
   acceptance criteria, scope, previous findings. A reviewer receives the diff
   computed by AIDE, never the implementer's narrative.
3. **Output contract** — the JSON Schema the final answer must satisfy, plus the
   allowed status values (implementer: `done | blocked | plan_wrong`;
   reviewer: `accept | reject` with `blocking[]` and `non_blocking[]`).
4. **Pipeline context** — generated by AIDE from the machine definition, so every
   agent knows where it stands and does not duplicate work owned by other nodes:
   - the whole step tree as an indented outline with numbered steps and the
     current one marked (`← YOU ARE HERE`), including loops with their limit and
     current iteration, and what each step does to its loop (*a failure repeats
     "build"*, *repeats "build" if verdict is not "accept"*);
   - **what happens after you**, node by node, with what each one does —
     e.g. *"checks: AIDE runs `npm run typecheck && npm run build` after you —
     do not run them yourself"*, *"review: a separate reviewer agent inspects the
     diff"*, *"commit prep: staging and the commit message come later — do not
     stage"*;
   - **what happened before you**: the visit and loop iteration, the previous
     step's outcome, and answered escalations; from the second iteration of a
     loop the user message carries its **feedback** — the reason and output of
     the step that asked for the repeat (failed check output, blocking review
     findings, a gate answer).

   Every node therefore carries a one-line `summary` of what it does (written
   for the other agents). For `check` steps it defaults to the command;
   `pipeline_validate` requires it for `agent` steps.
5. **Boundaries stated explicitly** — scope (as guidance), "do not edit tests
   marked as acceptance tests", "if the plan is wrong, return `plan_wrong` with
   the reason instead of working around it". Boundaries that follow from the
   flow (do not run checks, do not stage, do not commit) come from the pipeline
   context automatically rather than being hand-written into every role file.

**Continued sessions** (`session: "continue:<node>"`): the resumed conversation
still holds the previous step's instructions, and they outweigh a fresh system
append — seen in the live end-to-end test, where commit prep refused to stage
because the implement step had said "do not stage". When a node continues a
session last used by a *different* node, AIDE therefore restates the new step in
the user message ("# New step: … this step wins where instructions conflict")
with its role, pipeline context and output contract.

Delivery (verified, see `docs/headless-cli-matrix.md`): Claude Code
`--append-system-prompt-file`; for Codex, role, pipeline context and boundaries
are prepended to the prompt (its `model_instructions_file` replaces rather than
appends).

### 3.2 What the engine controls (machine mechanics, not policing)

| Mechanism | Why the machine needs it |
|---|---|
| **Output contract** — final message parsed and validated against the node's schema; invalid → one automatic retry with the validation error, then escalation | Routing depends on it (`accept` / `reject`, `done` / `plan_wrong`) |
| **Budgets** — `maxTurns` (Claude `--max-turns` **[verify]**), wall-clock timeout per node; AIDE kills the process tree by its own PID | A hung or looping agent must not stall the run forever |
| **Checks run by AIDE** — `check` nodes; agent claims of "tests pass" are ignored | Facts instead of self-assessment |
| **Optional permissions profile** — e.g. `read-only` for reviewers (Claude: disallow Edit/Write; Codex: `--sandbox read-only` **[verify]**) | One line of configuration, same as tool-restricted subagents; not a tracking mechanism |

Explicitly **not** done: write tracking, scope enforcement or audits, tree
snapshots per node, orchestrator write locks, git-command blocking.

Role files are part of the machine and reviewed by the user at authoring time.
AIDE ships starter templates for the common roles (implementer, code reviewer,
commit prep, commit reviewer, content author, content reviewer).

### 3.3 Commit step

Committing needs judgement (which files belong, `.gitignore` updates, project
conventions such as bumped version files, the message), so an agent prepares it.
It is a separate step after code review so that commit preparation is not
repeated — and carried as dead weight — through code-fix iterations.

**Commit prep** — the `prep` agent of the `commit` block, normally `continue:implement` (the
implementer knows best what it changed and why). It stages the files that
belong to the change, updates `.gitignore` if needed, and returns:

```json
{ "commitMessage": "…", "excluded": [ { "path": "…", "reason": "…" } ] }
```

It does not commit.

**`commit` step** — a commit operation with a review layer on top. Two variants:

| Variant | Review layer |
|---|---|
| `review: "algorithmic"` | AIDE checks: index is not empty; `commitMessage` is present; **every** modified or untracked file is either staged or listed in `excluded` (a forgotten file is caught mechanically) |
| `review: "agent"` | The algorithmic checks first (cheap gate), then a reviewer agent (cheap model is fine) receives the staged diff, the message and the `excluded` list with reasons; it looks for junk in the index, unjustified exclusions, `.gitignore` changes, message quality |

Both variants behave the same way:

- **Success** → AIDE runs `git commit -F <message>` on the index and outputs the
  commit result (`sha`, files, message). Nothing is returned to the implementer.
- **Failure** → the findings go back to commit prep as feedback (it continues its
  own session) and it fixes staging/message. Bounded by `maxAttempts` (default 3).

Each successful `commit` step is a checkpoint in the run.

---

## 4. Q3 — Visibility

### 4.1 What the user sees

**Pipeline tab** — appears in the terminal panel's tab strip when a run starts,
before the CLI session tabs, and blinks until opened (and whenever a decision is
pending). It gets the terminal panel's size and focus behaviour, so it is as
readable as a CLI tab. It is not a session tab: while it is selected the session
selection is kept (PTY input, history, remote control stay bound to it); any
session tab switch leaves it. Clicking the run-state banner opens it. (It was
first an overlay over the editor area, which left it too narrow to read.)

- **Step tree** of the machine, indented like the machine file: groups as phase
  headers, loops and commit blocks with their iteration (`iteration 2/3`,
  `attempt 1/3`), leaf steps with their state (pending / running / succeeded /
  failed / interrupted / escalated) and per-visit chips. Elapsed time per step
  and total; token/cost figures where the CLI reports them.
- **Transcript pane** — live `TranscriptView` of the active agent step. Clicking
  any completed step shows its transcript, what its agent was sent (the
  **Input** tab: message and system prompt append of every CLI invocation,
  from `nodes/<node>-<visit>.input.jsonl`), its structured output (verdict,
  findings) and, for `check` steps, the command log.
- **Escalation panel** — pending question with an answer box; the same
  escalation is also delivered to the orchestrator; whoever answers first wins.
- **Controls** — Pause, Stop now (§4.3).
- **Not closable while the run is active** — the tab label shows the machine,
  its state and the current loop (`Code feature ↺ build 2/3`). It becomes
  closable when the run ends; at that point it shows the final report.
- **Editor** — unrestricted. Files changed by the run follow the existing
  external-change behaviour: a clean buffer reloads, a buffer with unsaved edits
  gets the conflict dialog.
- Pipeline events are also appended to a `pipeline` Log Panel channel.
- **Current accounts and limits** — a footer row per CLI the machine uses: the
  account AIDE has loaded now and its usage limits, rendered by the same
  component as the status bar (`components/cli/AccountUsage.tsx`). For the user
  to plan work; not sent to the orchestrator, and not a record of which account
  an earlier step ran with (CLIs pick up account switches differently).

Transcripts are written by AIDE itself from the headless event stream to
`.aide/users/<user>/runs/<runId>/nodes/<nodeId>.jsonl` in the normalized format,
so viewing past nodes does not depend on each CLI's own session storage.

### 4.2 What the orchestrator sees

**MCP tools** (served by AIDE through the `aide mcp` stdio shim, connected by
the agent itself — §1A):

| Tool | Purpose |
|---|---|
| `pipeline_hello` | Handshake after setup; returns orchestrator rules in compact form and the event-delivery options |
| `pipeline_list` | Machines with descriptions and param schemas |
| `pipeline_start(machine, params)` | Starts a run, returns `runId` and the exact command to subscribe to events |
| `pipeline_status(runId)` | Current step, loop iterations, last events |
| `pipeline_report(runId, detail?)` | Final report (§4.4), compact unless `detail` |
| `pipeline_output(step, visit?)` | Output of one step visit, on demand |
| `pipeline_answer(runId, escalationId, answer)` | Resolves an escalation |
| `pipeline_stop(runId, mode)` | `pause` / `stop` |
| `pipeline_wait(runId, since, timeoutSec)` | Blocks until the next significant event or timeout (universal fallback) |
| `pipeline_guide`, `pipeline_schema`, `pipeline_validate`, `pipeline_smoke` | Authoring (§2.2) |

**Event delivery — tiered**, because agents differ in what they support:

1. **Streamed feed + native background mechanism** (e.g. Claude Code Monitor or
   background tasks): `aide pipeline events --run <id> --since <eventId>`
   prints one NDJSON line per event; `aide pipeline wait ...` blocks until the
   next one. Both use the same discovery file as the MCP shim, so no port or
   token appears in commands.
2. **Blocking MCP call** for agents without background tasks:
   `pipeline_wait` with a timeout. The agent's turn is busy while waiting; the
   user can still talk to it between waits.
3. **Polling** `pipeline_status` as the last resort.

The MCP doc describes all three; the agent picks the best one it supports.
`since` makes every tier lossless across timeouts and session restarts
**[verify Monitor / background duration limits for Claude Code]**.

Event types: `node_started`, `node_finished`, `check_failed`, `escalation`,
`commit_done`, `run_paused`, `run_stopped`, `run_finished`, `run_failed`.

If the orchestrator forgets to subscribe, nothing breaks: the run continues, the
overlay shows it, and `pipeline_status` recovers the picture at any time.

### 4.3 Stop semantics

| Mode | Behaviour | State afterwards |
|---|---|---|
| **Pause** (default; also implicit on app close) | Current node finishes, next does not start | Consistent; resumable from the next node |
| **Stop now** | Agent process tree killed by its PID; CLI session id kept | Node `interrupted`; tree may hold uncommitted changes. Options: resume the node's session (continue the run) or end the run and leave the tree as is |
| **Usage limit** (automatic) | The CLI reported its usage limit | Like stop now; resumes by itself at the reset time when the CLI names it |
| **Amend** (`pipeline_amend`) | A running agent step is interrupted and resumed at once in its session with the new instruction | Running; no stop event |

No automatic rollback: reverting is the user's ordinary git business. If the
working tree is dirty at start, AIDE warns (pre-existing changes would mix into
the run's diff and commits) but does not refuse. Every successful `commit` node
is a checkpoint the user can return to.

### 4.4 Report (assembled by AIDE)

Facts collected by AIDE, not self-reported: result, nodes visited, iterations,
`git diff --stat` per commit, check results, duration, tokens/cost if known.
Plus agent-provided content: implementer summary, documentation changes,
accumulated **non-blocking findings** (so the orchestrator can notice recurring
issues and plan refactoring), escalations and their answers.

---

## 5. Q4 — Preparatory work (Phase 0)

Each item is independently useful or independently verifiable, and must be
complete before the engine is built on it.

### 5.1 `TranscriptView` (replaces raw `SessionHistory`) — **done**

Implemented in `src/renderer/src/components/history/`; tool views in
`src/main/pty/cliTools/toolViews.ts`. Normalized kinds as built: `edit`, `patch`
(Codex `apply_patch`), `write`, `read`, `shell`, `search`, `script` (Codex `exec`
cells); anything else renders as JSON.

- Markdown rendering of text and thinking blocks via `marked` + `DOMPurify`
  (both already dependencies; same approach as `src/main/remote/index.ts`).
  Links open externally.
- Code fences highlighted with `monaco.editor.colorize`.
- Tool blocks rendered by normalized kind: `edit` (path + diff), `write`
  (path + highlighted content), `read` (path/range), `shell` (command + output),
  `search`, `other` (JSON fallback). Informative collapsed headers
  (`→ Edit src/main/ipc/index.ts`).
- Normalization lives in the scanners: `tool_use` gains `kind` and normalized
  args. Claude Code and Codex first; other CLIs fall back to `other`.
- Virtualization with `@tanstack/react-virtual`: flat row list (message header
  rows + one row per block), dynamic measurement, overscan, scroll anchoring
  when rows above the viewport change height, stick-to-bottom for live feeds.
- Expanded/collapsed state and rendered-HTML cache keyed by block id outside the
  row components (rows unmount on scroll).
- Known limitation: browser find/selection cover only rendered rows; a
  "copy transcript as Markdown" action compensates.

Consumers: history viewer, startup picker, later the pipeline overlay.

### 5.2 Headless CLI capability — **done for Claude Code and Codex**

Result: `docs/headless-cli-matrix.md` (verified facts with sources) and
`src/main/pipeline/headless/` (`claudeHeadless`, `codexHeadless`,
`startHeadless`). Both adapters are verified by live integration tests
(structured output, resume, read-only vs write). Codex on Windows needs the
elevated sandbox for read-only runs — see the matrix.
Headless runs use the per-CLI **proxy from AIDE settings** via
`tool.getEnvOverrides()`, the same as PTY sessions.

Original scope:


Spike first, code second. Produce `docs/headless-cli-matrix.md` with, per CLI:
headless invocation, event stream format, structured/schema output support,
system-prompt injection, permission/sandbox flags, turn limits, resume of a
headless session, cancellation behaviour, exit codes.

Known recipes. Codex, Devin and Cursor invocations below are **in production
use on this machine** in the rutracker metadata pipeline
(`G:/audiobooks_preparation/rutracker/rutracker/metadata/cli.py` — `run_agent`,
`run_sol_reviewer`; `metadata/devin_pipeline.py` — `execute`, Sol review, Devin
run). Claude Code was then verified live; OpenCode remains open. The authoritative, sourced version is `docs/headless-cli-matrix.md`.

| CLI | Headless invocation (proven) | Structured output | Notes |
|---|---|---|---|
| Codex | `codex exec [--model M] --ephemeral --ignore-user-config --skip-git-repo-check --cd <dir> --color never --json -` (prompt on stdin) | `--output-schema <schema.json> --output-last-message <verdict.json>` — final message validated against a JSON Schema and written to a file | Sandbox: `--sandbox read-only` (reviewer) or `--dangerously-bypass-approvals-and-sandbox` (writer). System prompt: `-c model_instructions_file="<path>"`. Feature switches via `-c` (`features.shell_tool=false`, `features.multi_agent=false`, `web_search="disabled"`, `tools.view_image=false`, `model_reasoning_effort=...`). `--json` emits JSONL events incl. `type: "error"`. **stdin limit ~1 MiB** (pipeline caps at 900 000 chars; larger context goes into files the agent reads). Models: `codex debug models`. `--ephemeral` must be dropped for nodes that need `exec resume` **[verify resume]**. |
| Devin | `devin --model M --permission-mode accept-edits --respect-workspace-trust false --prompt-file <prompt.txt> -p` | None on stdout; the agent writes a result file, the pipeline validates it | Models: `devin models list`. Live transcript must come from Devin's session files (existing `devinScanner`), not stdout. Resume **[verify]**. |
| Cursor | `cursor-agent --print --auto-review --sandbox disabled --trust --output-format text --model M --workspace <dir>` (prompt on stdin) | None; result file pattern as Devin | Models: `cursor-agent --list-models`. |
| Claude Code | `-p --output-format stream-json --verbose` (verified live) | `--json-schema` → `result.structured_output` (verified live) | `--session-id` / `--resume`, `--append-system-prompt-file`, `--permission-mode`, `--allowedTools`/`--disallowedTools`, `--max-budget-usd` (no `--max-turns`) |
| OpenCode | `opencode run` **[verify]** | ? | |

Patterns from the same pipeline worth adopting:

- **Isolated run directory per node visit** (`--cd` / `--workspace`), holding the
  prompt, the request, the result and captured `agent.stdout.txt` /
  `agent.stderr.txt`.
- **Result through a file + schema validation** for CLIs without structured
  stdout — a uniform output contract across all CLIs.
- **Windows process group** (`CREATE_NEW_PROCESS_GROUP`) and a hard timeout
  (1800 s there) per agent call.
- **Error classification** from stdout/stderr markers: `<cli>_limit` (quota /
  rate limit — retry later or switch account) vs `<cli>_failed`.
- **Proxy via environment** (`HTTP(S)_PROXY`, `ALL_PROXY`) when configured.

Then add an optional capability to `CliTool` (`src/main/pty/cliTools/types.ts`):

```ts
headless?: {
  run(opts: HeadlessRunOptions): HeadlessRun      // prompt, cwd, systemAppend, permissions, schema, maxTurns
  resume(sessionId: string, opts: HeadlessRunOptions): HeadlessRun
}
// HeadlessRun: normalized event stream (same block model as TranscriptView),
// sessionId, final structured output, exit promise, cancel()
```

Implement for Claude Code and Codex. Each adapter maps its native stream to the
normalized block model, so the overlay renders live output with `TranscriptView`
unchanged.

### 5.3 Process control without PTY — **done** (`src/main/pipeline/processRunner.ts`)

`child_process.spawn` runner: stdout line framing, stderr capture, wall-clock
timeout, cancel = kill the process tree **by the spawned PID only**
(`taskkill /T /F /PID <pid>` on Windows), `logEvent` diagnostics for spawn
failures, timeouts and kills.

### 5.4 Local API server + MCP — **done**

Implemented: `resources/mcp/aide-mcp.cjs` (stdio shim; also `events` / `wait`
modes), `src/main/pipeline/server/` (pipeline server, discovery files, shell
launcher `<userData>/runtime/bin/aide-pipeline(.cmd)`), `src/main/pipeline/mcp/`
(MCP protocol subset + tools), `src/main/pipeline/events.ts` (event bus).
Deviation from the original scope: **no `@modelcontextprotocol/sdk`** — the shim
forwards one JSON-RPC message per HTTP request, which the SDK transports do not
model; the needed subset (`initialize`, `ping`, `tools/list`, `tools/call`,
notifications) is small and fully tested. Verified live: Claude Code and Codex
both connect through the shim and complete `pipeline_hello`
(`src/main/pipeline/server/mcp.live.test.ts`); the shim runs under the AIDE
executable in Node mode (`ELECTRON_RUN_AS_NODE=1`). Discovery: the shim picks
the registered project containing the session's working directory, so agent
configs hold neither ports, tokens nor project paths. PTY tabs get
`AIDE_TAB_ID`, which the shim forwards so AIDE knows which tab connected.

Original scope:


- Extend `HookServer` (or add a sibling with the same guarantees: localhost
  only, random token, permanent `'error'` and `'clientError'` listeners) with
  `/pipeline/*` HTTP endpoints and NDJSON streaming.
- MCP server implemented with `@modelcontextprotocol/sdk` inside main, exposed
  to agents only through the **stdio shim** `aide mcp` (§1A.2). Discovery file
  `.aide/users/<user>/runtime.json` written on project open, removed on close;
  the shim validates `pid` liveness before connecting.
- `aide pipeline events|wait` CLI subcommands on the same discovery mechanism.
- Spike: package the shim (Node mode of the AIDE executable vs a bundled
  script), confirm it starts fast enough for CLIs that spawn MCP servers at
  session start, and register it by hand in Claude Code, Codex and OpenCode
  following only the draft doc — this is the acceptance test for the doc.
- Spike: long-lived event stream under Claude Code Monitor and background
  tasks; measure duration limits and reconnection.

### 5.5 Orchestration MCP doc + wizard — **done**, wizard since replaced

The wizard was removed on 2026-10-29: AIDE gives its MCP server to CLI tabs at
launch (`docs/aide-mcp-launch.md`).

Implemented: `resources/docs/orchestration-mcp.md` (deployed to
`.aide/docs/` on project open), **Orchestration** item in the main menu (next to Remote Connect) and
`OrchestrationSetupDialog` (agent choice, notes, ready-made prompt with the exact
launch spec, waiting state driven by `pipeline_hello`, **Restart tab** that
resumes the same CLI session in a new tab).

Original scope:


- `resources/docs/orchestration-mcp.md`, deployed to `.aide/docs/` like
  `toolbar.md`. Written for agents: connection steps per transport, tool list,
  rules of conduct, event-delivery tiers, how to verify (`pipeline_hello`).
- "Set up orchestration…" dialog reusing the toolbar AI-helper layout and
  `terminalCreateWithPrompt`; waiting state driven by MCP `initialize` +
  `pipeline_hello`; "Restart tab" for CLIs that load MCP only at start.
- Orchestration-capable tools recorded in user state.

### 5.6 Run-state banner

No locks of any kind — editor, terminal tabs and toolbar stay fully usable, same
as when subagents are working. Concurrent edits to a file the run also changed
are handled by the editor's existing external-change / conflict dialog.

The user is only warned. A banner above the terminal tabs reflects the run
state:

| Run state | Banner |
|---|---|
| Executing | Yellow: *"Orchestrator is running — editing files may cause conflicts."* |
| Waiting on an escalation | Red: *"Orchestrator is waiting for a decision — answer in the pipeline view or in the orchestrator terminal."* |
| No run, paused, stopped, finished | None |

Merely having a connected orchestrator shows nothing.

### 5.7 Git helpers

- Dirty-tree check at start (warning only).
- `run.diff`: working tree vs HEAD **including untracked files**, for code
  reviewers.
- Commit review support: staged diff, staged file list, modified/untracked
  file list for the `excluded` coverage check.
- `git commit -F <message>` on the index; return `sha`, files, message.

### 5.8 Graph rendering spike — **replaced**

The run view shows the machine as an indented **step tree** (§2.3, §4.1). The
first version was a flat list in BFS order over a graph; it did not read for
multi-phase machines, which led to the tree format. With a tree there is nothing
to lay out, so no graph library is needed.

Original scope:

Evaluate `@xyflow/react` with automatic layout (dagre/elk) against the overlay
size constraints; read-only graph with live state styling.

### 5.9 Engine test harness — **done** (`vitest`, `npm test`; fake CLI in `src/main/pipeline/testing/fakeCli.cjs`)

The engine is pure, deterministic logic — the one place in AIDE where automated
tests pay off immediately. Proposal: introduce `vitest` scoped to the engine,
plus a **fake headless CLI** (scripted outputs, delays, failures, invalid JSON)
so every node type, loop limit, stop mode and recovery path can be tested
without spending tokens. **Decided** (§8).

---

## 6. Implementation phases

| Phase | Content | Done when |
|---|---|---|
| **0** | §5.1–5.9 | TranscriptView live in history viewer; headless matrix written; Claude Code + Codex headless adapters run a prompt and return validated JSON; at least two different CLIs connect the MCP shim by following the doc alone (via the wizard) and pass `pipeline_hello`; Monitor spike documented; run-state banner works |
| **1. Engine** ✅ | Machine schema + validator, run store (`runs/<runId>/state.json` + append-only `events.jsonl`), executor for all primitives (including both `commit` review variants), templating, budgets, stop modes, recovery on project open | All engine paths covered by tests with the fake CLI |
| **2. Run view** ✅ (awaits manual UI testing; a terminal-panel tab with the step tree, see §4.1, §5.8) | Step tree, live/past transcripts, escalation panel, controls, final report | A run of a hand-written machine is fully observable and controllable from the UI alone |
| **3. Orchestrator** ✅ (live acceptance: Claude Code and Codex each orchestrated a run to a real commit over MCP, woken via `pipeline_wait` — `src/main/pipeline/orchestrator.live.test.ts`; the background-monitor tier is not yet exercised live) | Pipeline MCP tools, tiered event delivery, `pipeline_start` subscription hint | Two different CLIs each complete a task end-to-end as orchestrator and are woken by events |
| **4. Authoring** ✅ (`pipeline_guide`, `_schema`, `_validate`, `_smoke`; no overlay preview mode yet) | `pipeline_guide`, `pipeline_schema`, `pipeline_validate`, `pipeline_smoke`, preview mode in overlay, starter role templates | An agent produces a valid code machine and a content machine for a real project from a user interview |
| **5. Breadth** | Headless adapters for OpenCode / Devin / others where supported; cross-vendor reviewer defaults; parallel runs (only if ever needed — they would require isolating working trees) | — |

---

## 7. Run storage layout

```
.aide/users/<user>/runs/<runId>/
  machine.json        # snapshot of the definition at start
  params.json
  state.json          # current node, visit counters, outputs, checkpoints, status
  events.jsonl        # append-only; source for the event feed and for recovery
  nodes/<nodeId>-<visit>.jsonl   # normalized transcript per agent node visit
  nodes/<nodeId>-<visit>.input.jsonl  # what the agent was sent, per CLI invocation
  nodes/<nodeId>-<visit>/inputs/ # inputs too large for the prompt
  checks/<nodeId>-<visit>.log
  report.json
```

On project open, an unfinished run is restored in **Paused** state and the
overlay is shown.

---

## 8. Decisions log

1. **User restrictions during a run** — none. Editor, terminal tabs and toolbar
   stay usable, same as with subagents; a run-state banner warns (yellow while
   executing, red while waiting on an escalation) (§5.6).
2. **Orchestrator CLI** — any agent that connects the AIDE MCP server per the
   doc (§1A).
3. **Test framework for the engine** — `vitest` + a fake headless CLI, scoped to
   the engine (§5.9).
4. **New dependencies** — `@tanstack/react-virtual` (added). `@xyflow/react`
   is not needed since machines became trees (§5.8); `@modelcontextprotocol/sdk`
   turned out to be unnecessary (§5.4).
5. **Machine format** — a tree of steps with loops, groups, `if`, `repeat` and a
   commit block, not a graph with edges (§2.3). Returning across phases is an
   explicit outer loop + `repeat`.

6. **What the orchestrator receives** — only what it acts on: events are
   limited to escalations, pause/stop and the end of a run (step progress stays
   in the report; `events --all` for debugging); every event has a one-line
   summary; escalations are clipped and point to `pipeline_output` for
   details; the report is compact by default (`detail: true` for every visit);
   tool results are text only, never duplicated as structured content.

7. **How the orchestrator waits** — blocking inside its turn (`wait` on
   start/answer/resume, or `pipeline_wait`) is the recommended mode: background
   tasks cost a read, a re-subscribe and a closing call per event (measured in
   SpaceHospital, 2026-10-10: 45 of 62 orchestrator calls were such overhead).
   A wait returns early when the user types in the orchestrator's tab, the
   end-of-run event carries the compact report, and event ids continue across
   AIDE restarts with pending escalations re-announced.

8. **Effort and early exits** — reasoning effort is a per-step (or machine
   default) setting, never hard-coded; Codex runs get model and effort
   explicitly because `--ignore-user-config` drops them (reasoning summaries are
   not available in `codex exec` at all). The
   pipeline context states the step's real budget (its time limit) and no longer
   invites "continue later" (the "finish now" advice moved to the roles, see
   decision 10); `blocked` means a named external obstacle. Catching
   a premature `blocked` stays with the orchestrator — no auto-continue rule in
   the engine.
9. **Holding, amending and limits** (deficiency report 2026-10-23) — a CLI
   usage limit holds the run (status `stopped`, reason `usage_limit`) with the
   step's session kept, and resumes by itself when the CLI's message says when
   the limit resets. A retry after an engine failure, a stop or an amendment
   continues the step's own session with a continuation note instead of
   resending the task. `pipeline_amend` adds instructions mid-run. Answering
   `stop` still ends the run; holding is not answering. A gate rejected outside
   loops holds the run at the gate. No `pause` answer and no `mayRunChecks`:
   the context now says checks need not be run, not that they must not be.
10. **The pipeline context states facts, roles state behaviour** — the generated
   context describes the machine, the step's time limit and the run's state.
   Advice on how to work ("finish everything in this visit", "plan the
   increments") is not generated: AIDE cannot know a step's purpose, and
   guessing it (from permissions, then from the output schema) misled
   reviewers. It lives in the role files; the starter roles carry it.
11. **Engine versions** — a machine declares `engineVersion`, the pipeline
   engine it was written or last reviewed for. Changes that can make existing
   machines or roles behave differently raise `ENGINE_VERSION`
   (`engine/compat.ts`) with a list of changes and actions. `pipeline_start`
   refuses an older machine with that list (`acceptOutdated: true` overrides),
   `pipeline_list` marks it, `pipeline_validate` warns, `pipeline_guide` ends
   with the history. A machine without the field counts as older than
   engine 1. Refusing rather than warning: a warning arrives with a run that
   is already going wrong.
12. **Agent inputs are bounded and isolated** (engine 4) — the `run.*` file
   inputs take include/exclude globs; an input over 100,000 characters goes to
   a file in the run directory and the prompt gets its path and file list,
   instead of a prompt the CLI refuses. Step agents start without MCP servers
   (Claude Code: `--strict-mcp-config`, claude.ai connectors off), because
   foreign server instructions contradicted roles. An `if` on params only is
   resolved in the context. An escalation answer may change params for the
   rest of the run (a split stage gets its own id). A commit counts as made
   when HEAD moved onto the old HEAD, whatever git printed (an auto gc after
   the commit once outlasted the timeout); commits run with `gc.auto=0`.

No open decisions remain; outstanding uncertainty is in the **[verify]** items,
resolved by Phase 0.
