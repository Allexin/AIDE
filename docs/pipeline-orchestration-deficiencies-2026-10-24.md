# Pipeline orchestration deficiencies, addendum 2026-10-24

Found in Space Hospital after the engine-3 fixes. The earlier list is
`pipeline-orchestration-deficiencies-2026-10-23.md`. Each item names what we saw, why it matters and
what we expected.

## E1. Git's auto-gc stderr is treated as a commit failure

- **Seen:** run 20261024T050449Z-stage, step `commit`. Escalation:
  `git commit -F - failed: Auto packing the repository for optimum performance. See "git help gc"`.
  The commit actually succeeded (e2984c5, clean tree). A retry then failed with "Nothing is staged",
  and the commit loop hit its limit. The orchestrator had to answer `continue`.
- **Expected:** decide success by the exit code and the new HEAD, not by stderr text. A useful
  check: HEAD moved and the index is empty. Alternatively run commits with `-c gc.auto=0`, or treat
  a known gc notice as informational.

## E2. Agent inputs have no size bound or filter

- **Seen:** the code-review step's input `run.diff` contained about 860 regenerated golden text
  dumps. The prompt reached 1,416,270 characters, and Codex refused it (`prompt_too_large`).
  - Switching to `run.changedFiles` still sends about 1000 paths, most of them noise for the
    reviewer.
  - An agent with a shell sees the same files again through `git status` / `git diff`.
- **Expected:**
  - (a) `run.diff` / `run.changedFiles` accept include/exclude globs in the machine, for example
    `{"ref": "run.diff", "exclude": ["Source/Scenarios/**/*.txt"]}`.
  - (b) An input above a size limit is written to a file under the run directory, and the agent
    gets the path plus a summary, never a failed prompt.
- Space Hospital works around it with a project command that prints a filtered diff and a golden
  summary (stage HK4).

## E3. Claude Code steps inherit the user's claude.ai MCP connectors

- **Seen:** the specify step (claude-code, Opus) listed claude.ai Claude Docs tools. Their server
  instructions told it to create a living web document first. That contradicts the role, which
  writes a local Markdown spec. The agent ignored them and reported it as a pipeline issue.
- **Expected:**
  - steps start with only the MCP servers the machine allows (for example `--strict-mcp-config`
    with an explicit config);
  - the default is none for pipeline roles;
  - foreign server instructions never reach step agents.

## E4. The context names the wrong next check inside `if` / `else`

- **Seen:** the stage machine has `if params.milestone` → `ciFull`, else `ci`. In runs with
  `milestone=false`, the implementer's context said the next step is `ciFull`, while the feedback
  came from `ci` (`cargo xtask ci --quick`). Reported by four runs (N1b, A1, S5.7d, A2).
- **Expected:** the overview resolves `if` conditions it can already evaluate (params are fixed
  at start) and shows only the branch that will run.

## E5. A split stage keeps its parent's id

- **Seen:** specs propose splits (S5.7 → S5.7a, N1 → N1a/N1b, A2 → A2a/A2b). The orchestrator
  approves Part A at the gate, but the run's `stageId` stays `S5.7` / `N1` / `A2`. Commit prep reports
  the mismatch in every run.
  - The `stageSpecReport` schema has no split field.
  - `approveSpec` runs only when `needsUser` is true, so a behaviour-neutral split has to fake a
    design decision to reach the orchestrator.
- **Expected:**
  - a structured `split` field (parts with ids, scopes, dependencies);
  - a gate condition that also fires on a proposed split;
  - a way to set the effective stage id for the rest of the run, or a documented convention that
    the gate answer may rename it.

## Status after the AIDE fixes (2026-10-24)

Engine 4. Space Hospital machines declare engine 3, so `pipeline_start` refuses
them with the list of changes until they are reviewed and set to
`"engineVersion": 4`.

| Item | Status | What changed |
|---|---|---|
| E1 | done | The cause was most likely the 15 s git timeout: the auto gc after the commit outlasted it, git was killed and its gc notice became the error. Commits now run with `gc.auto=0` and a 10 min timeout (hooks), and a commit counts as made when HEAD moved onto the old HEAD, whatever the exit code. |
| E2 | done | (a) `{"ref": "run.diff" \| "run.stagedDiff" \| "run.changedFiles", "include"?: [globs], "exclude"?: [globs]}`; the prompt says how many files the filter kept. (b) An input over 100,000 characters goes to `nodes/<step>-<visit>/inputs/` in the run directory; the prompt gets the path and the file list with line counts. Read-only Claude steps may read the run directory. An agent with a shell still sees everything through `git status`; the role should say which files are generated. |
| E3 | done | Claude Code steps run with `--strict-mcp-config` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`: no MCP servers at all. Codex steps already ran with `--ignore-user-config`. No per-machine allow list yet; add one when a role needs an MCP tool. |
| E4 | done | An `if` whose condition uses only params is resolved in the context: only the branch that runs is shown, and numbering, "Next in order" and the later checks follow it. |
| E5 | partly | Engine: `pipeline_answer` takes `params`, validated against the machine params, e.g. approve the gate with `{"stageId": "S5.7a"}`; later tasks, inputs and conditions use it and every later agent sees the change in "Before you". Project: a `split` field in `stageSpecReport` and a gate condition that fires on it. Conditions compare one reference, so report one field the gate tests (e.g. `"gate": "none" \| "decision" \| "split"`, condition `outputs.specify.gate != 'none'`). |
| Agent input | done | Every CLI invocation of a visit keeps what it was sent (message, system prompt append, CLI/model/effort, new or continued session) in `nodes/<step>-<visit>.input.jsonl`; the run view shows it on the step's **Input** tab next to Transcript. |
