# Plans

A plan is what a project moves along and what shows its progress. AIDE owns the plan as an
object; it does not wrap each harness's own planning mode. A model may think in its own plan
mode, but what it hands over is the same JSON file.

Status: implemented. The agent-facing guide is `resources/docs/plan-guide.md`
(the `plan_guide` tool); orchestration is `docs/pipeline-orchestration-plan.md`.

## Roles

| Role | What it is | What it does |
|---|---|---|
| **Strategist** | An interactive agent in a CLI tab, with the long context | Writes and changes plans, answers run escalations, handles what the Orchestrator wakes it for |
| **Orchestrator** | A headless agent in a new session for every call, with no context of its own | Wakes when a plan step ends, checks it against the whole plan, starts the next step's pipeline or wakes the Strategist. When the plan lets it, answers escalations inside a step's run or passes them on. Never changes the plan, never stops a run |
| **AIDE** | Deterministic code | Keeps the order of tasks, starts machines, writes statuses, stops the plan |
| **Pipeline** | A machine run | Does one task |

Machine files send a decision to `agent` (the default) or `user` (`escalateTo`, gate
`to`). `agent` is the Orchestrator when the run is a step of the plan's autopilot and the
plan lets it answer that kind, the Strategist otherwise. Engine 5 and older called it
`orchestrator`; runs from then are read with "orchestrator" as the Strategist. Answers and
instructions are recorded as by `strategist`, `orchestrator` or `user`.

## The plan file

`aide/plans/<id>.json`, committed. AIDE writes it, through MCP tools and the plan tab; nobody
maintains its formatting by hand. A hand edit is picked up at the next read; an invalid file is
shown as an error and AIDE refuses to write to it until it is fixed.

```json
{
  "id": "rendered-preview",
  "title": "Rendered preview",
  "goal": "Show rendered artifacts next to Edit and Diff",
  "spec": "docs/rendered-preview-spec.md",
  "state": "approved",
  "revision": 4,
  "orchestrator": {
    "cli": "claude-code",
    "model": "<id>",
    "effort": "low",
    "prompt": "Check that the step met its acceptance and that the next task still applies.",
    "maxUnreviewed": 5,
    "shadow": true,
    "escalations": ["step", "limit"]
  },
  "tasks": [
    {
      "id": "csp",
      "title": "Protocol and CSP for project files",
      "status": "pending",
      "phase": "Viewer",
      "after": ["kinds"],
      "machine": "code-feature",
      "params": { "scope": ["src/main/**"] },
      "spec": "docs/rendered-preview-spec.md#csp",
      "acceptance": ["Images from the project load in Render view"],
      "checkpoint": false
    }
  ],
  "followups": [{ "id": "f1", "text": "Finding", "from": "csp", "at": "2026-10-30T12:00:00.000Z" }]
}
```

- `state`: `draft | approved | done | dropped`. A draft cannot be activated.
- Task `status`: `pending | done | blocked | dropped`, with an optional `reason`. Live states
  (running, waiting on a decision) are never in the file: they come from the run.
- `revision` counts edits by the Strategist and the user. AIDE's own status writes and follow-ups
  do not count, so a run finishing never fails the next `plan_edit`.
- Long reasoning does not belong in JSON. `spec` points at a document: on a task, the
  task's description; on the plan, where the whole plan is going.

Files under `aide/plans/` are left out of the run's diff, its changed files, the dirty-tree
warning and the commit coverage check: a plan edit is not part of a run's work.

## Per-user state

`.aide/users/<user>/plans/`:

```
active.json                    which plan is active
<planId>/autopilot.json        autopilot state of that plan
<planId>/journal.jsonl         decisions, runs, attentions, notes
<planId>/decisions/<n>/        run dir and transcript of each Orchestrator call
```

One plan is active per user per project. The pointer is per-user so collaborators on a shared
folder do not switch plans for each other. Activating does not start anything. Switching is
refused while the autopilot of the current plan is working; progress of the plan left behind
stays, because statuses are in its file and its autopilot state is per plan.

## Editing

`plan_edit(planId, baseRevision, ops[])` applies a batch atomically; every batch is validated at
once (unique ids, known dependencies, no cycles), so there is no separate validate step.

| Op | Effect |
|---|---|
| `add` | Add a task, optionally `before` another |
| `update` | Change fields of a task, including its status |
| `move` | Change a task's position |
| `split` | Replace a task with several; each inherits its dependencies besides its own `after`, its dependants wait for the last one |
| `drop` | Set `dropped` with a reason |
| `set` | Change `title`, `goal`, `spec`, `orchestrator` |
| `dismiss` | Remove a follow-up |

The task a running step works on cannot be changed. The result carries the new revision and the
changed tasks, not the whole plan.

## Progress: facts, not self-reports

`pipeline_start` takes an optional `planTask: {plan, task}`. For a run linked this way:

- The last commit step of the machine marks the task `done` and adds the run's non-blocking
  findings to `followups` inside the task's commit, with a `Plan-Task: <plan>/<task>` trailer. The
  commit prep agent does no plan bookkeeping.
- If the run ends with success without such a commit, the task is marked `done` in the working
  tree.

## Autopilot

`plan_run(planId?, note?)` starts the autopilot of the active plan, `plan_pause` holds it after
the current step.

```
plan_run ─▶ Orchestrator (new session) ─▶ next ─▶ pipeline of the task ─▶ run ends ─┐
                 ▲        │                                                         │
                 │        └▶ wake ─▶ plan_attention, plan holds                     │
                 └──────────────────────────────────────────────────────────────────┘
```

**Code can only wake the Strategist; only the model can say continue.** AIDE holds the plan and
sends `plan_attention`, without a model call, when a run failed; the next task has no machine, or
its machine is unknown or invalid; a task with `checkpoint: true` ended; `maxUnreviewed` tasks
(default 5) ended in a row since the Strategist last acted; or no task is left. A failed or invalid
Orchestrator answer also wakes it. Escalations inside a run go to the Strategist as before.

### The Orchestrator's call

A fresh session, read-only, no MCP, 15 minutes. The prompt starts with `orchestrator.prompt`, which
says what to check and when to wake; generated facts follow: the plan's title, goal and `spec`,
every task with its spec, acceptance and machine, the open follow-ups, the last report, commits
made outside the plan, the journal (including its own earlier answers to escalations) and the
Strategist's note. It may read the project's files. The answer's schema is generated from the next
machine's params that the plan leaves open:

```json
{ "verdict": "next", "reason": "…", "proposal": "", "handoff": "…", "params": { "taskSpec": "…" } }
{ "verdict": "wake", "reason": "…", "proposal": "Split csp in two", "handoff": "", "params": { "taskSpec": null } }
```

AIDE validates the params against the machine (a param written in the plan wins) with one retry in
the same session, then starts the run. The task's title, spec and acceptance and the `handoff` reach
every step of the run as a run instruction.

### Escalations inside a step

`orchestrator.escalations` lists the kinds (`step`, `gate`, `limit`, `engine`) the Orchestrator
answers first in a run the autopilot started. An escalation for `agent` of such a kind is then
not announced to the Strategist (its event is quiet). AIDE calls the Orchestrator, numbered with
the plan's decisions, with the plan as above, the task, the run so far (compact report), the
earlier decisions of the run, the escalation's message and the output of the step visit that
raised it:

```json
{ "verdict": "answer", "action": "retry", "text": "Create the file; the spec means src/new.ts.", "reason": "…", "proposal": "" }
{ "verdict": "escalate", "action": null, "text": "", "reason": "…", "proposal": "Drop the file from the spec" }
```

- `action` is one of the escalation's actions without `stop`: the Orchestrator never ends a run.
- `answer` is given as `pipeline_answer` would, by `orchestrator`; its text reaches every later step.
- `escalate`, an unusable answer or a failed call announce the escalation to the Strategist, with
  `orchestrator: { status, reason, proposal }` in the event.
- Shadow mode: the answer is not given; the escalation goes to the Strategist with `wouldAnswer`.
- After three answers to escalations of the same step in a run, AIDE passes the next one on
  without a call: a step that keeps coming back needs more than another answer.
- Decisions a machine addresses to `user`, and runs outside the autopilot, never reach it.
- Whoever answers first wins: an answer from the user or the Strategist while the Orchestrator
  decides makes its answer void (noted in the journal). When the run ends, the call is cancelled;
  when AIDE restarts, the escalation is announced again and the Orchestrator asked again.

The escalation records what the Orchestrator did (`orchestrator` on the escalation in the run
state); views say whom it waits for. The autopilot state has `answering` while a call runs.

### Shadow mode

With `orchestrator.shadow`, a `next` decision is not carried out: the plan holds, and `plan_attention`
carries the decision. `plan_run` carries it out, unless the plan's revision changed or `redecide: true`
is passed, when the Orchestrator is asked again. Use it to see how well the Orchestrator's judgement
holds before letting it go on alone.

### Runs outside the plan

`pipeline_start` without `planTask` touches nothing in the plan. While a plan step runs it is refused
as any second run is; `plan_pause` first. If the Orchestrator is deciding when such a run starts, the
call is cancelled and the plan holds. A held plan resumes only on `plan_run`, and the next Orchestrator
sees the commits made since the last step.

## Waiting

`pipeline_wait` without `runId` waits for every event of the project that needs the Strategist,
including `plan_attention`. The result of a step that went well is not such an event, nor is an
escalation the Orchestrator answers. An event that was dealt with since it was emitted (the
escalation answered, the plan continued with `plan_run`, the run resumed) is marked resolved and
not handed out again, so a wait from an old `since` does not return it.

The wait is capped at 50 minutes, under the 1-hour prompt-cache lifetime: a timeout is a cheap read
that keeps the cache warm, while a cold wake rewrites the context at twice the input price. A
timeout returns one line of state and tells the agent to wait again; AIDE does not stop waking it
during a long task, because corrections are frequent and ticks stay cheap once run context bypasses
the Strategist.

The exception is a 5-minute cache (Claude Code in usage overage): every tick would then be a full
write. When the last call of the waiting Claude Code session wrote its cache with the 5-minute TTL
only, the timeout tells the agent to stop waiting; events reach it as typed messages (`EventRelay`).

## Views

The plan is the parent of the pipeline. The desktop pipeline tab is there as soon as the project has
a plan: the plans and the active plan's tasks on the left, the run on the right. A task's history
lists the Orchestrator's calls and the runs; a run opens with its whole step tree, transcripts and
report, and a call opens as its transcript and answer, live while it runs. The remote pipeline page
shows the same above the current run: tasks, their history, the step visits of each run, the
transcript of any visit and any Orchestrator call, and it can continue, pause, approve and activate.

## Measurements behind the wait

An Opus 5.5 session in a real project, context 167k, 194 idle ticks (2026-10-30): one tick is two API
calls (Claude Code moves an MCP call that lasts over 120 s to the background and the model answers
again), about $0.09 at list price; a cold wake writes about 137k at twice the input price, about $1.10.
