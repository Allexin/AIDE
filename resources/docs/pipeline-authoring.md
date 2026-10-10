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
4. `pipeline_validate` until there are no errors (`pipeline_schema` has the file
   schema).
5. `pipeline_smoke` with the machine id: check commands run once, CLIs are
   found (add `pingAgents: true` to confirm each CLI answers headless).
6. Show the user the machine; they commit the files.

Machines are shared through the repository. Personal variants go to
`.aide/users/<user>/pipelines/` and win on duplicate id.

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
| `check` | Runs `command` in the project root; exit code 0 passes. Output in `outputs.<id>.output` |
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
`outputs.<step>.<field>`, `run.iteration` (iteration of the innermost loop).

### Decisions

- `escalateIf` on an agent stops the run for a decision when true (e.g. the
  implementer reports `plan_wrong`): `continue` goes on with the next step,
  `retry` runs the step again, `stop` ends the run. `escalateMessage` and
  `escalateTo` (`orchestrator` by default, or `user`) shape the request.
- A `check` that fails **outside** any loop stops the run for a decision too.
- Answers with text are shown to every later agent of the run.

## 3. What each agent receives

AIDE composes the prompt; you only write the role file and the step fields.

- **Role file** (`role`): who the agent is, what it does, what it never does,
  how it reports. Keep it about the role, not about the flow.
- **Pipeline context** — generated: the whole step tree with "you are here", the
  loops the agent is in and their iteration, what later steps do, and what
  happened before. Agents therefore know not to run checks that a check step
  runs, and not to stage or commit before the commit step. This is why every
  agent step needs a good one-line `summary`.
- **Task and inputs**: `task` (may use `{{params.x}}`, `{{outputs.step.field}}`)
  and `inputs` — references rendered as sections: `params.x`,
  `outputs.<step>.<field>`, `run.diff` (working tree vs HEAD including
  untracked files), `run.stagedDiff`, `run.changedFiles`.
- **Feedback** of the loops it is in, from the second iteration on (§2).
- **Output contract**: the schema named by `output`. Built-ins:
  - `implementerReport`: `status` (`done` | `blocked` | `plan_wrong`), `summary`, `docsChanged`
  - `reviewVerdict`: `verdict` (`accept` | `reject`), `blocking[]`, `non_blocking[]`, `summary`
  - `commitPrep`: `commitMessage`, `excluded[{path, reason}]`
  - `commitReview`: `verdict`, `issues[]`

  Custom schemas go into `schemas`; for Codex they must be strict
  (`additionalProperties: false`, every property in `required`).

**Sessions** (`session`):

- `keep` (default): every visit of the step continues its own previous CLI
  session. The implementer of iteration 2 remembers what it did and fixes the
  feedback; a reviewer remembers its earlier findings and checks they are fixed.
- `new`: a fresh session every visit — for a reviewer that must judge without
  its earlier opinion.
- `continue:<step>`: continue an earlier step's session — the commit `prep`
  continues the implementer, so it knows which files belong to the change.

`permissions: "read-only"` for reviewers.

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

## 5. Example: code feature

```json
{
  "id": "code-feature",
  "name": "Code feature",
  "description": "Implements one plan stage that is pure code. Needs the stage spec and acceptance criteria. Produces one reviewed commit.",
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

## 7. Starter role files

`roles/implementer.md`

```markdown
You are the implementer. Implement exactly the task you are given, following
the project's conventions (read its CLAUDE.md / AGENTS.md first).
- Keep changes within the task. Do not refactor unrelated code.
- Update documentation that the change makes outdated.
- If the task cannot be done as specified, or should not be, stop and report
  status "plan_wrong" with the reason instead of working around it.
- If you are blocked (missing information, broken environment), report
  "blocked" with what you need.
When you get feedback (failed checks or review findings), fix exactly that.
```

`roles/code-reviewer.md`

```markdown
You are the code reviewer. You did not write this change. Review the diff
against the task and its acceptance criteria.
- Blocking: bugs, unmet acceptance criteria, broken conventions, missing
  documentation updates, junk in the diff (build output, temporary files).
- Non-blocking: style and improvements that can wait.
Accept when there are no blocking findings. Never modify files.
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
