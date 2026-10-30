# AIDE Orchestration — MCP Guide

This document is for an **AI agent** that drives AIDE pipelines in this project:
the **Strategist**. It explains how AIDE's MCP server reaches you, what you do,
and how to receive pipeline events. In a plan, the **Orchestrator** is a separate
short-lived agent: it checks each task, and when the plan lets it, answers the
decisions inside a step before they reach you (see `plan_guide`). Machine files
send decisions to `agent` (you, or the plan's Orchestrator first) or `user`.

AIDE keeps this file up to date; do not edit it.

## 1. What you are connecting to

AIDE (the editor this project is open in) executes **pipeline machines**:
deterministic trees of steps run by headless agents — e.g. a loop of implement →
checks → review, then commit — defined per task type in `aide/pipelines/*.json`.
AIDE runs the steps and repeats the loops; it makes no judgement calls.

The **Strategist** is the agent that decides what gets done. Work of several tasks
goes into an AIDE plan (`aide/plans/*.json`, `plan_guide`): AIDE walks it, and after
each task an Orchestrator, a headless agent with no context of its own, checks the
result and starts the next machine or wakes you; it can also answer escalations
inside a task's run and pass on to you what it cannot decide. For one concrete task, plan or no
plan, you start a machine yourself with `pipeline_start`. Any agent with MCP support
can be the Strategist.

## 2. The MCP server is already connected

AIDE gives its MCP server, `aide`, to every CLI tab it launches (a per-CLI
setting in AIDE, on by default), with the paths of the running AIDE. You do not
register anything: if you run in an AIDE tab, the `pipeline_*` tools are there.
The server carries pipeline orchestration and may carry other AIDE tools later.

Turn to orchestration when the user asks for it or for a pipeline, or when a
task is big enough for several agent steps with checks and review (a feature
across many files, a series of plan items).

The server is a small **stdio shim** that finds the AIDE instance serving the
project by itself; AIDE passes it the tab and the project. For a session
started outside AIDE, the server entry is:

| Field | Value |
|---|---|
| transport | stdio |
| command | the AIDE executable (absolute path) |
| args | `["<path to aide-mcp.cjs>", "mcp"]` |
| env | `ELECTRON_RUN_AS_NODE=1`, `AIDE_RUNTIME_DIR=<AIDE runtime directory>` |
| server name | `aide` |

Such an entry holds paths of one AIDE installation and goes stale when AIDE
moves; AIDE tabs do not need it.

**Long tool calls.** Waiting for a run is a tool call that blocks for up to 50
minutes (§5). AIDE raises Codex's MCP call timeout for its tabs; for other
clients that cut long calls, pass a smaller `timeoutSec` / `wait` than their
limit.

## 3. Verify

Call the tool **`pipeline_hello`**. A successful call confirms the connection
to AIDE and returns the Strategist's rules and the event-delivery options. If
the tool is missing, the server is off for this CLI in AIDE's settings, or the
tab was started before AIDE's server was up — ask the user. If it answers "AIDE
is not running for this project", the project is not open in AIDE.

## 4. Strategist rules

1. AIDE runs machines; you choose them. Do not re-implement a machine's work
   yourself while it runs.
2. **While a run is executing, leave the working tree to it — do not edit
   files.** AIDE shows the user a warning banner during that time.
3. Escalations from a run come to you first. Answer them when the answer is
   within the plan; ask the user otherwise.
4. Read each run's result: the end-of-run event carries the compact report
   (commits, visits per step, loop iterations, check results, decisions, agent
   summaries, non-blocking findings). Read all of it: when you wait in code,
   return the report whole rather than a few fields. Recurring findings are
   your signal to plan a refactoring task.
5. **Keep each cycle to the few calls it needs.** Every call re-reads your whole
   context. Do not re-verify what the machine's checks and reviewers verified:
   a check listed as passed in the report's `checks` ran on the final code, so
   do not run its command again;
   look yourself only on a signal (a reviewer flagged something, the first
   capture of a new visual stage, a failed run).
6. Keep the plan in an AIDE plan (`plan_create`, `plan_edit`), not only in your
   context — your session may be restarted at any time. A run linked to a task
   marks it done in its own commit, so nobody does that bookkeeping by hand.
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

**While a plan's autopilot is on, call `pipeline_wait` without `runId`**: runs change,
and without `runId` the wait covers every run and the plan.

**A timeout is part of waiting.** After 50 minutes the wait returns one line of state.
It means nothing needs checking: wait again with the same `since`. The tick reads your
cached context and keeps it warm, which costs far less than a cold wake. If it says your
cache lives only 5 minutes, stop waiting and end your turn: AIDE types events into your
terminal instead.

Always pass the last event id you have seen as `since`, also when you wait
without `runId`; without it the wait starts from the oldest event still kept. An
event dealt with since (the escalation answered, the plan continued, the run
resumed) is not handed out again. Ids continue across
AIDE restarts; after a restart AIDE re-announces a pending escalation or the
paused run, so a wait that was cut by the restart picks it up.

**Only events that need you are delivered** — everything else would just fill
your context:

| Event | What to do |
|---|---|
| `plan_attention` | A plan holds and needs you (`kind`, `reason`, `proposal`): change it with `plan_edit` if needed, then `plan_run` with a `note` |
| `escalation` | Decide: answer with `pipeline_answer`, or ask the user. One the plan's Orchestrator passed on carries `orchestrator`: its `reason`, its `proposal`, or in shadow mode `wouldAnswer` |
| `run_paused`, `run_stopped` | The run changed hands (possibly the user paused or stopped it in AIDE, or a gate was rejected outside loops); resume when appropriate. `reason: "usage_limit"`: a CLI hit its usage limit — the run resumes by itself at `resumeAt` (when the CLI said when) in the same session; otherwise resume once it has reset. When the user set up several accounts of that CLI, AIDE switches to another one and goes on without telling you (it restarts that CLI's tabs, yours included: wait again afterwards); you get `run_stopped` only when none of them can go on |
| `run_finished`, `run_failed` | The event's `report` has the result (`pipeline_report detail: true` only when you need every visit). A step of a plan's autopilot does not send these: the plan goes on, or sends `plan_attention` |

Step progress (`node_started`, `node_finished`, `check_failed`, `loop_repeated`,
`commit_done`) is not delivered: loops handle failed checks and review findings
themselves, and the report has the outcome. `events --all` streams it for
debugging.

Neither is `step_retrying`: when a step's CLI is temporarily unavailable (model
at capacity, overloaded, network errors), AIDE retries the step every minute in
its session and says nothing. `pipeline_status` shows it as `unavailable` (since
when, attempts, last error). Only after 20 minutes without success do you get an
`engine` escalation; `retry` then makes one more attempt.

Every event has a one-line `summary`. An escalation carries its `kind`, a
clipped `message`, the allowed `actions`, and — when a step's output explains
it — `source` with a ready `pipeline_output` call for the details:

- `step` — a step asks for a decision (e.g. the implementer reports
  `plan_wrong`, or a check failed outside any loop): continue / retry / stop;
- `gate` — approval: continue / reject / stop;
- `limit` — a loop used up its iterations: retry (one more) / continue (accept
  as it is) / stop;
- `engine` — a step could not run (CLI crash, stream disconnect, unusable
  output): retry (the step continues its failed session with "continue from
  where you stopped", so finished work is not redone) / stop.

**Holding a run.** `stop` as an answer ends the run for good. To keep it without
deciding yet, do not answer: a run waiting on an escalation does nothing and
survives AIDE restarts. A run stopped with `pipeline_stop` while an escalation is
open asks for the answer again on resume.

**Events as messages.** If an event that needs you arrives while you are not
waiting (no `pipeline_wait` or event stream open) and your session is idle, AIDE
types it into your terminal as a message starting with "AIDE pipeline:" — act on
it as on a waited event, then wait again with the `since` it gives. Waiting
yourself is still the way: it delivers the event at once and nothing is typed.

**Changing course mid-step.** A new requirement or a ruling while a step works:
`pipeline_amend` with the text. A running agent step is interrupted and
continues at once in its own session with the instruction; every later step
sees it. This replaces stop, abandon, edit and restart.

## 6. Tools

| Tool | Purpose |
|---|---|
| `pipeline_hello` | Handshake; returns rules and event delivery options |
| `pipeline_list` | Machines with descriptions (when to use them), params, validity |
| `pipeline_start` | Start a run: `{ machine, params, planTask?, wait?, acceptOutdated? }` → run id (and with `wait`, its next event). A machine written for an older pipeline engine is refused with what changed since; review it with the user, raise its `engineVersion`, or pass `acceptOutdated: true` |
| `pipeline_status` | Current step, loop iterations, visits per step, pending escalation, last events |
| `pipeline_wait` | Block until the next event that needs you, the user typing (`user_input`), or a timeout (one line of state). Without `runId`: the whole project |
| `pipeline_answer` | Answer an escalation: `continue` (go on; approve a gate; leave an exhausted loop as it is), `retry` (run the step again; one more loop iteration), `reject` (gates), `stop` (ends the run). `params` changes machine params for the rest of the run (e.g. the stage id after approving a split) |
| `pipeline_amend` | Add an instruction to the run; a running agent step continues with it in its session |
| `pipeline_reload` | The active run uses its edited machine file for the steps to come (paused, stopped or waiting runs). Role files are read at every visit and need no reload |
| `pipeline_stop` | `pause` (after the current step), `stop` (now, resumable), `abandon` (lists the uncommitted files left) |
| `pipeline_resume` | Continue a paused or stopped run (`wait` as for start) |
| `pipeline_report` | Compact report: result, commits, visits per step, loops, summaries, findings (first 20), pipeline issues, instructions added, decisions, cost; `detail: true` is the full report |
| `pipeline_output` | Details on demand: the output of one step visit (agent JSON, check log tail, commit result) |
| `pipeline_runs` | Recent runs |
| `pipeline_guide` / `pipeline_schema` | How to author machines; the machine file schema |
| `pipeline_validate` / `pipeline_smoke` | Check machines statically / on this computer |
| `plan_guide` | How plans work; read before writing one |
| `plan_list` / `plan_status` / `plan_get` | The plans; progress in a few fields; a plan or one task |
| `plan_create` / `plan_edit` | Create a draft; change a plan with a batch of operations (`baseRevision`, `ops`) |
| `plan_approve` / `plan_activate` | A draft becomes approved once the user agrees; one approved plan is active |
| `plan_run` / `plan_pause` | Start or continue the autopilot of the active plan (`note`, `wait`); hold it after the running step |

## 7. Typical session

1. If the project has no machines yet, read `pipeline_guide` and prepare them with
   the user first.
2. Several tasks: `plan_guide`, `plan_create`, the user agrees, `plan_approve`,
   `plan_activate`, `plan_run` with `wait`, then `pipeline_wait` without `runId`.
3. On `plan_attention`: decide, `plan_edit` if the plan must change, `plan_run` with a
   note. On `escalation`: `pipeline_answer` (with `wait`) if the plan decides it,
   otherwise ask the user.
4. One concrete task: `pipeline_list`, `pipeline_start` with its params and `wait`
   (`plan_pause` first if an autopilot is on).

`tools/list` always shows what the running AIDE version actually provides.

## 8. Orchestrating economically

The Strategist's knowledge of the project — its decisions and their reasons —
is what makes it effective, so its context is usually large and keeps growing.
**Every API call you make re-reads that whole context** (from the prompt cache,
but still in full). The cost of orchestration is therefore *calls per cycle ×
context size*, and the lever is the number of calls, not the context.

Measured in a real project: with a ~250–300k context, about 45 of 62
Strategist calls over six runs were overhead, and orchestration used more of
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
