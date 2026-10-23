# Orchestration deficiencies (AIDE + Space Hospital pipelines), 2026-10-23

Handoff for an agent that fixes the orchestration. It consolidates the open rows of
`E:\Projects\SpaceHospital\Docs\Plan\pipeline_issues.md`, the 2026-10-10 usage analysis
(`Docs/Legacy/orchestration_usage_2026-10-10.md`) and what the orchestrator saw in the S5.x runs
(2026-10-22/23). Each item gives the symptom, evidence, cause where it was verified, and a fix.

Repositories:
- AIDE source: `E:\Projects\AIDE\AIDE` (engine in `src/main/pipeline/engine/`). It has uncommitted
  changes to `package.json`, `package-lock.json` and an untracked `docs/rendered-preview-spec.md`
  that belong to someone else. Leave them alone.
- Running AIDE build: `E:\Projects\AIDE\AIDE_Stable`. The MCP server is started from there, so an
  engine fix only takes effect after a release and an MCP restart.
- Project machines: `E:\Projects\SpaceHospital\aide\pipelines\{stage,art-pack,oni-research}.json`
  and `roles/*.md`.

Priority: **P1** wastes whole runs or hours of compute, or misleads agents on every run. **P2**
recurs and costs retries or orchestrator calls. **P3** is minor.

---

## A. AIDE engine

### A1. P1. Check commands cannot use params
- Symptom: a `check` command is a fixed string. A step cannot run "captures for this stage only"
  or "the checks named in this stage's spec".
- Cause: `machineSchema.ts:24` allows `{{params.x}}` / `{{outputs.step.field}}` only in an agent's
  `task`.
- Fix: template `command` the same way. Shell-quote the substituted values, and let the validator
  accept only `params.*` / `outputs.*` refs. This is the prerequisite for C1 (per-stage captures).

### A2. P1. Reviewers are told to "implement all of them now"
- Symptom: about ten `pipeline_issues.md` rows (S5.1b, S5.2, S5.2b, S5.3b, S5.4a ...). Every
  reviewer flags that its context tells it to implement while its role says never modify files.
- Cause: `context.ts:132` adds "For a large task, plan the increments, then implement all of them
  now." whenever `permissions` is `write`. The project's reviewers run with `permissions: "write"`
  (`stage.json`: `review` line 185, `visualReview` line 165) because they need to run tools and
  write scratch.
- Fix:
  - Tie the line to the step's purpose (output schema `implementerReport`, or an explicit step
    flag), not to permissions.
  - Separately, decide whether the reviewers really need `write`.

### A3. P2. The loop limit shown in the overview ignores granted extra iterations
- Symptom: agents see "at most 3 iterations" in the pipeline overview and "iteration 4 of 4" in
  "Before you". They report this as a PIPELINE ISSUE (S5.1b, S5.2c, S5.4a).
- Cause: `context.ts:81` uses `blockLimit(node)` without `state.bonus[node.id]`; line 140 adds the
  bonus.
- Fix: use the same expression in both places.

### A4. P1. The generic "do not run later checks" text conflicts with stage requirements
- Symptom: rows for H2, A4c2, S5.1, S5.1b and S5.4a. The handoff says "AIDE itself runs these
  checks later ... Do not run them". The stage or a retry decision requires the implementer to run
  quick CI or captures, for example to bless goldens or measure timings. Agents resolve it each
  time and report it.
- Cause: `context.ts` "What happens after you" block, about line 124.
- Fix: soften it to "you need not run them; run them if your task or a decision explicitly requires
  it". Better: allow a per-step `mayRunChecks: [...]`.

### A5. P1. No way to amend a running step
- Symptom: a new user requirement or a ruling during implementation (S0.1 folder rule, S5.1
  "buildings can be built in the air", H3 trapped-save wording, the decompiled-numbers rule)
  forces stop, abandon, edit, commit and restart. Partial work survives in the tree, but the whole
  agent context and setup time is lost.
- Fix: one or both of:
  - `pipeline_message`, which is delivered at the step's next turn boundary, or by stop plus
    resume of the same session with the text appended.
  - "restart current step with amended params", which keeps the run, its loop state and its
    outputs.

### A6. P2. A run uses the machine file copied at start
- Symptom: raising the captures timeout from 20 to 40 min, or changing a role, needs an abandon and
  a restart even when the change only affects later steps.
- Fix: a `pipeline_reload` that re-reads machine and role files for steps not yet visited, after
  validation. Or document clearly that roles are re-read per visit, if they already are.

### A7. P2. Stale feedback and a missing current check result
- Symptom: many rows from 2026-10-11 to 2026-10-19. Later agents receive the failure of iteration 1
  without being told that the current iteration's ci and captures passed. This is only mitigated
  in the roles.
- Fix: "Before you" should list the latest outcome of every check in the current iteration, and
  label feedback from older iterations as superseded.

### A8. P2. Retry feedback lacks diagnostics
- Symptom: S3.5r3, rig_patient art-pack. A failed check's feedback showed the tail of the log, not
  the failing test names. Once there was no log at all.
- Fix: keep the full log path in feedback (`checks/<id>-<visit>.log`) and pull failure markers from
  it (`FAILED`, `panicked at`, `error[`), rather than only the last N lines.

### A9. P2. `run.iteration` takes the wrong loop in nested loops
- Symptom: art-pack planter_crops. `artTestFix` with `run.iteration != 1` ran on the first ciLoop
  pass because it saw the outer loop's iteration (6).
- Fix: `run.iteration` must be the innermost loop's own count. Add `loops.<id>.iteration` for
  explicit refs.

### A10. P2. No "incomplete" status for the implementer
- Symptom: S2.5, S2.5a, and early "blocked" exits after reading only (memory
  `aide-implementer-early-blocked`). Codex reports `blocked` when it has not finished, with no
  external obstacle. ae96e15 reduced this; it still happens occasionally.
- Fix: auto-continue once when `blocked` names no external obstacle. Or add an `incomplete` status
  that AIDE answers with "continue" automatically, up to N times.

### A11. P2. The `commitPrep` schema has no field for observations
- Symptom: pipeline issues travel as fake `excluded` entries with path `PIPELINE ISSUE`. Plan rows
  are edited by ad hoc Python string replacement; once this broke the A1k status cell.
- Fix: add a `pipelineIssues[]` field to `commitPrep`, and to `reviewVerdict` instead of the
  "PIPELINE ISSUE:" prefix in `non_blocking`. Collect them in the run report.

### A12. P2. Escalation answers are blunt
- Answering `stop` to an escalation fails the run.
- Rejecting a gate outside a loop fails the run (memory `aide-gate-reject`).
- There is no "stop and keep resumable" answer. The orchestrator must know to use continue with
  binding text, or stop, abandon and restart.
- Fix: add an `abandon`-free "pause here" answer, and document the semantics in the tool
  descriptions.

### A13. P2. CLI usage limits are treated as step failures
- Symptom: Codex reaching its subscription limit fails the step. The orchestrator gets an
  escalation, waits for the user and retries by hand. This happened several times in S5.x.
- Fix: detect the limit message and the reset time. Put the run in a "waiting for quota" state,
  either auto-resuming at the reset time or resuming on `pipeline_resume`, and keep the session.
  Never auto-retry 403s (the project has a ban-risk rule: verify the cause first).

### A14. P3. Resumed steps repeat completed work
- Symptom: A1k, S3.5r3. After a transient stream disconnect the same visit and the same feedback
  were resent, and completed mutations (staging, plan bookkeeping) ran again.
- Fix: on resume, tell the agent "your previous turn completed X; continue from there", or resume
  the CLI session instead of resending the prompt.

### A15. P3. Status and diff inputs include line-ending and stat noise
- Symptom: S1.3, S2.3b. `run.changedFiles` and the status list files with no content diff (CRLF in
  the working tree vs LF in the index).
- Fix: filter on `git diff --ignore-cr-at-eol --quiet` per path, or normalize with `git add
  --renormalize` in a temporary index.

### A16. P3. Renames do not render
- Symptom: HK1. `git mv` staging conflicts with the "do not stage" rule. The orchestrator had to
  `git add -A` to make the reviewer see renames.
- Fix: compute `run.diff` with `-M` against a temporary index that includes untracked files, so
  renames show without touching the real index.

### A17. P3. Abandon leaves partial files
- Fix: list the files the run touched in the abandon result, and offer an optional
  `cleanup: true`.

### A18. P3. Other small items
- `pipeline_report` truncates findings; add a full mode.
- StructuredOutput enforcement fired twice after a submitted verdict (A3a2).
- Smoke runs every check even when the project cannot run it yet.
- The scratch-dir deletion by the implementer was rejected "by policy" despite unrestricted
  permissions (H2, A3a3, S5.5). Check whether this is AIDE's sandbox or the CLI's.

---

## B. Space Hospital machine configuration (`aide/pipelines/`)

### B1. P1. Split parts do not map onto stageId, task or flags
- Symptom: S4.9, S5.3 and S5.5 rows.
  - Parts (S5.5a/b) run as stageId S5.5 or S5.5b with `withSpec=false`.
  - The task says "if Docs/Plan/stages/{{stageId}}.md exists", but `S5.5b.md` does not exist, so
    the part scope travels only in `designRefs`.
  - `visual` is set by hand and ran for parts the approved spec marks visual=false (S5.3a, S5.5a).
    That cost extra iterations.
- Fix:
  - Add a `specPath` param, separate from `stageId`, and a `part` param.
  - Have the task text say "implement only part X of specPath".
  - Optionally a small pre-step check that reads the part's flags from the spec. With A1 this can
    be a check command.

### B2. P1. Per-stage captures run the whole corpus
- Symptom: `cargo xtask captures` renders about 290 UI cases plus rig scenes on every visual stage
  visit, 25-40 min. The timeout was raised from 20 to 40 min on 2026-10-23. Then `visualReview`
  (Opus) inspects everything, so cost and time grow with the corpus, not with the change.
- Fix (agreed direction with Allex):
  - Mirror the CI tiers.
  - Per stage: a minimal regression set, plus the scenarios and goldens changed vs HEAD, plus an
    explicit list chosen for the task (e.g. `Build/stage/<stageId>/captures.txt` written by the
    implementer from the spec's capture points, or a section of the stage spec).
  - The full corpus and a full visual review run only at the milestone row (M*-CI).
  - Needs A1, an xtask change (`captures --stage <id>`) and a visual-reviewer role update: review
    exactly what was captured, and treat missing frames the task needs as blocking.
  - Set the timeout to about 15 min.

### B3. P2. Reviewers run with `permissions: "write"`
- See A2. Decide whether `review` (Codex) and `visualReview` (Opus) need write access. If they
  need it only for scratch, a "write scratch only" mode or the role text is enough.

### B4. P2. The implement timeout is too short for measurement stages
- Symptom: HK2. The 60-minute limit did not fit full CI (about 10 min), a pre-change baseline and
  the code work.
- Fix: a per-stage timeout param, or run the measurements as check steps.

### B5. P2. No visual spec for visual hotfix stages
- Symptom: H1, H2. Visual stages without `stages/<id>.md` gave reviewers no capture points.
- Fix: the machine should require a capture list when `visual=true` and `withSpec=false`. With B2
  this is the explicit capture list.

### B6. P3. No capture baseline
- Symptom: A3a2. The visual review cannot compare with HEAD, because only current-run captures
  exist.
- Fix: with B2, keep the HEAD captures of the selected cases, or write per-case pixel diffs.

### B7. P3. The art-pack order and a missing CI log
- An art-pack reassembly preceded the approval of a derived source (rig_patient). Reassemble after
  applyReview, before approveKey.
- The fixer got a CI failure claim without the log.

---

## C. Project checks feeding the pipeline

### C1. P1. Quick CI misses its 90 s target by 2-3x
- Measured: 150-246 s (HK2, H2, S5.1). Test binaries run sequentially.
- Fix: run quick test binaries concurrently (already a follow-up in `work_plan.md` for M5-CI).

### C2. P2. Heavy-test growth is seen only at the milestone
- Symptom: M2 full CI 1184 s, and M3 stale ignored-capture expectations.
- Fix: a per-stage report of heavy-test deltas, or run the affected ignored tests when their inputs
  change (UI sidecars).

---

## D. Orchestrator workflow and cost

### D1. P1. Orchestrator context is the largest Claude cost
- In the 2026-10-10 analysis it was about 41%. Every call re-reads the whole context (about
  265k tokens).
- Still true: each escalation costs status plus output plus answer calls.
- Fixes, in order of impact:
  - `pipeline_answer` with `wait` (exists; use it always).
  - Escalation payloads that already contain the needed output, so no `pipeline_output` follow-up
    is needed.
  - Machine-side bookkeeping (plan rows; commitPrep does most of it now).
  - The orchestrator compacts at milestone boundaries.

### D2. P2. Rules are scattered
- Rules live across memory files, CLAUDE.md, role files, `designRefs` text and decisions.
  `designRefs` accumulates implementer commands ("Start coding now", "Run quick CI") that then
  reach reviewers (S5.1 row).
- Fix: separate `implementerNotes` from `designRefs`, and give each step only what applies to it.

### D3. P2. Plan edits need the tree to be quiet
- The orchestrator must not edit tracked files during a run, so plan edits wait for the run to
  end. An untracked file written mid-run would be swept into the commit by the algorithmic review
  ("every changed or untracked file is staged or excluded").
- Fix: a pause-safe "orchestrator edit" window, or have the algorithmic review ignore paths
  outside the run's touched set.

---

## Suggested order
1. A2, A3 and A4: one-line context fixes that remove most PIPELINE ISSUE noise.
2. A1, then B2: per-stage captures, the largest time saving.
3. B1: part/specPath params.
4. A13, A5 and A10: fewer manual retries.
5. A7, A8 and A11: feedback quality.
6. The rest.

---

## Status after the AIDE fixes (2026-10-23)

Takes effect after an AIDE release and an MCP restart (`AIDE_Stable`). The
orchestrator also needs a fresh session or a compaction to see the new and
changed tool schemas.

| Item | Status | What changed |
|---|---|---|
| A1 | done | Check commands take `{{params.x}}` / `{{outputs.step.field}}`, shell-quoted (cmd.exe on Windows refuses values with `"`, `%` or line breaks); a list param becomes several arguments. The validator allows only `params.*` / `outputs.*` there. |
| A2 | done | AIDE no longer writes behaviour into the pipeline context at all — only facts (structure, time limit, run state). "Finish the whole task in this visit", "plan the increments, then implement all of them" and the `pipelineIssues` hint are gone from it. **Space Hospital must add them to its role files** (implementer: the first two; every role: the `pipelineIssues` line) before running the new release — see the starter roles in `pipeline-authoring.md` §8. |
| A3 | done | The overview counts granted iterations, same as "Before you". |
| A4 | done | "You need not run them … Run one yourself only when your task or a decision explicitly asks for it." No `mayRunChecks`. |
| A5 | done | `pipeline_amend`: a running agent step is interrupted and continues at once in its own session with the instruction; every later step sees it in "Before you"; the report lists it. |
| A6 | done | `pipeline_reload` switches a paused, stopped or waiting run to the edited machine file if the steps and loops it is in still exist. Role files were already read at every visit. |
| A7 | done | "Before you" lists the latest results of the current pass ("implement: done, checks passed"); a feedback section whose source step has run again in this pass is marked "Superseded". |
| A8 | done | Check feedback: exit code, full log path, failure lines from the whole log (`FAILED`, `panicked at`, `error[`, …), then the tail. |
| A9 | done | `run.iteration` in an `if` is the loop around the `if` (it took the previous step's loop while descending). New `run.iterations.<loop id>`. |
| A10 | not done | Allex decided against an auto-continue rule in the engine (2026-10-11): catching a premature `blocked` stays with the orchestrator. |
| A11 | done | `pipelineIssues[]` in `implementerReport`, `reviewVerdict` and `commitPrep` (the schema describes it; roles should mention it); the report collects them from every visit. Roles that write "PIPELINE ISSUE:" into `non_blocking` or `excluded` should switch. Custom schemas can add the field. |
| A12 | partly | A gate rejected outside loops now holds the run at the gate (resume asks again) instead of failing it. A run stopped while an escalation is open asks for the answer again on resume. No `pause` answer: not answering already holds a run, and the tool descriptions now say so. `stop` still ends the run. |
| A13 | done | A CLI usage limit holds the run (`run_stopped`, `reason: "usage_limit"`, `resumeAt`), keeps the session, and resumes by itself at the reset time when the message names it (also after an AIDE restart). No retry loop; 403s are not treated as limits. |
| A14 | done | A retry after an engine failure, a stop or an amendment continues the step's own session with "continue from where you stopped … do not redo it", without resending the task. |
| A15 | done | Files whose only change is line endings are left out of `run.changedFiles`, the commit coverage check and the dirty-tree warning. |
| A16 | done | `run.diff` shows files moved without `git mv` as renames (temporary index, `-M`); the real index is untouched. |
| A17 | partly | Abandon lists the uncommitted files left in the working tree. No `cleanup` option: deleting files is left to the orchestrator and the user. |
| A18 | partly | `pipeline_report detail: true` already returns every finding; the compact report now says it shows the first 20. StructuredOutput firing twice, smoke runs for checks the project cannot run yet and the rejected scratch-dir deletion were not investigated. |
| B, C | project | Space Hospital configuration and checks. A1 now allows B1/B2 (per-stage captures via a check command with params). |
| D1 | unchanged | The escalation event already carries a clipped message and a ready `pipeline_output` pointer. |
| D2, D3 | project | Separate `implementerNotes` from `designRefs` in the machine. |
