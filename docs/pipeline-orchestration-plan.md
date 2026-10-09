# Pipeline Orchestration — Implementation Plan

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
- **A non-closable overlay** in the AIDE window always shows the running
  machine, so visibility never depends on the orchestrator remembering it.
- **Transcripts are rendered as Markdown** in a virtualized block list
  (`TranscriptView`), shared with the history viewer.

---

## 1A. Orchestrator onboarding (wizard)

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
- `nodes` and `edges` built only from the fixed primitive set (§2.3).
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
6. The user reviews the graph in the overlay's preview mode and commits the
   files.

The orchestrator may *propose* a new or changed machine during development, but
it goes through the same validate → smoke → user-approval path. A run always
**snapshots** the machine definition at start, so editing a file never affects a
run in progress.

### 2.3 Primitive node types

| Type | Behaviour |
|---|---|
| `agent` | Spawns a headless CLI with a role, inputs, optional permissions profile, output schema, turn/time budget. `session: "new"` or `"continue:<nodeId>"` (resume that node's CLI session, e.g. implementer receiving review feedback). |
| `check` | Runs a shell command in the project root; success = exit code 0; stdout/stderr captured as output. |
| `branch` | Routes on a field of a previous node's output (`outputs.review.verdict == "accept"`). |
| `gate` | Waits for an explicit decision from the orchestrator or the user. |
| `commit` | Reviews the prepared commit (staged index + message from a preceding agent) with `review: "algorithmic"` or `review: "agent"`; on success runs `git commit` and outputs the commit result; on failure outputs findings for the preparing agent (§3.3). |
| `escalate` | Emits an escalation event to `orchestrator` or `user` and pauses the run until answered. |
| `end` | Terminal node: `success` or `failure`. |

Every node may declare `maxVisits`; exceeding it routes to the node's
`onLimit` edge (normally an `escalate`). This is how loops are bounded.

Data flow: each node's output is stored as `outputs.<nodeId>`. Prompts and
commands use simple templating over `params.*`, `outputs.*` and AIDE-computed
values (`run.diff` — working tree vs HEAD including untracked files,
`run.changedFiles`, `run.iteration.<nodeId>`).

### 2.4 Static validation (`pipeline_validate`, also on load)

- Schema conformance; all referenced role files, CLIs and params exist.
- Every node is reachable from `start`; every node can reach an `end` or
  `escalate`.
- Every cycle contains a node with `maxVisits`.
- Every `branch` condition references a field guaranteed by the source node's
  output schema; every branch has a default edge.
- Every `agent` node has an output schema.
- Every `commit` node is preceded by an agent node whose output schema includes
  `commitMessage` and `excluded`, and has a failure edge back to it.
- Only CLIs that implement the headless capability (§5.2) are allowed.

### 2.5 Example (abridged)

```json
{
  "id": "code-feature",
  "name": "Code feature",
  "description": "Implements one plan stage that is pure code with automated checks. Needs a stage spec file and acceptance criteria.",
  "params": {
    "taskSpec": { "type": "path" },
    "acceptance": { "type": "string[]" },
    "scope": { "type": "glob[]" }
  },
  "start": "implement",
  "nodes": {
    "implement":  { "type": "agent", "role": "roles/implementer.md", "cli": "claude-code",
                    "inputs": ["params.taskSpec", "params.acceptance", "params.scope"],
                    "output": "implementerReport", "maxTurns": 80, "timeoutMin": 45 },
    "checks":     { "type": "check", "command": "npm run typecheck && npm run build" },
    "review":     { "type": "agent", "role": "roles/code-reviewer.md", "cli": "codex",
                    "permissions": "read-only", "session": "new",
                    "inputs": ["params.taskSpec", "params.acceptance", "run.diff"],
                    "output": "reviewVerdict", "maxVisits": 3, "onLimit": "stuck" },
    "fix":        { "type": "agent", "session": "continue:implement",
                    "inputs": ["outputs.review.blocking", "outputs.checks.stderr"] },
    "commitPrep": { "type": "agent", "session": "continue:implement",
                    "role": "roles/commit-prep.md", "output": "commitPrep",
                    "maxVisits": 3, "onLimit": "stuck" },
    "commit":     { "type": "commit", "review": "algorithmic" },
    "stuck":      { "type": "escalate", "to": "orchestrator" },
    "done":       { "type": "end", "result": "success" }
  },
  "edges": [
    ["implement", "checks", "outputs.implement.status == 'done'"],
    ["implement", "stuck",  "default"],
    ["checks", "review", "ok"], ["checks", "fix", "fail"],
    ["review", "commitPrep", "outputs.review.verdict == 'accept'"],
    ["review", "fix", "default"],
    ["fix", "checks", "default"],
    ["commitPrep", "commit", "default"],
    ["commit", "done", "ok"], ["commit", "commitPrep", "fail"]
  ]
}
```

The final format is fixed in Phase 1; this example shows the intended shape.

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
   - the whole flow as an ordered outline with the current node marked
     (`→ you are here`), including loops (`review → fix → checks → review, max 3`);
   - **what happens after you**, node by node, with what each one does —
     e.g. *"checks: AIDE runs `npm run typecheck && npm run build` after you —
     do not run them yourself"*, *"review: a separate reviewer agent inspects the
     diff"*, *"commit prep: staging and the commit message come later — do not
     stage"*;
   - **what happened before you**: iteration number of this visit, the previous
     node's outcome and findings that triggered the visit (failed check output,
     blocking review findings).

   Every node therefore carries a one-line `summary` of what it does (written
   for the agents that precede it). For `check` nodes it defaults to the
   command; for `agent` nodes it comes from the role file. `pipeline_validate`
   requires it.
5. **Boundaries stated explicitly** — scope (as guidance), "do not edit tests
   marked as acceptance tests", "if the plan is wrong, return `plan_wrong` with
   the reason instead of working around it". Boundaries that follow from the
   flow (do not run checks, do not stage, do not commit) come from the pipeline
   context automatically rather than being hand-written into every role file.

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

**Commit prep** — an `agent` node, normally `continue:implement` (the
implementer knows best what it changed and why). It stages the files that
belong to the change, updates `.gitignore` if needed, and returns:

```json
{ "commitMessage": "…", "excluded": [ { "path": "…", "reason": "…" } ] }
```

It does not commit.

**`commit` node** — a commit operation with a review layer on top. Two variants:

| Variant | Review layer |
|---|---|
| `review: "algorithmic"` | AIDE checks: index is not empty; `commitMessage` is present; **every** modified or untracked file is either staged or listed in `excluded` (a forgotten file is caught mechanically) |
| `review: "agent"` | The algorithmic checks first (cheap gate), then a reviewer agent (cheap model is fine) receives the staged diff, the message and the `excluded` list with reasons; it looks for junk in the index, unjustified exclusions, `.gitignore` changes, message quality |

Both variants behave the same at the edges:

- **Success** → AIDE runs `git commit -F <message>` on the index and outputs the
  commit result (`sha`, files, message). Nothing is returned to the implementer.
- **Failure** → outputs findings; the `fail` edge leads back to commit prep,
  which fixes staging/message. Bounded by `maxVisits` on commit prep.

Each successful `commit` node is a checkpoint in the run.

---

## 4. Q3 — Visibility

### 4.1 What the user sees

**Pipeline overlay** — appears over the editor area when a run starts; never
covers the orchestrator terminal or the file tree.

- **Graph** of the machine with node states: pending / running / succeeded /
  failed / interrupted / escalated. Loop nodes show `Review 2/3`. Elapsed time
  per node and total; token/cost figures where the CLI reports them.
- **Transcript pane** — live `TranscriptView` of the active agent node. Clicking
  any completed node shows its transcript, its structured output (verdict,
  findings) and, for `check` nodes, the command log.
- **Escalation panel** — pending question with an answer box; the same
  escalation is also delivered to the orchestrator; whoever answers first wins.
- **Controls** — Pause, Stop now (§4.3).
- **Collapsible, not closable** — collapses to a strip
  (`Code feature · Review 2/3 · 14 min`) that blinks on escalation (reuses the
  Log Panel attention pattern). Collapsing it gives the editor back, so the user
  can keep working. Becomes closable only when the run ends; at that point it
  shows the final report.
- **Editor** — unrestricted. Files changed by the run follow the existing
  external-change behaviour: a clean buffer reloads, a buffer with unsaved edits
  gets the conflict dialog.
- Pipeline events are also appended to a `pipeline` Log Panel channel.

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
| `pipeline_status(runId)` | Current node, iteration, recent events |
| `pipeline_report(runId)` | Final report (§4.4) |
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

### 5.5 Orchestration MCP doc + wizard — **done** (UI awaits manual testing)

Implemented: `resources/docs/orchestration-mcp.md` (deployed to
`.aide/docs/` on project open), **CLI → Set Up Orchestration…** menu item and
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

### 5.8 Graph rendering spike

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
| **1. Engine** | Machine schema + validator, run store (`runs/<runId>/state.json` + append-only `events.jsonl`), executor for all primitives (including both `commit` review variants), templating, budgets, stop modes, recovery on project open | All engine paths covered by tests with the fake CLI |
| **2. Overlay** | Graph, live/past transcripts, escalation panel, controls, collapsed strip, final report | A run of a hand-written machine is fully observable and controllable from the UI alone |
| **3. Orchestrator** | Pipeline MCP tools, tiered event delivery, `pipeline_start` subscription hint | Two different CLIs each complete a task end-to-end as orchestrator and are woken by events |
| **4. Authoring** | `pipeline_guide`, `pipeline_schema`, `pipeline_validate`, `pipeline_smoke`, preview mode in overlay, starter role templates | An agent produces a valid code machine and a content machine for a real project from a user interview |
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
4. **New dependencies** — `@tanstack/react-virtual` (added) and `@xyflow/react`
   (+ a layout library, Phase 2) are accepted; each is confirmed when it is
   first relied on. `@modelcontextprotocol/sdk` turned out to be unnecessary (§5.4).

No open decisions remain; outstanding uncertainty is in the **[verify]** items,
resolved by Phase 0.
