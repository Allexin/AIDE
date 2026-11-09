import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { lstat, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MAX_UNTRACKED_DIFF_BYTES, git, kindOf, prefixArgs, prefixRenameLines, type FileChange } from './git'
import type { GitSetup } from './gitConfig'
import { PLANS_DIR } from './plan/planStore'

/**
 * Shadow snapshots (docs/pipeline-git-modes-spec.md §5): a private git dir per
 * scope records the work tree of a run that cannot read its changes from a real
 * repository vs HEAD (no git, or commits off). The work tree and any real
 * repository are never touched; the private dirs live in
 * `.aide/users/<user>/shadow/<runId>/<scope>.git` and go away with the run.
 */

/** More candidate files than this, or a snapshot that takes longer, turns the shadow off for the run. */
export const MAX_SHADOW_FILES = 50_000
export const SHADOW_TIMEOUT_MS = 60_000

/** What the default excludes keep out of a work tree that has no `.gitignore` of a repository to rely on. */
const DEFAULT_EXCLUDES = ['node_modules/', 'dist/', 'build/', 'out/', 'target/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', 'coverage/', '*.log']

/** The size of each file left out of the last snapshot (over the size limit), by path. */
const BIG_FILES = 'aide-big-files.json'

/** The note `run.diff` is when there is no shadow to diff. */
export function unavailableDiff(reason: string): string {
  return `(diff unavailable: ${reason}; read the files the implementer reports)\n`
}

/** A work tree the run takes snapshots of. */
export interface ShadowScope {
  id: string
  /** The work tree. */
  abs: string
  /** `frontend/` for a repo at `frontend`, empty at the project root: makes its paths project-relative. */
  prefix: string
  /** gitignore patterns for the private `info/exclude`. */
  excludes: string[]
}

export interface ShadowTarget { runId: string; projectPath: string; setup: GitSetup }

/** Commit id per scope. */
export type ShadowShas = Record<string, string>

/** A literal path as a gitignore pattern anchored to the work tree. */
function anchored(path: string): string {
  return `/${path.replace(/[\\[\]*?!#]/g, '\\$&')}/`
}

/** Where the plan files are inside a scope, or null when they are outside it. */
function plansWithin(prefix: string): string | null {
  if (!prefix) return PLANS_DIR
  return `${PLANS_DIR}/`.startsWith(prefix) ? PLANS_DIR.slice(prefix.length) : null
}

/** The scopes of a run: no git, the project; commits off, one per repo and the project's non-repo files if its root is not a repo. */
export function shadowScopes(setup: GitSetup, projectPath: string): ShadowScope[] {
  const extra = setup.shadowExclude ?? []
  const plans = (prefix: string): string[] => { const dir = plansWithin(prefix); return dir ? [anchored(dir)] : [] }
  const project = (id: string, inside: string[]): ShadowScope => ({ id, abs: projectPath, prefix: '', excludes: ['.aide/', ...plans(''), ...DEFAULT_EXCLUDES, ...inside.map(anchored), ...extra] })
  if (setup.mode === 'none') return [project('project', [])]

  const scopes = setup.repos.map((repo): ShadowScope => {
    const prefix = repo.path === '.' ? '' : `${repo.path}/`
    // Files of a repo inside this one are reported by that repo's own scope.
    const nested = setup.repos.filter((other) => other !== repo && (repo.path === '.' ? other.path !== '.' : other.path.startsWith(prefix))).map((other) => other.path.slice(prefix.length))
    return { id: repo.id, abs: repo.abs, prefix, excludes: ['.aide/', ...plans(prefix), ...nested.map(anchored), ...extra] }
  })
  if (setup.repos.some((repo) => repo.path === '.')) return scopes
  // `~` is not allowed in repo ids, so this scope cannot take the place of a repo called "project".
  return [...scopes, project(setup.repos.some((repo) => repo.id === 'project') ? 'project~' : 'project', setup.repos.map((repo) => repo.path))]
}

/** One command's worth of what is needed to talk to a scope's private git dir. */
interface ScopeGit { gitDir: string; scope: ShadowScope; deadline: number }

/** What a work tree holds beyond the scope's last snapshot. */
interface WorkTreeState {
  /** Files over the size limit, with their size; they are never added. */
  big: Map<string, number>
  /** Repositories inside the work tree that the shadow must not record as gitlinks. */
  embedded: string[]
  /** Candidates the shadow's index knows (a modified or deleted file, as opposed to an untracked one). */
  tracked: Set<string>
}

function shadowArgs({ gitDir, scope }: ScopeGit, args: string[]): string[] {
  return [
    `--git-dir=${gitDir}`,
    `--work-tree=${scope.abs}`,
    // Line endings as in the file; hooks and identity of the user's config must not reach private commits.
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.quotepath=off',
    '-c', 'core.longpaths=true',
    '-c', `core.hooksPath=${join(gitDir, 'no-hooks')}`,
    '-c', 'gc.auto=0',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=AIDE',
    '-c', 'user.email=aide@localhost',
    ...args
  ]
}

/** Runs git on the private dir within the snapshot's time limit. */
async function runGit(ctx: ScopeGit, args: string[], stdin?: string, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const left = ctx.deadline - Date.now()
  if (left <= 0) throw new Error(`the snapshot took more than ${SHADOW_TIMEOUT_MS / 1000} s`)
  const result = await git(ctx.scope.abs, shadowArgs(ctx, args), stdin, env, left)
  if (result.code !== 0 && Date.now() >= ctx.deadline) throw new Error(`the snapshot took more than ${SHADOW_TIMEOUT_MS / 1000} s`)
  return result
}

async function gitOk(ctx: ScopeGit, args: string[], stdin?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGit(ctx, args, stdin, env)
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`)
  return result.stdout
}

async function ensureInit(ctx: ScopeGit): Promise<void> {
  if (!existsSync(join(ctx.gitDir, 'HEAD'))) {
    // An empty template: no sample hooks, and nothing of the user's init.templateDir.
    const init = await git(ctx.scope.abs, ['init', '-q', '--bare', '--template=', ctx.gitDir], undefined, undefined, Math.max(1, ctx.deadline - Date.now()))
    if (init.code !== 0) throw new Error(`git init failed: ${(init.stderr || init.stdout).trim() || `exit code ${init.code}`}`)
  }
  mkdirSync(join(ctx.gitDir, 'info'), { recursive: true })
  writeFileSync(join(ctx.gitDir, 'info', 'exclude'), ctx.scope.excludes.join('\n') + '\n')
}

/** Lists what changed against the shadow's index, and which files must stay out of `add`. */
async function inspect(ctx: ScopeGit, maxFiles: number): Promise<WorkTreeState> {
  const entries = (await gitOk(ctx, ['ls-files', '-t', '--others', '--modified', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  if (entries.length > maxFiles) throw new Error(`the project has more than ${maxFiles} files to snapshot (see "git.shadowExclude")`)
  const paths = entries.map((entry) => ({ path: entry.slice(2), tracked: entry[0] !== '?' }))
  const big = new Map<string, number>()
  const tracked = new Set(paths.filter((p) => p.tracked).map((p) => p.path))
  const files = paths.filter((p) => !p.path.endsWith('/')).map((p) => p.path)
  const CHUNK = 256
  for (let i = 0; i < files.length; i += CHUNK) {
    await Promise.all(files.slice(i, i + CHUNK).map(async (path) => {
      try {
        const info = await lstat(join(ctx.scope.abs, path))
        if (info.isFile() && info.size > MAX_UNTRACKED_DIFF_BYTES) big.set(path, info.size)
      } catch { /* raced with deletion: `add -A` handles it */ }
    }))
  }
  // `ls-files` lists an embedded repository as one entry with a trailing slash.
  const embedded = paths.filter((p) => p.path.endsWith('/')).map((p) => p.path.slice(0, -1))
  return { big, embedded, tracked }
}

/** `add -A` of the work tree without the files left out; a file the OS will not let git read does not fail the snapshot. */
async function addAll(ctx: ScopeGit, state: WorkTreeState, env?: NodeJS.ProcessEnv): Promise<void> {
  const leftOut = [...state.big.keys(), ...state.embedded].map((path) => `:(exclude,literal)${path}`)
  const result = await runGit(ctx, ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], ['.', ...leftOut].join('\0') + '\0', env)
  if (result.code !== 0 && /^fatal:/m.test(result.stderr)) throw new Error(`git add failed: ${result.stderr.trim()}`)
}

/** `read` with a temporary copy of the shadow's index that holds the current work tree. */
async function withWorkIndex<T>(ctx: ScopeGit, state: WorkTreeState, read: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const temp = join(tmpdir(), `aide-shadow-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const index = join(ctx.gitDir, 'index')
  try {
    if (existsSync(index)) copyFileSync(index, temp)
    const env = { ...process.env, GIT_INDEX_FILE: temp }
    await addAll(ctx, state, env)
    return await read(env)
  } finally {
    rmSync(temp, { force: true })
  }
}

function readBigFiles(gitDir: string): Record<string, number> {
  try { return JSON.parse(readFileSync(join(gitDir, BIG_FILES), 'utf8')) as Record<string, number> } catch { return {} }
}

interface BigChange { path: string; kind: 'added' | 'modified' | 'deleted'; was?: number; now?: number }

/** The files over the size limit that differ from the checkpoint by size; added, grown, shrunk or gone. */
async function bigChanges(ctx: ScopeGit, state: WorkTreeState): Promise<BigChange[]> {
  const before = readBigFiles(ctx.gitDir)
  const changes: BigChange[] = []
  for (const [path, now] of state.big) {
    const was = before[path]
    if (was === now) continue
    changes.push({ path, kind: was === undefined && !state.tracked.has(path) ? 'added' : 'modified', was, now })
  }
  for (const [path, was] of Object.entries(before)) {
    if (state.big.has(path) || state.tracked.has(path)) continue
    // A shrunk file is an ordinary candidate now and has its own diff.
    if (!existsSync(join(ctx.scope.abs, path))) changes.push({ path, kind: 'deleted', was })
  }
  return changes
}

/** Same format as the stub of an untracked big file in a real repo's diff. */
function bigFileStub(prefix: string, change: BigChange): string {
  const shown = prefix + change.path
  const head = `diff --git a/${shown} b/${shown}`
  if (change.kind === 'added') return `${head}\nnew file mode 100644\n(new file, ${change.now} bytes — content omitted)`
  if (change.kind === 'deleted') return `${head}\ndeleted file mode 100644\n(deleted file, ${change.was} bytes — content omitted)`
  return `${head}\n(changed file, ${change.was === undefined ? '' : `${change.was} → `}${change.now} bytes — content omitted)`
}

function parseNameStatus(output: string): Array<{ path: string; code: string }> {
  const parts = output.split('\0')
  const changes: Array<{ path: string; code: string }> = []
  for (let i = 0; i + 1 < parts.length; i++) {
    const code = parts[i]
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') { changes.push({ path: parts[i + 2], code: code[0] }); i += 2 }
    else { changes.push({ path: parts[i + 1], code: code[0] }); i += 1 }
  }
  return changes
}

export class ShadowStore {
  constructor(private readonly root: string, private readonly maxFiles = MAX_SHADOW_FILES) {}

  private context(target: ShadowTarget, scope: ShadowScope, deadline: number): ScopeGit {
    return { gitDir: join(this.root, target.runId, `${scope.id}.git`), scope, deadline }
  }

  /**
   * Records the work tree of every scope and returns the commits.
   * Throws with the reason when the shadow cannot be used (limits, no git binary, a failed git command).
   */
  async snapshot(target: ShadowTarget, label: string): Promise<ShadowShas> {
    const runDir = join(this.root, target.runId)
    mkdirSync(runDir, { recursive: true })
    // In the run's own folder: a missing project folder must not read as a missing git.
    if ((await git(runDir, ['--version'])).code !== 0) throw new Error('git is not installed')
    const deadline = Date.now() + SHADOW_TIMEOUT_MS
    const shas: ShadowShas = {}
    for (const scope of shadowScopes(target.setup, target.projectPath)) {
      const ctx = this.context(target, scope, deadline)
      await ensureInit(ctx)
      const state = await inspect(ctx, this.maxFiles)
      await addAll(ctx, state)
      await gitOk(ctx, ['commit', '--allow-empty', '--no-verify', '-q', '-m', label])
      shas[scope.id] = (await gitOk(ctx, ['rev-parse', 'HEAD'])).trim()
      writeFileSync(join(ctx.gitDir, BIG_FILES), JSON.stringify(Object.fromEntries(state.big)))
    }
    return shas
  }

  /** The work tree against the checkpoints, with renames detected and project-relative paths. Throws like `snapshot`. */
  async diff(target: ShadowTarget, shas: ShadowShas): Promise<string> {
    const deadline = Date.now() + SHADOW_TIMEOUT_MS
    const sections: string[] = []
    for (const scope of shadowScopes(target.setup, target.projectPath)) {
      const sha = shas[scope.id]
      if (!sha) continue
      const ctx = this.context(target, scope, deadline)
      const state = await inspect(ctx, this.maxFiles)
      const diff = await withWorkIndex(ctx, state, (env) => gitOk(ctx, ['diff', '--cached', '-M', '--no-color', ...prefixArgs(scope), sha], undefined, env))
      sections.push(prefixRenameLines(scope, diff).trimEnd(), ...(await bigChanges(ctx, state)).map((change) => bigFileStub(scope.prefix, change)))
    }
    return sections.filter(Boolean).join('\n') + '\n'
  }

  /** The same comparison as `diff`, as a list of files. */
  async changes(target: ShadowTarget, shas: ShadowShas): Promise<FileChange[]> {
    const deadline = Date.now() + SHADOW_TIMEOUT_MS
    const changes: FileChange[] = []
    for (const scope of shadowScopes(target.setup, target.projectPath)) {
      const sha = shas[scope.id]
      if (!sha) continue
      const ctx = this.context(target, scope, deadline)
      const state = await inspect(ctx, this.maxFiles)
      const listed = await withWorkIndex(ctx, state, (env) => gitOk(ctx, ['diff', '--cached', '-M', '--name-status', '-z', sha], undefined, env))
      for (const { path, code } of parseNameStatus(listed)) changes.push({ path: scope.prefix + path, kind: kindOf(code), staged: false, unstaged: true })
      for (const { path, kind } of await bigChanges(ctx, state)) changes.push({ path: scope.prefix + path, kind, staged: false, unstaged: true })
    }
    return changes
  }

  /** Deletes a finished run's private dirs. */
  async remove(runId: string): Promise<void> {
    await rm(join(this.root, runId), { recursive: true, force: true, maxRetries: 3 })
  }

  /** Deletes the dirs of every run but `keep` (at app start: runs that no longer exist, a removal that failed or never ran). */
  async removeLeftovers(keep: string[]): Promise<void> {
    let names: string[]
    try { names = readdirSync(this.root) } catch { return }
    await Promise.all(names.filter((name) => !keep.includes(name)).map((name) => this.remove(name).catch(() => {})))
  }
}
