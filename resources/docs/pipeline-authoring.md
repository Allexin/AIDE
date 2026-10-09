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

AIDE starts at `start`, executes the node, then evaluates the node's edges **in
order**; the first matching edge decides the next node. AIDE makes no judgement
calls — judgement belongs to agent nodes, routing to edges.

| Node type | What AIDE does | Outcome |
|---|---|---|
| `agent` | Runs a headless CLI with the role, the pipeline context, the inputs and an output schema | `ok` with the agent's JSON output (agent failures escalate) |
| `check` | Runs `command` in the project root | `ok` when exit code is 0, else `fail`; output in `outputs.<id>.output` |
| `commit` | Reviews the prepared commit, then commits the index | `ok` with `{sha, files, message}`, or `fail` with `{issues}` |
| `gate` | Asks the user/orchestrator to approve | `ok` approved, `fail` rejected |
| `escalate` | Hands a problem to the orchestrator/user and waits | follows its edges after the answer |
| `end` | Ends the run | — |

Edge conditions: `ok`, `fail`, `default` (always; put it last), or
`<ref> == <literal>` / `!=`, e.g. `"outputs.review.verdict == 'accept'"`.
Every non-end node needs a route for every outcome: a `default` edge, or both
`ok` and `fail`.

**Loops must be bounded**: some node in every loop needs `maxVisits`; when it is
exceeded the run goes to `onLimit` (usually an `escalate` node).

## 3. What each agent receives

AIDE composes the prompt; you only write the role file and the node fields.

- **Role file** (`role`): who the agent is, what it does, what it never does,
  how it reports. Keep it about the role, not about the flow.
- **Pipeline context** — generated: the whole flow with "you are here", what
  each later node does, and what happened before. Agents therefore know not to
  run checks that a check node runs, and not to stage or commit before the
  commit step. This is why every agent node needs a good one-line `summary`.
- **Task and inputs**: `task` (may use `{{params.x}}`, `{{outputs.node.field}}`)
  and `inputs` — references rendered as sections: `params.x`,
  `outputs.<node>.<field>`, `run.diff` (working tree vs HEAD including
  untracked files), `run.stagedDiff`, `run.changedFiles`.
- **Output contract**: the schema named by `output`. Built-ins:
  - `implementerReport`: `status` (`done` | `blocked` | `plan_wrong`), `summary`, `docsChanged`
  - `reviewVerdict`: `verdict` (`accept` | `reject`), `blocking[]`, `non_blocking[]`, `summary`
  - `commitPrep`: `commitMessage`, `excluded[{path, reason}]`
  - `commitReview`: `verdict`, `issues[]`

  Custom schemas go into `schemas`; for Codex they must be strict
  (`additionalProperties: false`, every property in `required`).

`session: "continue:<node>"` resumes that node's CLI session — use it for the
fix step and for commit preparation, so the implementer keeps its context.
`permissions: "read-only"` for reviewers.

## 4. The commit step

Commit preparation is an agent node **after** code review (not mixed into it):
the implementer (continued session) stages the files that belong to the change,
updates `.gitignore` if needed, and outputs `commitPrep`. The `commit` node then:

- `review: "algorithmic"` — AIDE checks that something is staged, the message is
  present, and every changed or untracked file is staged or listed in `excluded`;
- `review: "agent"` — the same checks, then a reviewer agent (`reviewer.role`,
  a cheap model is fine) inspects the staged diff, the message and the exclusions.

On success AIDE commits and the run continues; on failure `outputs.<commit>.issues`
goes back to the prep node — include it in the prep node's `inputs`.

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
  "start": "implement",
  "nodes": {
    "implement": { "type": "agent", "summary": "implements the task", "role": "roles/implementer.md", "output": "implementerReport", "inputs": ["params.taskSpec", "params.acceptance"] },
    "checks": { "type": "check", "command": "npm run typecheck && npm test" },
    "review": { "type": "agent", "summary": "a separate reviewer checks the diff against the task and the acceptance criteria", "role": "roles/code-reviewer.md", "cli": "codex", "permissions": "read-only", "output": "reviewVerdict", "inputs": ["params.taskSpec", "params.acceptance", "run.diff"], "maxVisits": 3, "onLimit": "stuck" },
    "fix": { "type": "agent", "summary": "fixes failed checks or blocking review findings", "role": "roles/implementer.md", "session": "continue:implement", "output": "implementerReport", "inputs": ["outputs.checks.output", "outputs.review.blocking"] },
    "commitPrep": { "type": "agent", "summary": "stages the change and writes the commit message", "role": "roles/commit-prep.md", "session": "continue:implement", "output": "commitPrep", "inputs": ["outputs.commit.issues"], "maxVisits": 3, "onLimit": "stuck" },
    "commit": { "type": "commit", "prep": "commitPrep", "review": "algorithmic" },
    "stuck": { "type": "escalate", "to": "orchestrator", "message": "The loop did not converge; see the last review or commit issues." },
    "planWrong": { "type": "escalate", "to": "orchestrator", "message": "The implementer reports the task should not be done as specified." },
    "done": { "type": "end", "result": "success" },
    "failed": { "type": "end", "result": "failure" }
  },
  "edges": [
    ["implement", "checks", "outputs.implement.status == 'done'"],
    ["implement", "planWrong", "default"],
    ["checks", "review", "ok"],
    ["checks", "fix", "fail"],
    ["review", "commitPrep", "outputs.review.verdict == 'accept'"],
    ["review", "fix", "default"],
    ["fix", "checks", "default"],
    ["commitPrep", "commit", "default"],
    ["commit", "done", "ok"],
    ["commit", "commitPrep", "fail"],
    ["stuck", "failed", "default"],
    ["planWrong", "failed", "default"]
  ]
}
```

The `fix` → `checks` → `review` loop is bounded by `review.maxVisits`.

## 6. Content tasks

Content (levels, assets, texts) follows the same shape with different checks:
deterministic validators instead of compilers (assets exist, references
resolve, the engine imports them — e.g. an Unreal commandlet), and a content
reviewer that checks the result against the brief. Put as much as possible into
`check` nodes: they are facts, reviewers are opinions.

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
