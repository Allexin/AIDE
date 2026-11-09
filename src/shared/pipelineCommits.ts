/**
 * How the pipeline tab and the remote page label commits of a run
 * (docs/pipeline-git-modes-spec.md §7): the repo id when the run has several
 * repos, and a skipped commit block as skipped.
 */

/** The part of a run's git setup the views read (`RunState.git`). */
export interface GitSetupView {
  mode: string
  repos?: Array<{ id: string; path?: string }>
  commits?: boolean
}

/** Why commit blocks of this setup are skipped, or null when they commit. A run stored before `RunState.git` existed commits. */
export function setupSkipReason(setup: GitSetupView | undefined | null): 'commits disabled' | 'no git' | null {
  if (!setup) return null
  if (setup.mode === 'none') return 'no git'
  return setup.commits === false ? 'commits disabled' : null
}

/** Whether the setup has more than one repo: commit lines then name their repo. */
export function hasSeveralRepos(setup: GitSetupView | undefined | null): boolean {
  return setup?.mode === 'git' && (setup.repos?.length ?? 0) > 1
}

/** Why a commit block was skipped, read from its commit action's output (`{ skipped: reason }`), or null. */
export function skippedCommitReason(output: unknown): string | null {
  const skipped = output && typeof output === 'object' ? (output as { skipped?: unknown }).skipped : undefined
  return typeof skipped === 'string' && skipped ? skipped : null
}

/** "skipped (commits disabled)" */
export function skippedLabel(reason: string): string {
  return `skipped (${reason})`
}

/** "web 1a2b3c4d Subject" with several repos, "1a2b3c4d Subject" otherwise (the subject only when there is a message). */
export function commitLine(commit: { sha: string; message?: string; repo?: string }, withRepo: boolean): string {
  const subject = commit.message === undefined ? '' : ` ${commit.message.split('\n')[0]}`
  return `${withRepo && commit.repo ? `${commit.repo} ` : ''}${commit.sha.slice(0, 8)}${subject}`
}

/** Whether a run report names several repos (`startCommits` is present only then). */
export function reportHasSeveralRepos(report: { startCommits?: unknown } | null | undefined): boolean {
  const starts = report?.startCommits
  return !!starts && typeof starts === 'object' && Object.keys(starts).length > 1
}

/** The commits of a plan journal's run entry: "web 1a2b3c4d, api 5e6f7a8b", or the shas alone without `repos`. */
export function journalCommitsText(commits: string[], repos?: string[]): string {
  return commits.map((sha, i) => commitLine({ sha, repo: repos?.[i] }, !!repos)).join(', ')
}
