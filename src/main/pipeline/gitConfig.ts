import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { readSharedConfig } from '../config/projectConfig'
import { git } from './git'

/**
 * Which git repositories a pipeline run works with (docs/pipeline-git-modes-spec.md §1).
 * Resolved once at run start from the `git` key of `aide/config.json` and stored
 * in `RunState.git`, so a config edit does not change a running run.
 */

export interface Repo {
  /** Letters, digits, `_`, `-`; `root` for the repo of a project without git config. */
  id: string
  /** Project-relative, forward slashes; `.` for the project root. */
  path: string
  /** Absolute path git runs in. */
  abs: string
}

export type GitSetup =
  /** Root mode (no config, the root is in a work tree) and repos mode (`git.repos`). */
  | { mode: 'git'; repos: Repo[]; commits: boolean }
  /** No-git mode: `git: false`, or no config and the root is not in a work tree. */
  | { mode: 'none' }

/** The git config is invalid; `problems` lists every problem found. */
export class GitConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`The "git" setting in aide/config.json is invalid:\n- ${problems.join('\n- ')}`)
    this.name = 'GitConfigError'
  }
}

/** Today's behaviour: one repo with id `root` at the project root. Also the setup of runs stored before `RunState.git` existed. */
export function rootSetup(projectPath: string): GitSetup {
  return { mode: 'git', repos: [{ id: 'root', path: '.', abs: projectPath }], commits: true }
}

const REPO_ID = /^[A-Za-z0-9_-]+$/
const KNOWN_KEYS = ['repos', 'commits', 'shadowExclude']

/** Resolve the git setup of a project; throws `GitConfigError` with every problem of an invalid config. */
export async function resolveGitSetup(projectPath: string, config: unknown = readSharedConfig(projectPath).git): Promise<GitSetup> {
  if (config === undefined) return (await insideWorkTree(projectPath)) ? rootSetup(projectPath) : { mode: 'none' }
  if (config === false) return { mode: 'none' }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new GitConfigError(['"git" must be false or an object.'])

  const { repos, commits, shadowExclude, ...rest } = config as Record<string, unknown>
  const problems: string[] = []
  for (const key of Object.keys(rest)) problems.push(`"git.${key}" is not a known setting (${KNOWN_KEYS.join(', ')}).`)
  if (commits !== undefined && typeof commits !== 'boolean') problems.push('"git.commits" must be true or false.')
  if (shadowExclude !== undefined && (!Array.isArray(shadowExclude) || shadowExclude.some((p) => typeof p !== 'string'))) problems.push('"git.shadowExclude" must be a list of strings.')

  let list: Repo[] | null = null
  if (repos === undefined) {
    list = (await insideWorkTree(projectPath)) ? [{ id: 'root', path: '.', abs: projectPath }] : null
  } else if (repos === null || typeof repos !== 'object' || Array.isArray(repos)) {
    problems.push('"git.repos" must be an object mapping repo ids to project-relative paths.')
  } else if (Object.keys(repos).length === 0) {
    problems.push('"git.repos" is empty; list at least one repo, or remove it.')
  } else {
    list = []
    const seen = new Map<string, string>()
    for (const [id, value] of Object.entries(repos as Record<string, unknown>)) {
      if (!REPO_ID.test(id)) problems.push(`Repo id "${id}" may only contain letters, digits, "_" and "-".`)
      const path = typeof value === 'string' ? normalizeRepoPath(value) : null
      if (path === null) { problems.push(`git.repos.${id}: the path must be a project-relative path inside the project (got ${JSON.stringify(value)}).`); continue }
      const other = seen.get(path)
      if (other) { problems.push(`git.repos.${id}: "${path}" is already the path of repo "${other}".`); continue }
      seen.set(path, id)
      const abs = path === '.' ? projectPath : resolve(projectPath, path)
      const problem = await repoProblem(projectPath, path, abs)
      if (problem) problems.push(`git.repos.${id}: ${problem}`)
      list.push({ id, path, abs })
    }
  }
  if (problems.length) throw new GitConfigError(problems)
  if (!list) return { mode: 'none' }
  return { mode: 'git', repos: list, commits: commits !== false }
}

/** Repos of a stored setup that are gone or no longer a work-tree top level (checked when a run resumes). */
export async function checkRepos(setup: GitSetup, projectPath: string): Promise<string[]> {
  if (setup.mode !== 'git') return []
  // The root repo of a project without git config may be a subfolder of its repo: it only has to stay in a work tree.
  if (setup.repos.length === 1 && setup.repos[0].id === 'root' && setup.repos[0].path === '.') {
    return (await insideWorkTree(setup.repos[0].abs)) ? [] : ['The project root is no longer inside a git work tree.']
  }
  const problems: string[] = []
  for (const repo of setup.repos) {
    const problem = await repoProblem(projectPath, repo.path, repo.abs)
    if (problem) problems.push(`Repo "${repo.id}": ${problem}`)
  }
  return problems
}

/** One line for pipeline_validate: `git: repos web=frontend, api=services/api; commits on`. */
export function describeGitSetup(setup: GitSetup): string {
  if (setup.mode === 'none') return 'git: none (the project is not a git repository, or git is off)'
  const commits = setup.commits ? 'commits on' : 'commits off'
  const [first] = setup.repos
  if (setup.repos.length === 1 && first.id === 'root' && first.path === '.') return `git: root repo; ${commits}`
  return `git: repos ${setup.repos.map((r) => `${r.id}=${r.path}`).join(', ')}; ${commits}`
}

/** `frontend\\`, `./frontend/` → `frontend`; `''`, `./` → `.`; absolute or escaping paths → null. */
export function normalizeRepoPath(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/')
  if (isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) return null
  const parts = trimmed.split('/').filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return parts.length ? parts.join('/') : '.'
}

async function insideWorkTree(dir: string): Promise<boolean> {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']).catch(() => null)
  return result?.code === 0 && result.stdout.trim() === 'true'
}

/** Why `abs` is not the top level of a git work tree, or null. */
async function repoProblem(projectPath: string, path: string, abs: string): Promise<string | null> {
  if (!existsSync(abs)) return `"${path}" does not exist.`
  try { if (!statSync(abs).isDirectory()) return `"${path}" is not a folder.` } catch { return `"${path}" cannot be read.` }
  const result = await git(abs, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) return `"${path}" is not a git work tree.`
  const top = result.stdout.trim()
  if (comparable(top) === comparable(abs)) return null
  const rel = relative(real(projectPath), real(top)).replace(/\\/g, '/')
  const where = rel === '' ? 'the project root' : rel.startsWith('..') || isAbsolute(rel) ? `"${top}"` : `"${rel}"`
  return `"${path}" is inside the repository at ${where}, not its top level; list the top level of the repository.`
}

/** A path in a form two spellings of the same folder agree on (git prints long names with forward slashes). */
function comparable(p: string): string {
  const full = real(p)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function real(p: string): string {
  try { return realpathSync.native(resolve(p)) } catch { return resolve(p) }
}
