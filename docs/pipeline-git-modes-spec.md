# Pipeline git modes: repos in subfolders, no commits, no git

Status: step 1 of §10 implemented (2026-11-09): `gitConfig.ts`, repo-aware
reads, `RunState.git`, the resume re-check, project errors in
`pipeline_validate`. Until steps 2–3, a commit step escalates instead of
committing in no-git mode, with `commits: false`, or with several repos; no-git
reads give a note (`NO_GIT_DIFF`) instead of a shadow diff. Steps 2–4 are not
implemented.

Implementation notes for step 1:
- `EngineDeps.git` reads take the `GitSetup` itself (there is no separate
  `GitScope` type); `headSha` and `commitIndex` still take a cwd (the first
  repo's `abs`).
- `resolveGitSetup(projectPath, config?)` is async (it runs git) and throws
  `GitConfigError` with `problems`. `checkRepos(setup, projectPath)` is the
  resume re-check; the root repo of a project without config only has to stay
  inside a work tree (it may be a subfolder of its repo).
- `rename from`/`rename to` lines of a prefixed repo are prefixed too, so
  `engine/inputs.ts` sees project-relative paths for renames.

Today every git operation of the pipeline engine runs in the project root
(`src/main/pipeline/git.ts`, called from `engine/runner.ts`, `manager.ts`,
`plan/planService.ts`). A project whose repositories live in subfolders, a
project without git, and a project that forbids commits by AI cannot run
pipelines: `status`/`diff` throw and the run escalates, or the run commits where
it must not.

This spec adds four modes, chosen by the project's shared config:

| Mode | When | Diff source | Commit steps |
|---|---|---|---|
| **root** (today) | no `git` config, the root is inside a git work tree | real repo, vs HEAD | commit in the root repo |
| **repos** | `git.repos` lists repos in subfolders | real repos, vs HEAD, paths prefixed | each commit step commits in one named repo |
| **no commits** | `git.commits: false` (with root or repos) | shadow snapshot per repo | skipped, checkpoint |
| **no git** | `git: false`, or no `git` config and the root is not in a work tree | shadow snapshot of the project | skipped, checkpoint |

A project with no `git` config whose root is a repo behaves exactly as today:
no engine version bump (see §8).

## 1. Config

`aide/config.json` (shared, read by `readSharedConfig`):

```json
{
  "git": {
    "repos": { "web": "frontend", "api": "services/api" },
    "commits": true,
    "shadowExclude": ["assets/raw/"]
  }
}
```

- `git: false` — no-git mode: AIDE never runs git against the project's
  repositories (the shadow snapshot, §5, still uses the git binary on its own
  git dir).
- `git.repos` — map of repo id → project-relative path. Ids: letters, digits,
  `_`, `-`. Each path must be the top level of a git work tree
  (`git -C <path> rev-parse --show-toplevel` equals the path); porcelain and diff
  paths are relative to the top level, so a path inside a repo is rejected.
  `"."` is allowed (root repo plus repos in subfolders).
  Absent: one repo with id `root` at `.` if the root is inside a work tree
  (today's behaviour, including a project opened in a subfolder of a repo),
  otherwise no-git mode.
- `git.commits` — default `true`. `false`: AIDE does not commit and agents are
  told not to stage or commit (§4).
- `git.shadowExclude` — extra gitignore-style patterns for the shadow snapshot.

Parsed and validated in a new `src/main/pipeline/gitConfig.ts`
(`resolveGitSetup(projectPath): GitSetup`). Errors (bad id, missing path, path
not a work-tree top level) are run-start errors: `pipeline_start` fails with the
list, `pipeline_validate` reports them as project errors.

```ts
type GitSetup =
  | { mode: 'git'; repos: Repo[]; commits: boolean }   // root and repos modes
  | { mode: 'none' }
interface Repo { id: string; path: string /* project-relative, '.' for root */; abs: string }
```

The setup is resolved once at run start and stored in `RunState.git`, so a
config edit does not change a running run; resume re-checks that the repos still
exist and escalates if not.

## 2. Reads across repos

`run.diff`, `run.stagedDiff`, `run.changedFiles`, the dirty-tree warning at
start (`manager.ts:200`) and the list returned by abandon (`manager.ts:336`)
span every repo of the run:

- Paths are project-relative: a repo at `frontend` reports `frontend/src/a.ts`.
  Diffs use `--src-prefix=a/frontend/ --dst-prefix=b/frontend/` (also for the
  `--no-index` diff of untracked files and the big-file stub), so
  `engine/inputs.ts` splits and filters them unchanged and `exclude` patterns of
  inputs match project-relative paths. The root repo has an empty prefix: output
  is byte-identical to today.
- Sections are concatenated in config order.
- A repo listed in another repo (e.g. `.` and `frontend`, where `frontend` is
  ignored or an embedded repo in the root): the outer repo's status skips the
  inner repo's path, so a file is reported once.
- Files outside every repo (a non-repo root holding `frontend/` and
  `backend/`) are invisible to git reads. That is documented in the authoring
  guide; a project that wants them reviewed sets `commits: false`, which uses the
  project-wide shadow (§5 covers non-repo areas in that case, see there).

`git.ts` gets a repo-aware layer (`repoSet.ts` or inside `git.ts`):
`workingDiff(repos)`, `stagedDiff(repos)`, `status(repos)` built on the
existing single-cwd functions plus a `prefix` argument. `EngineDeps.git` takes a
`GitScope` (the run's resolved setup) instead of a cwd.

## 3. Commit steps in repos mode

New optional field on the commit step: `repo` (string; may be a template such as
`"{{params.repo}}"`, rendered with the run's params).

Resolution at run start (manager, before the run is created):
- `repo` given → must name a repo of the setup;
- absent and the setup has one repo → that repo;
- absent and several repos → start error: `Commit step "commit" must name its
  repo ("repo": one of web, api).`
- `commits: false` or no git → `repo` is ignored (the block is skipped).

The resolved repo per commit step is stored in `RunState.commitRepos`.

In the step:
- coverage (`checkCommitCoverage`) looks at that repo's status only; paths are
  project-relative in issues;
- the agent reviewer gets that repo's staged diff;
- `commitIndex` runs in that repo; `CommitResult` gains `repo: string` (id);
  the `commit_done` summary names the repo when the setup has more than one;
- the prep agent's context line becomes: `You prepare the commit in the
  repository at frontend/ (stage with git -C frontend add …); AIDE reviews it and
  commits. Do not commit yourself.` (root repo: today's text).

Changes left in other repos are not this step's business. At run end the report
lists `uncommitted` (project-relative paths still changed in any repo), so the
Orchestrator/Strategist sees work no commit step took.

Static validation (`validate.ts`, `machineSchema.ts`): `repo` is a string; a
template may only reference `params.*`. Whether the id exists is a run-start
check (machines are project-agnostic).

## 4. No commits

With `commits: false` or in no-git mode:

- Every commit block is skipped as a whole: its prep agent and reviewer do not
  run. The block gets one visit with outcome `ok` and output
  `{ skipped: "commits disabled" | "no git", checkpoint: <shadow sha | null>, issues: [] }`,
  and a `commit_skipped` event (`summary: "commit skipped: the project does not
  let AIDE commit"`). The loop counter of the block is not used.
- At the skip AIDE takes a shadow checkpoint (§5), so the next task's
  `run.diff` shows only its own work.
- References to `outputs.<prep id>.*` after a skipped block resolve as absent,
  as for a step in a branch not taken. `validate.ts` warns when a step's inputs or
  conditions reference a commit prep's outputs (they are empty in these modes).
- Agent context: instead of "Staging and committing happen in a later step" /
  the prep line, every agent step gets `- This project does not let AIDE commit:
  do not stage or commit; leave your changes in the working tree.` The outline
  shows commit blocks as `(skipped: commits disabled)`.
- Plan tasks: the last commit block of a run on a plan task still calls
  `planCommit` (marks the task done in the working tree) at the point of the
  skip; there is no Plan-Task trailer. `onRunEnded` keeps marking the task done
  as a fallback.
- The dirty-tree warning at start is dropped: the shadow baseline (§5) keeps
  earlier changes out of the run's diff.

## 5. Shadow snapshot

A private git dir per scope that records snapshots of a work tree without
touching it or its real repository.

- Scopes: in no-commit mode one per repo (work tree = repo path; the repo's own
  `.gitignore` files apply); in no-git mode one for the project (work tree =
  project root). In no-commit mode with a non-repo root, a further `project`
  scope covers the root with the repos' paths excluded, so non-repo files are
  reviewed too.
- Location: `.aide/users/<user>/shadow/<runId>/<scope>.git` — per user (SMB
  collaborators run their own pipelines) and per run (no cross-run state, cleanup
  is a directory delete). Deleted when the run becomes final (finished, failed,
  abandoned); kept while it is stopped or waiting, so a resume after restart
  finds it. Leftover dirs of runs that no longer exist are deleted at app start.
- Every command: `git --git-dir=<shadow> --work-tree=<root> -c core.autocrlf=false -c core.quotepath=off -c gc.auto=0 …`,
  through the existing `git()` helper (timeouts as today).
- Excludes (`<shadow>/info/exclude`): `.aide/`, `.git` is ignored by git itself,
  embedded repos are skipped by excluding the paths of the setup's other repos;
  in no-git mode also a default list: `node_modules/ dist/ build/ out/ target/
  .venv/ venv/ __pycache__/ .next/ .nuxt/ coverage/ *.log`, plus
  `git.shadowExclude`. Plan files are excluded as in today's diff.
- Snapshot: list candidate files (`ls-files --others --modified --exclude-standard -z`
  against the shadow index), leave out files over 256 KB (they appear in the diff
  as the usual "content omitted" stub, by size comparison with the checkpoint),
  `add -A` the rest, `commit --allow-empty -m "<label>"`, record the sha in
  `RunState.shadow[scope]`.
- Baseline at run start; checkpoint at each skipped commit block.
- `run.diff` = rename-aware diff of the work tree vs the last checkpoint
  (same temp-index technique as `renameAwareDiff`, against the shadow), prefixed
  per §2. `run.changedFiles` from the same comparison. `run.stagedDiff` is empty
  (nothing is staged in these modes).
- Limits: more than 50 000 candidate files, or a snapshot that times out
  (60 s), disables the shadow for the run: `run.diff` becomes
  `(diff unavailable: <reason>; read the files the implementer reports)`, a
  `logEvent('pipeline.shadow_disabled', …)` is recorded and the run continues.
  No git binary at all: the same, with reason `git is not installed`.

## 6. Run state and plans

- `RunState.startCommit` stays (sha of the first repo, for old readers);
  new `RunState.startCommits: Record<repoId, string | null>`. Old states load
  with `startCommits = { root: startCommit }`.
- `RunState.git: GitSetup` (as resolved, §1), `commitRepos`, `shadow`.
- Plan autopilot: `AutopilotState.lastCommit` → `lastCommits: Record<repoId, string>`
  (old `lastCommit` read as `{ root }`). "Commits made outside the plan" runs
  `commitsSince` per repo; lines are prefixed `web: ` when there are several
  repos. No-git / no-commit: the section is omitted.

## 7. UI and docs

- Pipeline tab and remote page: a commit line shows `web 1a2b3c4d …` when the
  setup has several repos; a skipped commit block shows "skipped (commits
  disabled)". All text in English.
- `resources/docs/pipeline-authoring.md`: §4 gains `repo`, the modes table, and
  the advice that a library machine meant for multi-repo projects takes the repo
  as a param (`"repo": "{{params.repo}}"`).
- `machineSchema.ts`: `repo` on the commit step.
- `pipeline_hello` / project-level validation reports the resolved mode in one
  line (`git: repos web=frontend, api=services/api; commits on`).

## 8. Compatibility

No `ENGINE_VERSION` bump: a project without `git` config whose root is a repo
gets the same generated context, diffs and commits as today; `repo` is a new
optional field. The modes only change behaviour for projects that opt in through
config, or that could not run pipelines at all before (no repo at the root).

## 9. Tests

- `git.test.ts`: prefixed diff/status of a repo in a subfolder; two repos; a
  repo containing another; root output unchanged (byte-compare with today).
- `gitConfig.test.ts`: resolution of each mode, errors for bad paths/ids, a path
  inside a repo rejected.
- `shadow.test.ts`: baseline + change + checkpoint gives only the new change;
  excludes; big-file stub; rename detection; the file-count limit disables the
  shadow.
- `runner.test.ts`: commit step `repo` resolution (template, single repo,
  missing → start error); coverage limited to the step's repo; commit block
  skipped with checkpoint in no-commit mode; context text in each mode; plan
  task marked done at a skipped last commit.
- `planService.test.ts`: outside commits per repo; old `lastCommit` migrates.

## 10. Implementation order

1. `gitConfig.ts` + repo-aware reads in `git.ts`, `EngineDeps.git` on a scope;
   root mode unchanged (tests prove byte-identical output).
2. Commit step `repo` (schema, validation, start-time resolution, runner,
   context text, report `uncommitted`).
3. Shadow snapshot module + no-commit / no-git skipping, context, plan hooks.
4. State migration (`startCommits`, `lastCommits`), UI labels, authoring guide.
