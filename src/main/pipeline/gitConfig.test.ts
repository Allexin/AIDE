import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { git } from './git'
import { GitConfigError, checkRepos, describeGitSetup, normalizeRepoPath, resolveGitSetup, rootSetup } from './gitConfig'

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

describe('describeGitSetup', () => {
  it('names the mode in one line', () => {
    expect(describeGitSetup(rootSetup('/p'))).toBe('git: root repo; commits on')
    expect(describeGitSetup({ mode: 'git', repos: [{ id: 'web', path: 'frontend', abs: '' }, { id: 'api', path: 'services/api', abs: '' }], commits: false })).toBe('git: repos web=frontend, api=services/api; commits off')
    expect(describeGitSetup({ mode: 'none' })).toMatch(/^git: none/)
  })
})
