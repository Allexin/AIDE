import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { git } from './git'
import { GitConfigError, checkRepos, describeGitSetup, normalizeRepoPath, resolveCommitRepos, resolveGitSetup, rootSetup, type GitSetup } from './gitConfig'
import type { Step } from '../../shared/pipelineMachine'

const base = mkdtempSync(join(tmpdir(), 'aide-gitconfig-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await git(dir, ['init', '-q'])
}

async function problems(projectPath: string, config: unknown): Promise<string[]> {
  try {
    await resolveGitSetup(projectPath, config)
  } catch (err) {
    if (err instanceof GitConfigError) return err.problems
    throw err
  }
  throw new Error('expected a GitConfigError')
}

/** A folder that is not a repo, holding repos `frontend` and `backend`, a plain folder and a file. */
const project = join(base, 'project')
/** A project whose root is a repo. */
const repoRoot = join(base, 'repo')

beforeAll(async () => {
  await initRepo(join(project, 'frontend'))
  await initRepo(join(project, 'backend'))
  mkdirSync(join(project, 'frontend', 'src'), { recursive: true })
  mkdirSync(join(project, 'plain'), { recursive: true })
  writeFileSync(join(project, 'notes.txt'), 'x')
  await initRepo(repoRoot)
})

describe('resolveGitSetup', () => {
  it('without config: root mode when the root is in a work tree, no-git mode otherwise', async () => {
    expect(await resolveGitSetup(repoRoot, undefined)).toEqual(rootSetup(repoRoot))
    expect(await resolveGitSetup(project, undefined)).toEqual({ mode: 'none' })
  })

  it('git: false is no-git mode, even in a repo', async () => {
    expect(await resolveGitSetup(repoRoot, false)).toEqual({ mode: 'none' })
  })

  it('reads repos in config order, with project-relative paths and commits', async () => {
    expect(await resolveGitSetup(project, { repos: { web: 'frontend', api: './backend/' }, commits: false })).toEqual({
      mode: 'git',
      repos: [{ id: 'web', path: 'frontend', abs: join(project, 'frontend') }, { id: 'api', path: 'backend', abs: join(project, 'backend') }],
      commits: false
    })
  })

  it('without repos, an object config keeps the root repo (or no git) and sets commits', async () => {
    expect(await resolveGitSetup(repoRoot, { commits: false })).toEqual({ ...rootSetup(repoRoot), commits: false })
    expect(await resolveGitSetup(project, { commits: false })).toEqual({ mode: 'none' })
  })

  it('reports every problem: bad id, missing path, a path inside a repo, not a work tree, escaping paths', async () => {
    const found = await problems(project, { repos: { 'web app': 'frontend', api: 'missing', src: 'frontend/src', plain: 'plain', up: '../elsewhere', file: 'notes.txt' } })
    expect(found).toEqual([
      'Repo id "web app" may only contain letters, digits, "_" and "-".',
      'git.repos.api: "missing" does not exist.',
      'git.repos.src: "frontend/src" is inside the repository at "frontend", not its top level; list the top level of the repository.',
      'git.repos.plain: "plain" is not a git work tree.',
      'git.repos.up: the path must be a project-relative path inside the project (got "../elsewhere").',
      'git.repos.file: "notes.txt" is not a folder.'
    ])
  })

  it('rejects malformed settings', async () => {
    expect(await problems(project, 'yes')).toEqual(['"git" must be false or an object.'])
    expect(await problems(project, { repos: [] })).toEqual(['"git.repos" must be an object mapping repo ids to project-relative paths.'])
    expect(await problems(project, { repos: {} })).toEqual(['"git.repos" is empty; list at least one repo, or remove it.'])
    expect(await problems(repoRoot, { commits: 'no', shadowExclude: [1], extra: true })).toEqual([
      '"git.extra" is not a known setting (repos, commits, shadowExclude).',
      '"git.commits" must be true or false.',
      '"git.shadowExclude" must be a list of strings.'
    ])
    expect(await problems(project, { repos: { a: 'frontend', b: 'frontend/' } })).toEqual(['git.repos.b: "frontend" is already the path of repo "a".'])
  })

  it('the error message lists the problems', async () => {
    await expect(resolveGitSetup(project, { repos: { api: 'missing' } })).rejects.toThrow('The "git" setting in aide/config.json is invalid:\n- git.repos.api: "missing" does not exist.')
  })

  it('reads the git key of aide/config.json by default', async () => {
    const dir = join(base, 'configured')
    await initRepo(join(dir, 'web'))
    mkdirSync(join(dir, 'aide'), { recursive: true })
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: { repos: { web: 'web' } } }))
    expect(await resolveGitSetup(dir)).toMatchObject({ mode: 'git', repos: [{ id: 'web', path: 'web' }] })
  })
})

describe('normalizeRepoPath', () => {
  it('normalizes separators and dots, and refuses paths outside the project', () => {
    expect(normalizeRepoPath('frontend\\app\\')).toBe('frontend/app')
    expect(normalizeRepoPath('./')).toBe('.')
    expect(normalizeRepoPath('')).toBe('.')
    expect(normalizeRepoPath('C:\\repo')).toBeNull()
    expect(normalizeRepoPath('/repo')).toBeNull()
    expect(normalizeRepoPath('a/../../b')).toBeNull()
  })
})

describe('checkRepos', () => {
  it('reports repos that are gone or no longer a top level', async () => {
    const dir = join(base, 'resume')
    await initRepo(join(dir, 'web'))
    await initRepo(join(dir, 'api'))
    const setup = await resolveGitSetup(dir, { repos: { web: 'web', api: 'api' } })
    expect(await checkRepos(setup, dir)).toEqual([])
    rmSync(join(dir, 'api'), { recursive: true, force: true })
    expect(await checkRepos(setup, dir)).toEqual(['Repo "api": "api" does not exist.'])
  })

  it('the root repo only has to stay in a work tree; no-git has nothing to check', async () => {
    expect(await checkRepos(rootSetup(repoRoot), repoRoot)).toEqual([])
    expect(await checkRepos(rootSetup(project), project)).toEqual(['The project root is no longer inside a git work tree.'])
    expect(await checkRepos({ mode: 'none' }, project)).toEqual([])
  })
})

describe('resolveCommitRepos', () => {
  const two: GitSetup = { mode: 'git', repos: [{ id: 'web', path: 'frontend', abs: '' }, { id: 'api', path: 'backend', abs: '' }], commits: true }
  const commit = (id: string, repo?: string): Step => ({ type: 'commit', id, review: 'algorithmic', ...(repo === undefined ? {} : { repo }), prep: { type: 'agent', id: `${id}Prep`, summary: 's', role: 'r', output: 'commitPrep' } })

  it('a step without repo commits in the only repo', () => {
    expect(resolveCommitRepos([commit('c')], {}, rootSetup('/p'))).toEqual({ repos: { c: 'root' }, problems: [] })
  })

  it('with several repos a step without repo is a problem naming the step and the ids', () => {
    expect(resolveCommitRepos([commit('commit')], {}, two)).toEqual({ repos: {}, problems: ['Commit step "commit" must name its repo ("repo": one of web, api).'] })
  })

  it('a literal or a template names a repo; steps inside blocks count', () => {
    const steps: Step[] = [commit('a', 'web'), { type: 'loop', id: 'l', maxIterations: 2, steps: [commit('b', '{{params.repo}}')] }]
    expect(resolveCommitRepos(steps, { repo: 'api' }, two)).toEqual({ repos: { a: 'web', b: 'api' }, problems: [] })
  })

  it('an unknown id is a problem, in a single-repo project too', () => {
    expect(resolveCommitRepos([commit('c', '{{params.repo}}')], { repo: 'nope' }, two).problems).toEqual(['Commit step "c": "nope" is not a repo of this project (web, api).'])
    expect(resolveCommitRepos([commit('c', 'web')], {}, rootSetup('/p')).problems).toEqual(['Commit step "c": "web" is not a repo of this project (root).'])
  })

  it('a template that renders empty counts as absent', () => {
    expect(resolveCommitRepos([commit('c', '{{params.repo}}')], {}, rootSetup('/p'))).toEqual({ repos: { c: 'root' }, problems: [] })
    expect(resolveCommitRepos([commit('c', '{{params.repo}}')], {}, two).problems).toEqual(['Commit step "c" must name its repo ("repo": one of web, api).'])
  })

  it('repo is ignored when commit steps do not commit', () => {
    expect(resolveCommitRepos([commit('c', 'whatever')], {}, { mode: 'none' })).toEqual({ repos: {}, problems: [] })
    expect(resolveCommitRepos([commit('c')], {}, { ...two, commits: false } as GitSetup)).toEqual({ repos: {}, problems: [] })
  })
})

describe('describeGitSetup', () => {
  it('names the mode in one line', () => {
    expect(describeGitSetup(rootSetup('/p'))).toBe('git: root repo; commits on')
    expect(describeGitSetup({ mode: 'git', repos: [{ id: 'web', path: 'frontend', abs: '' }, { id: 'api', path: 'services/api', abs: '' }], commits: false })).toBe('git: repos web=frontend, api=services/api; commits off')
    expect(describeGitSetup({ mode: 'none' })).toMatch(/^git: none/)
  })
})
