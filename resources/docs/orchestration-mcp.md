# AIDE Orchestration — MCP Connection Guide

This document is for an **AI agent** that is asked to become the orchestrator of
AIDE pipelines in this project. It explains how to connect AIDE's MCP server to
yourself, what the orchestrator does, and how to receive pipeline events.

AIDE keeps this file up to date; do not edit it.

## 1. What you are connecting to

AIDE (the editor this project is open in) executes **pipeline machines**:
deterministic trees of steps run by headless agents — e.g. a loop of implement →
checks → review, then commit — defined per task type in `aide/pipelines/*.json`.
AIDE runs the steps and repeats the loops; it makes no judgement calls.

The **orchestrator** is the agent that decides what to run: it reads the
project's plan, picks the next task, chooses a machine and its parameters,
starts it, reads the report, updates the plan, and talks to the user. Any agent
with MCP support can be the orchestrator.

## 2. Connect the MCP server

AIDE exposes its MCP server through a small **stdio shim**. It finds the AIDE
instance serving the current project by itself, so your configuration never
contains a port, a token, or a project path.

The exact command, arguments and environment are given to you in the setup
prompt AIDE opened this session with. Their shape:

| Field | Value |
|---|---|
| transport | stdio |
| command | the AIDE executable (absolute path) |
| args | `["<path to aide-mcp.cjs>", "mcp"]` |
| env | `ELECTRON_RUN_AS_NODE=1`, `AIDE_RUNTIME_DIR=<AIDE runtime directory>` |
| server name | `aide` |

Register it in **your own** MCP configuration, preferably with **project
scope**, so it applies only to this project. Use your CLI's normal mechanism.
For reference:

- **Claude Code**: `claude mcp add --scope project -e ELECTRON_RUN_AS_NODE=1 -e AIDE_RUNTIME_DIR=<dir> aide -- "<aide.exe>" "<aide-mcp.cjs>" mcp`
  (writes `mcpServers.aide` into the project's `.mcp.json`).
- **Codex**: `codex mcp add aide --env ELECTRON_RUN_AS_NODE=1 --env AIDE_RUNTIME_DIR=<dir> -- "<aide.exe>" "<aide-mcp.cjs>" mcp`
  (writes `[mcp_servers.aide]` into the user config; this is fine — the shim
  serves whichever AIDE project the session runs in).
- **Other CLIs**: the stdio server entry of their MCP configuration with the same command, args and env.

Because the shim finds the project from the session's working directory, a
user-scope registration works for every project; project scope is preferred
only to keep other projects' agents from seeing an `aide` server.

Do not add a `cwd`: the shim uses the working directory of your session to find
the project.

**Allow long tool calls.** Waiting for a run is a tool call that blocks for up to
30 minutes (§5). Clients cut long calls at different points:

- **Codex** stops MCP calls after 60 s by default: add `tool_timeout_sec = 1900`
  to `[mcp_servers.aide]` in its config.
- **Claude Code** (CLI) allows long calls by default; if yours cuts them, set
  `MCP_TOOL_TIMEOUT` (milliseconds) in its environment.
- Otherwise pass a smaller `timeoutSec` / `wait` than your client's limit.

Most CLIs load MCP servers only when a session starts. If yours does, tell the
user that the session must be restarted (AIDE offers a **Restart tab** button)
and stop there; after the restart, continue with step 3.

## 3. Verify

Call the tool **`pipeline_hello`**. A successful call confirms the connection
to AIDE (the setup dialog in AIDE shows it) and returns the orchestrator rules
and the event-delivery options. If the tool is missing, the server is not
loaded yet — restart the session. If it answers "AIDE is not running for this
project", the project is not open in AIDE.

## 4. Orchestrator rules

1. AIDE runs machines; you choose them. Do not re-implement a machine's work
   yourself while it runs.
2. **While a run is executing, leave the working tree to it — do not edit
   files.** AIDE shows the user a warning banner during that time.
3. Escalations from a run come to you first. Answer them when the answer is
   within the plan; ask the user otherwise.
4. Read each run's result: the end-of-run event carries the compact report
   (commits, visits per step, loop iterations, decisions, agent summaries,
   non-blocking findings). Recurring findings are your signal to plan a
   refactoring task.
5. **Keep each cycle to the few calls it needs.** Every call re-reads your whole
   context. Do not re-verify what the machine's checks and reviewers verified;
   look yourself only on a signal (a reviewer flagged something, the first
   capture of a new visual stage, a failed run).
6. Keep the plan and its progress in the project's documents, not only in
   your context — your session may be restarted at any time. Prefer machines
   that do the bookkeeping themselves (see `pipeline_guide`).
7. **Do not give step agents a way out.** Task texts and params such as "if
   you cannot finish, escalate" are taken within a minute. Real obstacles have
   `blocked` / `plan_wrong` and escalations. When an implementer reports
   `blocked` without naming a real obstacle, that is your call to make: retry
   the step with a concrete instruction to start implementing.

## 5. Waiting for runs

Every call you make re-reads your whole context, so the way you wait decides
most of the cost. Cheapest first:

1. **Block inside your turn.** Pass `wait` (seconds) to `pipeline_start`,
   `pipeline_answer` or `pipeline_resume` — they act, then return the run's next
   event — or call `pipeline_wait`. The event is the result of the call: no
   output files to read, no re-subscribing, no extra turn. A cycle then costs
   one or two calls:
   - run finished → (update the plan if the machine does not) →
     `pipeline_start` with `wait`;
   - escalation → `pipeline_answer` with `wait`.

   **The user is not locked out.** When the user types in your terminal, the
   wait returns early with `{"type": "user_input"}` and their message reaches you
   right after; handle it, then wait again with the same `since`.
2. **Background command / monitor**, if your client cannot block on a tool call
   for long: run the launcher from the `pipeline_hello` result —
   `"<launcher>" events --run <runId> --since <lastEventId>` (one JSON line per
   event that needs you) or `"<launcher>" wait --run <runId> --since
   <lastEventId>` (prints the next one and exits). Each wake-up costs extra
   calls (read the output, subscribe again, end the turn).
3. **Polling**: `pipeline_status`.

Always pass the last event id you have seen as `since`. Ids continue across
AIDE restarts; after a restart AIDE re-announces a pending escalation or the
paused run, so a wait that was cut by the restart picks it up.

**Only events that need you are delivered** — everything else would just fill
your context:

| Event | What to do |
|---|---|
| `escalation` | Decide: answer with `pipeline_answer`, or ask the user |
| `run_paused`, `run_stopped` | The run changed hands (possibly the user paused or stopped it in AIDE); resume when appropriate |
| `run_finished`, `run_failed` | The event's `report` has the result; update the plan (`pipeline_report detail: true` only when you need every visit) |

Step progress (`node_started`, `node_finished`, `check_failed`, `loop_repeated`,
`commit_done`) is not delivered: loops handle failed checks and review findings
themselves, and the report has the outcome. `events --all` streams it for
debugging.

Every event has a one-line `summary`. An escalation carries its `kind`, a
clipped `message`, the allowed `actions`, and — when a step's output explains
it — `source` with a ready `pipeline_output` call for the details:

- `step` — a step asks for a decision (e.g. the implementer reports
  `plan_wrong`, or a check failed outside any loop): continue / retry / stop;
- `gate` — approval: continue / reject / stop;
- `limit` — a loop used up its iterations: retry (one more) / continue (accept
  as it is) / stop;
- `engine` — a step could not run (CLI crash, usage limit, unusable output):
  retry / stop.

## 6. Tools

| Tool | Purpose |
|---|---|
| `pipeline_hello` | Handshake; returns rules and event delivery options |
| `pipeline_list` | Machines with descriptions (when to use them), params, validity |
| `pipeline_start` | Start a run: `{ machine, params, wait? }` → run id (and with `wait`, its next event) |
| `pipeline_status` | Current step, loop iterations, visits per step, pending escalation, last events |
| `pipeline_wait` | Block until the next event that needs you, the user typing (`user_input`), or a timeout |
| `pipeline_answer` | Answer an escalation: `continue` (go on; approve a gate; leave an exhausted loop as it is), `retry` (run the step again; one more loop iteration), `reject` (gates), `stop` |
| `pipeline_stop` | `pause` (after the current step), `stop` (now, resumable), `abandon` |
| `pipeline_resume` | Continue a paused or stopped run (`wait` as for start) |
| `pipeline_report` | Compact report: result, commits, visits per step, loops, summaries, findings, decisions, cost; `detail: true` adds every visit |
| `pipeline_output` | Details on demand: the output of one step visit (agent JSON, check log tail, commit result) |
| `pipeline_runs` | Recent runs |
| `pipeline_guide` / `pipeline_schema` | How to author machines; the machine file schema |
| `pipeline_validate` / `pipeline_smoke` | Check machines statically / on this computer |

## 7. Typical session

1. `pipeline_list` — pick the machine that fits the next task of the plan.
2. `pipeline_start` with its params and `wait`.
3. On `escalation`: answer it with `pipeline_answer` (with `wait`) if the plan
   decides it, otherwise ask the user. On `run_finished` / `run_failed`: read the
   event's report, update the plan if the machine did not, start the next task
   with `wait`.
4. If the project has no machines yet, read `pipeline_guide` and prepare them
   with the user first.

`tools/list` always shows what the running AIDE version actually provides.

## 8. Orchestrating economically

The orchestrator's knowledge of the project — its decisions and their reasons —
is what makes it effective, so its context is usually large and keeps growing.
**Every API call you make re-reads that whole context** (from the prompt cache,
but still in full). The cost of orchestration is therefore *calls per cycle ×
context size*, and the lever is the number of calls, not the context.

Measured in a real project: with a ~250–300k context, about 45 of 62
orchestrator calls over six runs were overhead, and orchestration used more of
the Claude limit than all pipeline agents together. Prompt-cache expiry was not
the cause: with a 1-hour cache, wake-ups after 4–10 minute waits were all
cache hits.

Rules:

- **Wait with `pipeline_wait`** (§5). A background launcher `wait` costs a
  turn per event: read the output file, renew the subscription, close the
  turn — three calls before any decision. Note for Claude Code: it moves an
  MCP call that runs longer than 120 s to the background and delivers the
  result in the task notification. `pipeline_wait` therefore does not keep the
  turn open, but the event arrives inside the notification, so the output-file
  read disappears. Measured: an escalation costs 2 calls (answer and the next
  `pipeline_wait` in one message, then a short note), a finished run 3–4.
- **Let the pipeline do the bookkeeping.** Marking the task done, recording
  review findings as follow-ups and logging issues are edits the commit prep
  agent can make inside the task's commit (see `pipeline-authoring.md` §4).
  Do not re-edit plan rows after every run.
- **A finished run:** `pipeline_report` → next `pipeline_start` →
  `pipeline_wait`. Inspect files only when the report gives a reason (a
  reviewer flagged something, a visual result deserves a look).
- **An escalation:** the event's clipped message is often enough; call
  `pipeline_output` only when it is not. Send `pipeline_answer` and the next
  `pipeline_wait` in the same message.
- **Batch independent calls** into one message; put progress notes for the
  user into the same message as the next tool call instead of a separate turn.
- **Never start a run in the same batch as edits it depends on**: if an edit
  fails, the run starts on stale documents.
