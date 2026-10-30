# AIDE Plans

A plan is what a project moves along and what shows its progress. It is a JSON
file, `aide/plans/<id>.json`, that AIDE writes; you change it with tools, never
by hand. Think the way you think best, in your client's own plan mode if it has
one; what you hand over is this plan.

If your client's plan mode forbids tool calls that change something, finish
planning, leave that mode, then call `plan_create`.

## Who does what

- **Strategist** (you): writes and changes the plan, answers what the runs and
  the Orchestrator bring you, talks to the user.
- **Orchestrator**: a headless agent in a new session, with no context of its
  own. It wakes when a task ends, checks all is well against the prompt you wrote
  into the plan, and starts the next task's machine or wakes you. When the plan
  lets it, it also answers the escalations inside a task's run (a blocked
  implementer, a loop at its limit) and passes on to you what it cannot decide.
  It never changes the plan and never stops a run.
- **AIDE**: keeps the order, starts machines, marks tasks done, holds the plan.

## Writing a plan

1. Read the project and agree the goal with the user.
2. Make sure machines exist for the work (`pipeline_list`, `pipeline_guide`).
3. `plan_create` with the tasks: the plan starts as a draft. Give it a `goal`
   and, for more than a few tasks, a `spec`: the document that says where the
   whole plan is going. The Orchestrator reads both with every decision.
4. Show it to the user. Once they agree: `plan_approve`, `plan_activate`.
5. `plan_run` with `wait`, or walk it by hand with `pipeline_start` and
   `planTask`.

### Tasks

```json
{
  "id": "csp",
  "title": "Protocol and CSP for project files",
  "phase": "Viewer",
  "after": ["kinds"],
  "machine": "code-feature",
  "params": { "scope": ["src/main/**"] },
  "spec": "docs/rendered-preview-spec.md#csp",
  "acceptance": ["Images from the project load in Render view"],
  "checkpoint": false
}
```

- **Write each task so someone who knows nothing can do it.** The Orchestrator
  and the step agents do not have your context. What you know must be in `spec`
  and `acceptance`, not in your head.
- **Long text goes into a document** and `spec` points at it. Your reasoning
  belongs there too.
- `machine` is required for the autopilot: a task without one wakes you. Params
  you fix in `params` win; the Orchestrator fills the ones you leave open from
  the spec and the last step.
- `checkpoint: true` wakes you after the task. Put one where a wrong turn would
  be expensive: the end of a phase, the first task of a new kind. The Orchestrator
  sees one step at a time and cannot notice a slow drift; you can.

### The Orchestrator's prompt

```json
"orchestrator": {
  "cli": "claude-code",
  "model": "<a mid-size model>",
  "effort": "low",
  "prompt": "Check that the step met its acceptance and that the next task still makes sense after it. Wake the Strategist if the step changed something a later task relies on, or if the report shows a recurring finding.",
  "maxUnreviewed": 5,
  "shadow": true,
  "escalations": ["step", "limit"]
}
```

- The prompt says **what to check and when to wake you**. It is this plan's policy:
  stricter for a risky migration, looser for routine work.
- AIDE adds the facts: tasks, the last report, commits outside the plan, the
  journal, your notes.
- `shadow: true` shows you each decision instead of carrying it out; `plan_run`
  then carries it out. Start a project's first plan this way and turn it off once
  the Orchestrator's judgement holds (`plan_edit`, op `set`).
- `maxUnreviewed`: tasks in a row without you before you are woken anyway.
- `escalations`: the kinds of decision inside a run the Orchestrator answers first
  — `step` (a step asks, e.g. the implementer reports `plan_wrong`), `gate`,
  `limit` (a loop used up its iterations), `engine` (a step could not run). It
  answers `continue`, `retry` or `reject` with a text every later step reads, or
  passes the decision on to you with its reason and proposal. Decisions a machine
  addresses to the user never go to it. After it answered three escalations of the
  same step in a run, the next one comes to you. Without `escalations` every
  decision comes to you. In shadow mode its answer is shown to you instead of
  being given. Say in the prompt what it may decide alone and when it must pass
  on: the prompt is the policy here too.

## While the plan runs

Wait with `pipeline_wait` **without `runId`**, passing the last event id you have
seen as `since`. A timeout returns one line of state and means nothing needs
checking: wait again. These reach you:

| Event | What to do |
|---|---|
| `plan_attention` | See `kind`, `reason`, `proposal`. Change the plan with `plan_edit` if needed, then `plan_run`. If you change nothing, say why in `note`: the next Orchestrator reads it and would otherwise wake you again |
| `escalation` | A decision inside a run: `pipeline_answer`, as always. One the Orchestrator passed on has `orchestrator` with its reason and proposal (`wouldAnswer` in shadow mode) |
| `run_paused`, `run_stopped` | As always; the plan goes on when the run ends |

`plan_attention` kinds: `wake` (the Orchestrator asks for you), `run_failed`,
`checkpoint`, `review_due`, `no_machine`, `stuck`, `orchestrator_failed`, `shadow`,
`finished`.

## Changing a plan

`plan_edit` with `baseRevision` and `ops`: `add`, `update`, `move`, `split`, `drop`,
`set`, `dismiss`. A batch is validated at once and applied all or nothing, so
errors come back in the call. You can edit at any time; only the task a running
step works on is locked. `split` gives every new task the dependencies of the one
it replaces, besides its own `after`. Read with `plan_status` first: `plan_get` with a `taskId`
when you need more. The whole plan stays in your context.

Review findings land in the plan's `followups` by themselves. Go through them at
checkpoints: turn them into tasks or `dismiss` them.

## Several plans

A project can have several plans; one is active for you, and it is the one views
show and `plan_run` walks. `plan_activate` switches, and a plan you leave keeps its
progress.

## One task outside the plan

`pipeline_start` without `planTask` touches nothing in the plan. While the autopilot
is on, `plan_pause` first: it holds after the current step. After your run,
`plan_run` continues, and the next Orchestrator sees your commits.

To do a plan task by hand, pass `planTask: {plan, task}`: its last commit marks the
task done, with a `Plan-Task` trailer. Work done without a run: `plan_edit` with
`update`, `fields: {status: "done"}`.

## What not to do

- Do not edit `aide/plans/*.json` directly, and do not have step agents touch it:
  AIDE marks tasks done and records findings inside the task's commit.
- Do not check on a run because time passed. AIDE tells you when something needs
  you.
