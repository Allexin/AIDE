import { execFile } from 'child_process'
import { statSync } from 'fs'
import { join } from 'path'

/**
 * Git operations the pipeline engine needs (plan §5.7, §3.3). Read-only except
 * `commitIndex`. Every call has a timeout so a hung git never stalls a run.
 */

const GIT_TIMEOUT_MS = 15_000
const MAX_BUFFER = 64 * 1024 * 1024
/** Untracked files larger than this are listed in the diff without content. */
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024

interface GitResult { code: number; stdout: string; stderr: string }

export function git(cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      // execFile reports the exit status as a numeric `code`; spawn failures carry a string code.
      const exit = (err as { code?: unknown } | null)?.code
      const code = !err ? 0 : typeof exit === 'number' ? exit : 1
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    if (stdin !== undefined) child.stdin?.end(stdin, 'utf8')
  })
}

async function gitOk(cwd: string, args: string[], stdin?: string): Promise<string> {
  const result = await git(cwd, args, stdin)
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

function kindOf(code: string): ChangeKind {
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

export async function status(cwd: string): Promise<FileChange[]> {
  return parsePorcelain(await gitOk(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
}

export async function headSha(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() : null
}

/**
 * Diff of the working tree against HEAD including untracked files — what a code
 * reviewer must see (plan §3.3). Does not touch the index.
 */
export async function workingDiff(cwd: string): Promise<string> {
  const hasHead = (await headSha(cwd)) !== null
  const tracked = hasHead ? await gitOk(cwd, ['diff', 'HEAD', '--no-color']) : await gitOk(cwd, ['diff', '--cached', '--no-color'])
  const untracked = (await gitOk(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  const sections = [tracked.trimEnd()]
  for (const path of untracked) sections.push(await untrackedDiff(cwd, path))
  return sections.filter(Boolean).join('\n') + '\n'
}

async function untrackedDiff(cwd: string, path: string): Promise<string> {
  let bytes = 0
  try { bytes = statSync(join(cwd, path)).size } catch { return '' } // raced with deletion
  if (bytes > MAX_UNTRACKED_DIFF_BYTES) return `diff --git a/${path} b/${path}\nnew file mode 100644\n(new file, ${bytes} bytes — content omitted)`
  // `--no-index` exits with 1 when the files differ, which is always the case here.
  const result = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path])
  return result.stdout.trimEnd()
}

export async function stagedDiff(cwd: string): Promise<string> {
  return gitOk(cwd, ['diff', '--cached', '--no-color'])
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
  files: string[]
  message: string
}

/** Commit exactly the current index with the given message. Hooks run as usual. */
export async function commitIndex(cwd: string, message: string): Promise<CommitResult> {
  const files = (await gitOk(cwd, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  await gitOk(cwd, ['commit', '-F', '-'], message)
  const sha = (await headSha(cwd)) ?? ''
  return { sha, files, message }
}
