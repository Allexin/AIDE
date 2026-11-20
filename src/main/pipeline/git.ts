import { execFile } from 'child_process'
import { copyFileSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { PLANS_DIR, isPlanPath } from './plan/planStore'
import { TASKS_DIR, isTrackerPath } from '../tasks/taskStore'
import type { GitSetup } from './gitConfig'

/**
 * Git operations the pipeline engine needs (plan §5.7, §3.3). Read-only except
 * `commitIndex`. Every call has a timeout so a hung git never
 * stalls a run.
 */

/** Pathspec of a diff that leaves plan and tracker files out. */
const NOT_PLANS = ['--', '.', `:(exclude)${PLANS_DIR}`, `:(exclude)${TASKS_DIR}`]

/** Plan and tracker files: AIDE writes them while a run works, they are not part of its work and AIDE never stages them. */
function isAideRecordPath(path: string): boolean {
  return isPlanPath(path) || isTrackerPath(path)
}

const GIT_TIMEOUT_MS = 15_000
/** Commit hooks (formatters, linters) can take minutes. */
const COMMIT_TIMEOUT_MS = 10 * 60_000
const MAX_BUFFER = 64 * 1024 * 1024
/** Untracked files larger than this are listed in the diff without content. */
export const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024

interface GitResult { code: number; stdout: string; stderr: string }

export function git(cwd: string, args: string[], stdin?: string, env?: NodeJS.ProcessEnv, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      // execFile reports the exit status as a numeric `code`; spawn failures carry a string code.
      const exit = (err as { code?: unknown } | null)?.code
      const code = !err ? 0 : typeof exit === 'number' ? exit : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    if (stdin !== undefined) child.stdin?.end(stdin, 'utf8')
  })
}

async function gitOk(cwd: string, args: string[], stdin?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(cwd, args, stdin, env)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface FileChange {
  path: string
  kind: ChangeKind
  /** Has changes in the index. */
  staged: boolean
  /** Has changes in the working tree not in the index (or is untracked). */
  unstaged: boolean
}

export function kindOf(code: string): ChangeKind {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R' || code === 'C') return 'renamed'
  return 'modified'
}

/** Parse `git status --porcelain=v1 -z`. */
export function parsePorcelain(output: string): FileChange[] {
  const parts = output.split('\0')
  const changes: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    if (x === 'R' || x === 'C') i++ // the next field is the original path
    if (x === '?' && y === '?') { changes.push({ path, kind: 'untracked', staged: false, unstaged: true }); continue }
    if (x === '!' && y === '!') continue
    changes.push({ path, kind: kindOf(x !== ' ' ? x : y), staged: x !== ' ', unstaged: y !== ' ' })
  }
  return changes
}

/**
 * Where one repo's reads run and how their paths become project-relative
 * (docs/pipeline-git-modes-spec.md §2). The root repo has an empty prefix and no
 * nested repos: its commands and output are exactly those of the single-cwd reads.
 */
interface RepoRead {
  cwd: string
  /** `frontend/` for a repo at `frontend`; empty for the root. */
  prefix: string
  /** Repo-relative paths of other repos of the run inside this one: their files are reported by those repos. */
  nested: string[]
}

/** What `workingDiff` returns for a no-git setup. A run does not ask: its `run.diff` comes from the shadow (`shadow.ts`). */
export const NO_GIT_DIFF = '(diff unavailable: the project is not a git repository AIDE reads (no-git mode); read the files the implementer reports)\n'

/** The reads of a setup's repos, or of one of them. Nested repos are worked out against the whole setup either way. */
function repoReads(setup: GitSetup, repoId?: string): RepoRead[] {
  if (setup.mode !== 'git') return []
  return setup.repos.filter((repo) => repoId === undefined || repo.id === repoId).map((repo) => {
    const nested = setup.repos.filter((other) => other !== repo && isInside(other.path, repo.path)).map((other) => repo.path === '.' ? other.path : other.path.slice(repo.path.length + 1))
    return { cwd: repo.abs, prefix: repo.path === '.' ? '' : `${repo.path}/`, nested }
  })
}

function isInside(path: string, parent: string): boolean {
  if (path === parent) return false
  return parent === '.' ? path !== '.' : path.startsWith(`${parent}/`)
}

const rootRead = (cwd: string): RepoRead => ({ cwd, prefix: '', nested: [] })

/**
 * `rename from`/`copy to` header lines name repo-relative paths whatever the
 * diff prefixes are: make them project-relative too. (A line of a hunk starts
 * with a space, `+`, `-` or `\`, so only header lines match.)
 */
export function prefixRenameLines(read: Pick<RepoRead, 'prefix'>, diff: string): string {
  return read.prefix ? diff.replace(/^((?:rename|copy) (?:from|to) )/gm, `$1${read.prefix}`) : diff
}

/** `--src-prefix`/`--dst-prefix` of a prefixed repo; nothing for the root (git's defaults). */
export function prefixArgs(read: Pick<RepoRead, 'prefix'>): string[] {
  return read.prefix ? [`--src-prefix=a/${read.prefix}`, `--dst-prefix=b/${read.prefix}`] : []
}

/** Pathspec of a diff: plan and tracker files left out at the root (they live in the project root's aide/plans and aide/tasks), nested repos left out. */
function diffPathspec(read: RepoRead): string[] {
  return [...(read.prefix ? ['--', '.'] : NOT_PLANS), ...read.nested.map((path) => `:(exclude)${path}`)]
}

/** Pathspec of a status/ls-files call: nested repos left out (none at the root of root mode: no pathspec, as before). */
function nestedPathspec(read: RepoRead): string[] {
  return read.nested.length ? ['--', '.', ...read.nested.map((path) => `:(exclude)${path}`)] : []
}

/**
 * Changed files. A modified file whose only difference is line endings (CRLF in
 * the working tree, LF in the index) is left out: it is noise to reviewers and
 * to the commit coverage check. So are plan and tracker files: AIDE edits them
 * while a run works, and they are not part of its work.
 *
 * With a run's setup, every repo (or only `repoId`) is read in config order and
 * paths are project-relative (`frontend/src/a.ts`); no-git mode has no changes.
 */
export async function status(target: string | GitSetup, repoId?: string): Promise<FileChange[]> {
  if (typeof target === 'string') return statusIn(rootRead(target))
  const changes: FileChange[] = []
  for (const read of repoReads(target, repoId)) changes.push(...await statusIn(read))
  return changes
}

async function statusIn(read: RepoRead): Promise<FileChange[]> {
  const { cwd, prefix } = read
  const changes = parsePorcelain(await gitOk(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...nestedPathspec(read)]))
    .map((c) => prefix ? { ...c, path: prefix + c.path } : c)
    .filter((c) => !isAideRecordPath(c.path))
  if (!changes.some((c) => c.kind === 'modified')) return changes
  const real = new Set<string>()
  for (const args of [['diff', '--numstat', '-z', '--ignore-cr-at-eol'], ['diff', '--cached', '--numstat', '-z', '--ignore-cr-at-eol']]) {
    const result = await git(cwd, args)
    if (result.code !== 0) return changes
    for (const path of parseNumstatPaths(result.stdout)) real.add(prefix + path)
  }
  return changes.filter((c) => c.kind !== 'modified' || real.has(c.path))
}

/** Paths of `git diff --numstat -z` (a rename entry has an empty path followed by the old and new path). */
export function parseNumstatPaths(output: string): string[] {
  const parts = output.split('\0')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const match = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/s.exec(parts[i].replace(/^\n/, ''))
    if (!match) continue
    if (match[1]) paths.push(match[1])
    else { paths.push(parts[i + 1], parts[i + 2]); i += 2 }
  }
  return paths.filter(Boolean)
}

export async function headSha(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() : null
}

/**
 * Diff of the working tree against HEAD including untracked files — what a code
 * reviewer must see (plan §3.3). Does not touch the index.
 *
 * With a run's setup: the repos' diffs in config order, paths project-relative
 * (`a/frontend/src/a.ts`); no-git mode gets a note instead.
 */
export async function workingDiff(target: string | GitSetup): Promise<string> {
  if (typeof target === 'string') return workingDiffIn(rootRead(target))
  if (target.mode !== 'git') return NO_GIT_DIFF
  const sections: string[] = []
  for (const read of repoReads(target)) sections.push(prefixRenameLines(read, await workingDiffIn(read)).trimEnd())
  return sections.filter(Boolean).join('\n') + '\n'
}

async function workingDiffIn(read: RepoRead): Promise<string> {
  const { cwd, prefix } = read
  const hasHead = (await headSha(cwd)) !== null
  const untracked = (await gitOk(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...nestedPathspec(read)])).split('\0').filter((path) => path && !isAideRecordPath(prefix + path))
  if (hasHead && untracked.length) {
    // A file moved without `git mv` is a deleted tracked file plus an untracked one.
    const deleted = (await gitOk(cwd, ['ls-files', '--deleted', '-z'])).split('\0').filter(Boolean)
    if (deleted.length) {
      const diff = await renameAwareDiff(read, untracked).catch(() => null)
      if (diff !== null) return diff
    }
  }
  const tracked = hasHead ? await gitOk(cwd, ['diff', 'HEAD', '--no-color', ...prefixArgs(read), ...diffPathspec(read)]) : await gitOk(cwd, ['diff', '--cached', '--no-color', ...prefixArgs(read), ...diffPathspec(read)])
  const sections = [tracked.trimEnd()]
  for (const path of untracked) sections.push(await untrackedDiff(read, path))
  return sections.filter(Boolean).join('\n') + '\n'
}

/**
 * The working diff with renames detected: everything is added to a temporary
 * copy of the index and diffed against HEAD with `-M`. The real index is not
 * touched. Large untracked files are listed without content, as usual.
 */
async function renameAwareDiff(read: RepoRead, untracked: string[]): Promise<string> {
  const { cwd } = read
  const big = untracked.filter((path) => { try { return statSync(join(cwd, path)).size > MAX_UNTRACKED_DIFF_BYTES } catch { return false } })
  const index = resolve(cwd, (await gitOk(cwd, ['rev-parse', '--git-path', 'index'])).trim())
  const temp = join(tmpdir(), `aide-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    if (existsSync(index)) copyFileSync(index, temp)
    const env = { ...process.env, GIT_INDEX_FILE: temp }
    await gitOk(cwd, ['add', '-A', '--', '.', ...big.map((path) => `:(exclude)${path}`), ...read.nested.map((path) => `:(exclude)${path}`)], undefined, env)
    const diff = await gitOk(cwd, ['diff', '--cached', '-M', '--no-color', ...prefixArgs(read), 'HEAD', ...diffPathspec(read)], undefined, env)
    const sections = [diff.trimEnd(), ...big.map((path) => bigFileStub(read, path))]
    return sections.filter(Boolean).join('\n') + '\n'
  } finally {
    rmSync(temp, { force: true })
  }
}

function bigFileStub(read: RepoRead, path: string): string {
  let bytes = 0
  try { bytes = statSync(join(read.cwd, path)).size } catch { return '' }
  const shown = read.prefix + path
  return `diff --git a/${shown} b/${shown}\nnew file mode 100644\n(new file, ${bytes} bytes — content omitted)`
}

async function untrackedDiff(read: RepoRead, path: string): Promise<string> {
  let bytes = 0
  try { bytes = statSync(join(read.cwd, path)).size } catch { return '' } // raced with deletion
  if (bytes > MAX_UNTRACKED_DIFF_BYTES) return bigFileStub(read, path)
  // `--no-index` exits with 1 when the files differ, which is always the case here.
  const result = await git(read.cwd, ['diff', '--no-color', '--no-index', ...prefixArgs(read), '--', '/dev/null', path])
  return result.stdout.trimEnd()
}

/** The index against HEAD; with a run's setup, every repo's (or only `repoId`'s) in config order (no-git mode: nothing is staged). */
export async function stagedDiff(target: string | GitSetup, repoId?: string): Promise<string> {
  if (typeof target === 'string') return stagedDiffIn(rootRead(target))
  const parts: string[] = []
  for (const read of repoReads(target, repoId)) parts.push(prefixRenameLines(read, await stagedDiffIn(read)))
  return parts.join('')
}

function stagedDiffIn(read: RepoRead): Promise<string> {
  return gitOk(read.cwd, ['diff', '--cached', '--no-color', ...prefixArgs(read), ...diffPathspec(read)])
}

/** Commits after `since` (exclusive) as "<short sha> <subject>", newest first; empty when `since` is unknown. */
export async function commitsSince(cwd: string, since: string): Promise<string[]> {
  const result = await git(cwd, ['log', '--format=%h %s', `${since}..HEAD`])
  return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : []
}

export interface CommitCoverage {
  ok: boolean
  issues: string[]
  staged: string[]
}

/**
 * Algorithmic commit review (plan §3.3): the index is not empty, a message is
 * present, and every modified or untracked file is either staged or explicitly
 * excluded. Partially staged files are reported as well.
 */
export function checkCommitCoverage(changes: FileChange[], message: string, excluded: string[]): CommitCoverage {
  const normalize = (p: string): string => p.replace(/\\/g, '/')
  const excludedSet = new Set(excluded.map(normalize))
  const issues: string[] = []
  const staged = changes.filter((c) => c.staged).map((c) => c.path)
  if (staged.length === 0) issues.push('Nothing is staged.')
  if (!message.trim()) issues.push('The commit message is empty.')
  for (const change of changes) {
    const path = normalize(change.path)
    if (excludedSet.has(path)) continue
    if (!change.staged) issues.push(`${path} is ${change.kind === 'untracked' ? 'untracked' : 'modified'} but neither staged nor listed in "excluded".`)
    else if (change.unstaged) issues.push(`${path} is only partially staged; stage the rest or list it in "excluded".`)
  }
  for (const path of excludedSet) {
    if (staged.map(normalize).includes(path)) issues.push(`${path} is listed in "excluded" but is staged.`)
  }
  return { ok: issues.length === 0, issues, staged }
}

export interface CommitResult {
  sha: string
  /** Project-relative. */
  files: string[]
  message: string
  /** Id of the repo the commit was made in. */
  repo: string
}

/** What `git commit` knows: `files` are relative to the repo, which the caller names. */
export type IndexCommit = Omit<CommitResult, 'repo'>

/**
 * Commit exactly the current index with the given message. Hooks run as usual.
 *
 * Success is decided by HEAD, not by the exit code alone: an auto gc after the
 * commit once outlasted the git timeout, so the commit was made but reported as
 * failed ("Auto packing the repository…"), and the retry found nothing staged.
 * Auto gc is off for this command (the user's next git command packs instead),
 * the timeout leaves room for hooks, and a new HEAD on top of the old one counts
 * as a commit whatever happened after it.
 */
export async function commitIndex(cwd: string, message: string): Promise<IndexCommit> {
  const files = (await gitOk(cwd, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  const before = await headSha(cwd)
  const result = await git(cwd, ['-c', 'gc.auto=0', 'commit', '-F', '-'], message, undefined, COMMIT_TIMEOUT_MS)
  const after = await headSha(cwd)
  if (result.code !== 0 && !(after && after !== before && (await parentSha(cwd, after)) === before)) {
    throw new Error(`git commit -F - failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`)
  }
  return { sha: after ?? '', files, message }
}

async function parentSha(cwd: string, sha: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^`])
  return result.code === 0 ? result.stdout.trim() : null
}
