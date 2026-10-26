# Authoring AIDE Pipeline Machines

This guide is for the agent asked to **prepare pipelines for a project**. You
write machine files and role files; AIDE executes them. Returned by the
`pipeline_guide` MCP tool.

## 1. Workflow

1. Read the project: its instructions (CLAUDE.md / AGENTS.md), docs, plan,
   build and test commands, asset layout.
2. Interview the user: which **task types** recur (e.g. "code feature",
   "game location content"), what "done" means for each, which checks exist,
   which CLIs should implement and which should review.
3. Write one machine per task type: `aide/pipelines/<id>.json`, and its role
   files under `aide/pipelines/roles/`.
4. Set `engineVersion` to the engine version of the running AIDE (the end of
   this guide names it). `pipeline_validate` until there are no errors
   (`pipeline_schema` has the file schema).
5. `pipeline_smoke` with the machine id: check commands run once, CLIs are
   found (add `pingAgents: true` to confirm each CLI answers headless).
6. Show the user the machine; they commit the files.

Machines are shared through the repository. Personal variants go to
`.aide/users/<user>/pipelines/` and win on duplicate id.

**After an AIDE update.** When AIDE changes how machines or role files behave,
its engine version goes up. `pipeline_list` marks machines written for an older
engine as `outdated`, and `pipeline_start` refuses them with the list of changes
since their version and what to do. Review the machine and its roles against
that list (the end of this guide has the full history), then raise
`engineVersion`. `acceptOutdated: true` on `pipeline_start` runs one unchanged.

## 2. How a machine runs

A machine is a **tree of steps**, executed top to bottom like structured code.
There are no jumps: control moves to the next step, into a block, or back to the
start of an enclosing loop. AIDE makes no judgement calls — judgement belongs to
agent steps, control flow to the tree.

Every step has an `id`, unique in the machine (letters, digits, `_`, `-`); it
names the step's output: `outputs.<id>`.

| Step | What AIDE does |
|---|---|
| `agent` | Runs a headless CLI with the role, the pipeline context, the inputs and an output schema; the JSON answer becomes `outputs.<id>` (agent failures stop the run for a decision) |
| `check` | Runs `command` in the project root; exit code 0 passes. Output in `outputs.<id>.output`. The command may use `{{params.x}}` and `{{outputs.step.field}}` (§2, Check commands) |
| `gate` | Asks the user or the orchestrator to approve |
| `repeat` | Starts an enclosing loop over (like `continue`); usually inside an `if` |
| `commit` | Block: its `prep` agent stages the change and writes the message, AIDE reviews the prepared commit and commits it |
| `loop` | Block: runs its steps again until a pass completes, at most `maxIterations` times |
| `group` | Block: a titled sequence — a phase of the pipeline (`name` is shown in the run view) |
| `if` | Block: runs `then` or `else` depending on `condition` |

### Loops

A loop runs its `steps`. A pass **completes** when its last step completes; then
the loop is done and the run continues after it. A step inside asks for another
iteration — the rest of the pass is skipped and the loop starts over:

- a `check` that fails;
- an `agent` whose `repeatIf` condition is true;
- a `gate` that is rejected;
- a `repeat` step.

The step that asked for the repeat becomes the **feedback** of the next
iteration: every agent inside the loop gets a "Feedback" section with the reason
and the details (the failed check's output, the reviewer's findings, the gate
answer). You do not wire this through `inputs`.

`maxIterations` is required. When the last allowed iteration still asks to
repeat, `onLimit` decides: `escalate` (default — the orchestrator or the user
grants one more iteration, accepts the result as it is, or stops the run) or
`fail` (the run fails).

By default a repeat starts the **innermost** loop over. `repeatLoop: "<id>"` (on
an agent, check or gate) and `repeat` steps can name an **enclosing** loop
instead; the loops nested inside it start from scratch. A step can only send
control back to a loop it is inside — to return from a later phase to an earlier
one, wrap both phases in an outer loop (see §6).

### Conditions

`repeatIf`, `escalateIf` and `if.condition` are `<ref> == <literal>` or
`<ref> != <literal>`: `"outputs.review.verdict != 'accept'"`,
`"params.withReview == true"`. Refs: `params.<name>`,
`outputs.<step>.<field>`, `run.iteration` (iteration of the innermost loop
around the condition — for an `if`, the loop that contains the `if`),
`run.iterations.<loop id>` (the iteration of a named loop).

### Check commands

A check command can take values of the run: `"cargo xtask captures --stage
{{params.stageId}}"`. Only `params.*` and `outputs.*` refs are allowed. AIDE
quotes each value for the shell (`cmd.exe` on Windows, `sh` elsewhere); a list
param becomes several arguments. On Windows a value containing `"`, `%` or a
line break is refused (cmd.exe cannot pass it safely) and the step stops for a
decision.

A failed check feeds back the exit code, the path of its full log, the lines of
the whole log that look like failures (failing tests, panics, compiler errors)
and the tail of the output.

### Decisions

- `escalateIf` on an agent stops the run for a decision when true (e.g. the
  implementer reports `plan_wrong`): `continue` goes on with the next step,
  `retry` runs the step again, `stop` ends the run. `escalateMessage` and
  `escalateTo` (`orchestrator` by default, or `user`) shape the request.
- A `check` that fails **outside** any loop stops the run for a decision too.
- A `gate` rejected **outside** any loop holds the run at the gate (nothing to
  repeat); resuming asks again.
- Answers with text are shown to every later agent of the run, and so are
  instructions the orchestrator adds while the run goes (`pipeline_amend`).
- An answer can change params for the rest of the run (`pipeline_answer` with
  `params`, validated against the machine's params). Example: a spec proposes a
  split, the gate approves part A and sets `{"stageId": "S5.7a"}`; later tasks,
  inputs and conditions use the new value. To reach the orchestrator on a split
  as well as on a design question, let the spec schema report one field the
  gate condition tests (e.g. `"gate": "none" | "decision" | "split"` with
  `outputs.specify.gate != 'none'`): conditions compare one reference.
- A CLI usage limit is not a failure: the run holds, keeps the step's session,
  and resumes by itself when the limit resets (if the CLI says when).
- Neither is a CLI that is temporarily unavailable (model at capacity,
  overloaded, network errors): the step is retried every minute in its session,
  and only after 20 minutes without success does the orchestrator get an
  engine escalation.

## 3. What each agent receives

AIDE composes the prompt; you only write the role file and the step fields.

- **Role file** (`role`): who the agent is, what it does, what it never does,
  how it reports. Keep it about the role, not about the flow.
- **Pipeline context** — generated: the whole step tree with "you are here", the
  loops the agent is in and their iteration, what later steps do, and what
  happened before — including the latest results of the current loop pass, so
  feedback from an earlier pass is not mistaken for the current state. Agents
  therefore know they need not run checks that a check step runs (they may when
  their task asks for it), and not to stage or commit before the commit step.
  This is why every agent step needs a good one-line `summary`. An `if` whose
  condition uses only params is resolved: the agent sees just the branch that
  runs. Conditions on outputs are shown as conditions.

  The pipeline context states **facts only** — the machine's structure, the
  step's time limit, the run's state. It never tells an agent *how* to work:
  "finish the whole task in this visit", "plan the increments", "never modify
  files" belong in the role file (or the `task`), where you write them for that
  step. AIDE does not know a step's purpose and would only guess it.
- **Task and inputs**: `task` (may use `{{params.x}}`, `{{outputs.step.field}}`)
  and `inputs` — references rendered as sections: `params.x`,
  `outputs.<step>.<field>`, `run.diff` (working tree vs HEAD including
  untracked files), `run.stagedDiff`, `run.changedFiles`.
  - The `run.*` file refs take path filters, so regenerated or generated files
    do not drown a reviewer: `{"ref": "run.diff", "exclude":
    ["Source/Scenarios/**/*.txt"]}` or `"include": ["src/**"]`. Globs match
    repo-relative paths: `*` and `?` within a segment, `**` across segments,
    `{a,b}` alternatives, a trailing `/` for a whole directory; a pattern
    without `/` matches a file name at any depth. The prompt says how many
    files the filter kept.
  - An input over 100,000 characters is not put into the prompt: AIDE saves it
    to `nodes/<step>-<visit>/inputs/` in the run directory and the prompt gets
    the path and the file list (with added/removed line counts for diffs). The
    agent reads it with its file tools (read-only Claude steps may read the
    run directory).
  - An agent with a shell still sees every file through `git status`; filter
    the inputs and say in the role which files are generated.
- **Feedback** of the loops it is in, from the second iteration on (§2).
- **Output contract**: the schema named by `output`. Built-ins:
  - `implementerReport`: `status` (`done` | `blocked` | `plan_wrong`), `summary`, `docsChanged`, `pipelineIssues[]`
  - `reviewVerdict`: `verdict` (`accept` | `reject`), `blocking[]`, `non_blocking[]`, `summary`, `pipelineIssues[]`
  - `commitPrep`: `commitMessage`, `excluded[{path, reason}]`, `pipelineIssues[]`
  - `commitReview`: `verdict`, `issues[]`

  `pipelineIssues` is where an agent reports a problem with the pipeline itself
  (contradictory instructions, wrong context, a missing tool) instead of
  smuggling it into findings or exclusions. AIDE collects them from every visit
  into the run report. Give a custom schema a `pipelineIssues` string array to
  get the same.

  Custom schemas go into `schemas`; for Codex they must be strict
  (`additionalProperties: false`, every property in `required`). OpenCode 2,
  Cursor and Devin have no structured-output mode: the schema is sent as an
  instruction and the answer is parsed from the final message, so a malformed
  answer fails the visit at validation more often than with Claude Code or Codex.

**Sessions** (`session`):

- `keep` (default): every visit of the step continues its own previous CLI
  session. The implementer of iteration 2 remembers what it did and fixes the
  feedback; a reviewer remembers its earlier findings and checks they are fixed.
- `new`: a fresh session every visit — for a reviewer that must judge without
  its earlier opinion.
- `continue:<step>`: continue an earlier step's session — the commit `prep`
  continues the implementer, so it knows which files belong to the change.

`permissions: "read-only"` for reviewers.

**MCP servers**: step agents start without any. Claude Code steps get neither
the user's MCP servers nor claude.ai connectors (their tools and server
instructions contradicted roles); Codex steps run without the user config;
OpenCode 2 steps run with every MCP server of the user and project configs
switched off; Cursor steps run with their own config home (no user MCP servers,
rules or skills); Devin steps run without its MCP servers and without what it
imports from Claude Code and Cursor.

**What an agent was sent** is kept per visit (`nodes/<step>-<visit>.input.jsonl`:
the message and the system prompt append of every CLI invocation, including
retries and continuations). The run view in AIDE shows it on the step's
**Input** tab — the first place to look when an agent did something odd.

**Model and effort** (`model`, `effort` on a step, or in `defaults`; `effort` and
`model` also on a commit `reviewer`). Effort levels: Claude Code `low`, `medium`,
`high`, `xhigh`, `max`; Codex `low` … `ultra` (the exact set depends on the
model); OpenCode 2 (`open-code`) takes the model's variant name (`model#variant`),
whose set is per model and checked by OpenCode when the step runs. Without one,
Claude Code uses its own default, Codex uses the model and effort of the user's
Codex config — not the model's built-in default, which can be as low as `low` —
and OpenCode uses its configured model. An OpenCode `effort` without a step
`model` applies to that configured model. Cursor (`cursor-agent`) and Devin
(`devin`) take no `effort`: Cursor's model ids carry it (`grok-4.7-high`), and a
step without `model` uses the user's default model of that CLI. Set effort per step deliberately: an implementer
of large stages usually needs more than a commit preparer.

## 4. The commit step

Commit preparation comes **after** code review (not mixed into it). The `commit`
block holds the `prep` agent (usually `session: "continue:<implementer>"`): it
stages the files that belong to the change, updates `.gitignore` if needed, and
outputs `commitPrep`. AIDE then reviews the prepared commit:

- `review: "algorithmic"` — something is staged, the message is present, and
  every changed or untracked file is staged or listed in `excluded`;
- `review: "agent"` — the same checks, then a reviewer agent (`reviewer.role`,
  a cheap model is fine) inspects the staged diff, the message and the exclusions.

On success AIDE commits and the run continues. On failure the problems go back to
the prep agent as feedback, up to `maxAttempts` (default 3) attempts; then
`onLimit` applies as for loops.

**Let the prep agent do the plan bookkeeping.** If the project keeps a plan with
task statuses and a list of follow-ups, give the prep agent the reviewers'
findings (`inputs: ["outputs.review.non_blocking"]`) and have its role mark the
task done and record the findings, inside the same commit. Otherwise the
orchestrator does these edits after every run, and each orchestrator call
re-reads its whole (usually large) context: bookkeeping is the cheapest work in
the pipeline and the most expensive work for the orchestrator. It also avoids
edit conflicts between the implementer and the orchestrator on the same plan
rows.

## 5. Example: code feature

```json
{
  "id": "code-feature",
  "name": "Code feature",
  "description": "Implements one plan stage that is pure code. Needs the stage spec and acceptance criteria. Produces one reviewed commit.",
  "engineVersion": 4,
  "params": {
    "taskSpec": { "type": "string", "description": "What to implement, or a path to the spec section" },
    "acceptance": { "type": "string[]", "description": "Acceptance criteria" }
  },
  "defaults": { "cli": "claude-code", "timeoutMin": 45 },
  "steps": [
    {
      "type": "loop", "id": "build", "name": "Implement and review", "maxIterations": 3,
      "steps": [
        {
          "type": "agent", "id": "implement",
          "summary": "implements the task; on later iterations fixes the feedback",
          "role": "roles/implementer.md", "output": "implementerReport",
          "inputs": ["params.taskSpec", "params.acceptance"],
          "escalateIf": "outputs.implement.status != 'done'",
          "escalateMessage": "The implementer reports the task is blocked or should not be done as specified."
        },
        { "type": "check", "id": "checks", "command": "npm run typecheck && npm test" },
        {
          "type": "agent", "id": "review",
          "summary": "a separate reviewer checks the diff against the task and the acceptance criteria",
          "role": "roles/code-reviewer.md", "cli": "codex", "permissions": "read-only", "output": "reviewVerdict",
          "inputs": ["params.taskSpec", "params.acceptance", "run.diff"],
          "repeatIf": "outputs.review.verdict != 'accept'"
        }
      ]
    },
    {
      "type": "commit", "id": "commit", "review": "algorithmic",
      "prep": {
        "type": "agent", "id": "commitPrep", "summary": "stages the change and writes the commit message",
        "role": "roles/commit-prep.md", "session": "continue:implement", "output": "commitPrep"
      }
    }
  ]
}
```

A failed check or a rejected review starts `build` over; the implementer gets the
check output or the review findings as feedback. After three iterations without
a clean pass the orchestrator decides.

## 6. Example: content, then integration

Content (levels, assets, texts) follows the same shape with different checks:
deterministic validators instead of compilers (assets exist, references
resolve, the engine imports them — e.g. an Unreal commandlet), and a content
reviewer that checks the result against the brief. Put as much as possible into
`check` steps: they are facts, reviewers are opinions.

Two phases — generate the content, then integrate it in code — are two groups.
When the integration may find that the **content** is wrong, wrap both phases in
an outer loop and return to it with a `repeat` step:

```json
{
  "id": "location-content",
  "name": "Location content",
  "description": "Generates the assets of a game location and integrates them. Needs the location brief. Produces one commit.",
  "engineVersion": 4,
  "params": { "brief": { "type": "string", "description": "The location brief or a path to it" } },
  "defaults": { "cli": "claude-code" },
  "schemas": {
    "integrationVerdict": {
      "type": "object", "additionalProperties": false,
      "required": ["verdict", "blocking", "summary"],
      "properties": {
        "verdict": { "type": "string", "enum": ["accept", "reject", "content_wrong"] },
        "blocking": { "type": "array", "items": { "type": "string" } },
        "summary": { "type": "string" }
      }
    }
  },
  "steps": [
    {
      "type": "loop", "id": "location", "name": "Content and integration", "maxIterations": 2,
      "steps": [
        {
          "type": "group", "id": "content", "name": "Content",
          "steps": [{
            "type": "loop", "id": "contentLoop", "maxIterations": 3,
            "steps": [
              { "type": "agent", "id": "generate", "summary": "generates the location assets from the brief", "role": "roles/content-generator.md", "output": "implementerReport", "inputs": ["params.brief"] },
              { "type": "check", "id": "validateAssets", "command": "npm run validate-assets" },
              { "type": "agent", "id": "contentReview", "summary": "checks the assets against the brief", "role": "roles/content-reviewer.md", "permissions": "read-only", "output": "reviewVerdict", "inputs": ["params.brief", "run.changedFiles"], "repeatIf": "outputs.contentReview.verdict != 'accept'" }
            ]
          }]
        },
        {
          "type": "group", "id": "integration", "name": "Integration",
          "steps": [
            {
              "type": "loop", "id": "build", "maxIterations": 3,
              "steps": [
                { "type": "agent", "id": "implement", "summary": "integrates the assets into the game code", "role": "roles/implementer.md", "output": "implementerReport", "inputs": ["params.brief"] },
                { "type": "check", "id": "checks", "command": "npm run typecheck && npm test" },
                { "type": "agent", "id": "review", "summary": "reviews the integration; reports content_wrong when the assets themselves must change", "role": "roles/code-reviewer.md", "permissions": "read-only", "output": "integrationVerdict", "inputs": ["params.brief", "run.diff"], "repeatIf": "outputs.review.verdict == 'reject'" }
              ]
            },
            {
              "type": "if", "id": "contentProblem", "condition": "outputs.review.verdict == 'content_wrong'",
              "then": [{ "type": "repeat", "id": "backToContent", "loop": "location", "reason": "the integration review found problems in the content" }]
            }
          ]
        }
      ]
    },
    {
      "type": "commit", "id": "commit", "review": "agent", "reviewer": { "role": "roles/commit-reviewer.md", "model": "haiku" },
      "prep": { "type": "agent", "id": "commitPrep", "summary": "stages the change and writes the commit message", "role": "roles/commit-prep.md", "session": "continue:implement", "output": "commitPrep" }
    }
  ]
}
```

`review` repeats `build` on `reject`. On `content_wrong` the `build` loop is done
(no repeat was asked), the `if` sees the verdict and `backToContent` starts
`location` over: the generator gets the reviewer's findings as feedback, and
`contentLoop` and `build` start from scratch.

## 7. Patterns that keep runs cheap

The orchestrator pays for every call with its whole context, and every agent
step pays for its prompt. Design machines so that both do little:

- **The machine does the bookkeeping.** Let the commit `prep` step mark the task
  done in the project plan and add the run's non-blocking findings to the plan's
  follow-up list, inside the same commit (say so in its role file and `task`).
  The orchestrator then only reads the result and starts the next run, and it
  never collides with plan rows the implementer edited.
- **Judging models judge, cheaper models write.** Output-heavy authoring
  (specifications, content, code) suits Codex or a mid-size model; reserve the
  most capable model for review, where its judgement is what you pay for. Tune
  `effort` per step rather than raising everything.
- **No way out in the task text.** Never write "if you cannot finish, escalate"
  into a `task`, a param or a role: agents take such an exit within a minute.
  Real obstacles already have `blocked` / `plan_wrong` and escalations.
- **Lean project instructions.** Every agent reads CLAUDE.md / AGENTS.md before
  its first line of work. Keep them to conventions; move stage history and long
  logs to separate documents the agents open only when needed.
- **One reviewer per change.** A reviewer that sees the diff and the captures
  together costs one fresh session, two reviewers cost two. Split only when the
  roles need different expertise.
- **Checks before reviewers.** Everything a script can decide (builds, tests,
  asset validation, screenshots compared to references) belongs in `check` steps:
  they are cheap, deterministic, and keep reviewers from spending a session on a
  broken build.

## 8. Starter role files

`roles/implementer.md`

```markdown
You are the implementer. Implement exactly the task you are given, following
the project's conventions (read its CLAUDE.md / AGENTS.md first).
- Keep changes within the task. Do not refactor unrelated code.
- Update documentation that the change makes outdated.
- If the task cannot be done as specified, or should not be, stop and report
  status "plan_wrong" with the reason instead of working around it.
- Report "blocked" only for an external obstacle you name (missing
  information, a broken environment). The size of the task is not an obstacle:
  this step has no budget but its time limit, so plan the increments and
  implement all of them.
- Finish the whole task in this visit. The loop around this step repeats only
  to fix what later steps find; it is not a way to continue unfinished work.
When you get feedback (failed checks or review findings), fix exactly that.
If the pipeline itself is wrong (contradictory instructions, a missing tool or
input), say so in "pipelineIssues" and carry on.
```

`roles/code-reviewer.md`

```markdown
You are the code reviewer. You did not write this change. Review the diff
against the task and its acceptance criteria.
- Blocking: bugs, unmet acceptance criteria, broken conventions, missing
  documentation updates, junk in the diff (build output, temporary files).
- Non-blocking: style and improvements that can wait.
Accept when there are no blocking findings. Never modify files.
If the pipeline itself is wrong (contradictory instructions, a missing tool or
input), say so in "pipelineIssues" and carry on.
```

`roles/commit-prep.md`

```markdown
Prepare the commit for the change you implemented. Stage exactly the files
that belong to it (follow project conventions, e.g. version files that must be
committed together with code). Add build output or local files to .gitignore
when appropriate, otherwise list them in "excluded" with a reason. Write a
commit message: a subject line, a blank line, and a body explaining why.
Do not commit — AIDE reviews the prepared commit and commits it.
```
