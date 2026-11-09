import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { NO_GIT_DIFF, checkCommitCoverage, commitIndex, git, headSha, parseNumstatPaths, parsePorcelain, stagedDiff, status, workingDiff, type FileChange } from './git'
import { resolveGitSetup, rootSetup, type GitSetup } from './gitConfig'
import { PLANS_DIR, isPlanPath } from './plan/planStore'
import { splitDiff } from './engine/inputs'

describe('parsePorcelain', () => {
  it('parses staged, unstaged, untracked and renamed entries', () => {
    const output = ['M  staged.ts', ' M unstaged.ts', 'MM both.ts', '?? new.ts', 'R  renamed.ts', 'old.ts', ' D gone.ts', ''].join('\0')
    expect(parsePorcelain(output)).toEqual([
      { path: 'staged.ts', kind: 'modified', staged: true, unstaged: false },
      { path: 'unstaged.ts', kind: 'modified', staged: false, unstaged: true },
      { path: 'both.ts', kind: 'modified', staged: true, unstaged: true },
      { path: 'new.ts', kind: 'untracked', staged: false, unstaged: true },
      { path: 'renamed.ts', kind: 'renamed', staged: true, unstaged: false },
      { path: 'gone.ts', kind: 'deleted', staged: false, unstaged: true }
    ])
  })
})

describe('parseNumstatPaths', () => {
  it('reads plain, binary and renamed entries', () => {
    expect(parseNumstatPaths(['1\t2\ta.ts', '-\t-\timg.png', '3\t0\t', 'old.ts', 'new.ts', ''].join('\0'))).toEqual(['a.ts', 'img.png', 'old.ts', 'new.ts'])
  })
})

describe('checkCommitCoverage', () => {
  const changes = parsePorcelain(['M  a.ts', '?? b.ts', 'MM c.ts', '?? build.log', ''].join('\0'))

  it('reports unstaged, partially staged and empty message', () => {
    const result = checkCommitCoverage(changes, '', [])
    expect(result.ok).toBe(false)
    expect(result.issues.join('\n')).toMatch(/message is empty/)
    expect(result.issues.join('\n')).toMatch(/b\.ts is untracked/)
    expect(result.issues.join('\n')).toMatch(/c\.ts is only partially staged/)
  })

  it('accepts when every change is staged or excluded', () => {
    const covered = parsePorcelain(['M  a.ts', 'A  b.ts', '?? build.log', ''].join('\0'))
    expect(checkCommitCoverage(covered, 'Add b', ['build.log'])).toMatchObject({ ok: true, staged: ['a.ts', 'b.ts'] })
  })

  it('flags an excluded file that is staged', () => {
    const result = checkCommitCoverage(parsePorcelain('A  b.ts\0'), 'msg', ['b.ts'])
    expect(result.issues.join('\n')).toMatch(/listed in "excluded" but is staged/)
  })

  it('requires something staged', () => {
    expect(checkCommitCoverage([], 'msg', []).issues).toEqual(['Nothing is staged.'])
  })
})

describe('git helpers on a real repository', () => {
  let repo = ''
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'aide-git-'))
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'user.name', 'Test'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    await git(repo, ['add', 'a.txt'])
    await git(repo, ['commit', '-q', '-m', 'init'])
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('includes untracked files in the working diff without touching the index', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'new.txt'), 'fresh\n')
    const diff = await workingDiff(repo)
    expect(diff).toContain('+two')
    expect(diff).toContain('new.txt')
    expect(diff).toContain('+fresh')
    expect((await status(repo)).every((c) => !c.staged)).toBe(true)
  })

  it('commits exactly the index', async () => {
    await git(repo, ['add', 'a.txt'])
    expect(await stagedDiff(repo)).toContain('+two')
    const before = await headSha(repo)
    const result = await commitIndex(repo, 'Add line two\n\nBody.')
    expect(result.sha).not.toBe(before)
    expect(result.files).toEqual(['a.txt'])
    const left = await status(repo)
    expect(left).toEqual([{ path: 'new.txt', kind: 'untracked', staged: false, unstaged: true }])
  })

  it('leaves out files whose only change is line endings', async () => {
    await git(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\n')
    expect((await git(repo, ['status', '--porcelain'])).stdout).toContain(' M a.txt')
    expect(await status(repo)).toEqual([{ path: 'new.txt', kind: 'untracked', staged: false, unstaged: true }])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  })

  it('shows a file moved without git mv as a rename, without touching the index', async () => {
    writeFileSync(join(repo, 'long.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n')
    await git(repo, ['add', 'long.txt'])
    await git(repo, ['commit', '-q', '-m', 'long'])
    renameSync(join(repo, 'long.txt'), join(repo, 'moved.txt'))
    const diff = await workingDiff(repo)
    expect(diff).toContain('rename from long.txt')
    expect(diff).toContain('rename to moved.txt')
    expect(diff).toContain('+fresh') // other untracked files are still there
    expect((await git(repo, ['diff', '--cached', '--name-only'])).stdout).toBe('')
  })
})

async function initRepo(dir: string, files: Record<string, string>): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await git(dir, ['init', '-q'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  await git(dir, ['config', 'core.autocrlf', 'false'])
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'init'])
}

/**
 * The single-cwd reads as they were before git modes (docs/pipeline-git-modes-spec.md),
 * kept verbatim: root mode must produce exactly their output.
 */
const before = {
  NOT_PLANS: ['--', '.', `:(exclude)${PLANS_DIR}`],
  async gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await git(cwd, args, undefined, env)
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout
  },
  async status(cwd: string): Promise<FileChange[]> {
    const changes = parsePorcelain(await before.gitOk(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).filter((c) => !isPlanPath(c.path))
    if (!changes.some((c) => c.kind === 'modified')) return changes
    const real = new Set<string>()
    for (const args of [['diff', '--numstat', '-z', '--ignore-cr-at-eol'], ['diff', '--cached', '--numstat', '-z', '--ignore-cr-at-eol']]) {
      const result = await git(cwd, args)
      if (result.code !== 0) return changes
      for (const path of parseNumstatPaths(result.stdout)) real.add(path)
    }
    return changes.filter((c) => c.kind !== 'modified' || real.has(c.path))
  },
  async workingDiff(cwd: string): Promise<string> {
    const hasHead = (await headSha(cwd)) !== null
    const untracked = (await before.gitOk(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter((path) => path && !isPlanPath(path))
    if (hasHead && untracked.length) {
      const deleted = (await before.gitOk(cwd, ['ls-files', '--deleted', '-z'])).split('\0').filter(Boolean)
      if (deleted.length) {
        const diff = await before.renameAwareDiff(cwd, untracked).catch(() => null)
        if (diff !== null) return diff
      }
    }
    const tracked = hasHead ? await before.gitOk(cwd, ['diff', 'HEAD', '--no-color', ...before.NOT_PLANS]) : await before.gitOk(cwd, ['diff', '--cached', '--no-color', ...before.NOT_PLANS])
    const sections = [tracked.trimEnd()]
    for (const path of untracked) sections.push(await before.untrackedDiff(cwd, path))
    return sections.filter(Boolean).join('\n') + '\n'
  },
  async renameAwareDiff(cwd: string, untracked: string[]): Promise<string> {
    const big = untracked.filter((path) => { try { return statSync(join(cwd, path)).size > 256 * 1024 } catch { return false } })
    const index = resolve(cwd, (await before.gitOk(cwd, ['rev-parse', '--git-path', 'index'])).trim())
    const temp = join(tmpdir(), `aide-index-before-${Math.random().toString(36).slice(2)}`)
    try {
      if (existsSync(index)) copyFileSync(index, temp)
      const env = { ...process.env, GIT_INDEX_FILE: temp }
      await before.gitOk(cwd, ['add', '-A', '--', '.', ...big.map((path) => `:(exclude)${path}`)], env)
      const diff = await before.gitOk(cwd, ['diff', '--cached', '-M', '--no-color', 'HEAD', ...before.NOT_PLANS], env)
      const sections = [diff.trimEnd(), ...big.map((path) => before.bigFileStub(cwd, path))]
      return sections.filter(Boolean).join('\n') + '\n'
    } finally {
      rmSync(temp, { force: true })
    }
  },
  bigFileStub(cwd: string, path: string): string {
    let bytes = 0
    try { bytes = statSync(join(cwd, path)).size } catch { return '' }
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n(new file, ${bytes} bytes — content omitted)`
  },
  async untrackedDiff(cwd: string, path: string): Promise<string> {
    let bytes = 0
    try { bytes = statSync(join(cwd, path)).size } catch { return '' }
    if (bytes > 256 * 1024) return before.bigFileStub(cwd, path)
    const result = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path])
    return result.stdout.trimEnd()
  },
  stagedDiff(cwd: string): Promise<string> {
    return before.gitOk(cwd, ['diff', '--cached', '--no-color', ...before.NOT_PLANS])
  }
}

/** `run.changedFiles` as the runner formats it. */
const changedFiles = (changes: FileChange[]): string[] => changes.map((c) => `${c.path} (${c.kind}${c.staged ? ', staged' : ''})`)

describe('reads over a run git setup', () => {
  const base = mkdtempSync(join(tmpdir(), 'aide-git-modes-'))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'

  async function expectSameAsBefore(repo: string, setup: GitSetup): Promise<void> {
    expect(await workingDiff(setup)).toBe(await before.workingDiff(repo))
    expect(await stagedDiff(setup)).toBe(await before.stagedDiff(repo))
    expect(changedFiles(await status(setup))).toEqual(changedFiles(await before.status(repo)))
  }

  it('root mode (no git config, the root is a repo) is byte-identical to the reads before git modes', async () => {
    const repo = join(base, 'root')
    await initRepo(repo, { 'a.txt': 'one\n', 'src/b.ts': 'export const b = 1\n', 'long.txt': long, 'crlf.txt': 'x\ny\n', [`${PLANS_DIR}/p.json`]: '{}\n' })
    const setup = await resolveGitSetup(repo, undefined)
    expect(setup).toEqual(rootSetup(repo))
    await expectSameAsBefore(repo, setup) // clean tree
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 2\n')
    await git(repo, ['add', 'src/b.ts'])
    writeFileSync(join(repo, 'crlf.txt'), 'x\r\ny\r\n')
    writeFileSync(join(repo, 'new.txt'), 'fresh\n')
    writeFileSync(join(repo, 'big.bin'), 'x'.repeat(300 * 1024))
    writeFileSync(join(repo, PLANS_DIR, 'p.json'), '{"changed":true}\n')
    writeFileSync(join(repo, PLANS_DIR, 'q.json'), '{}\n')
    const plain = await workingDiff(setup)
    expect(plain).toContain('+two')
    expect(plain).toContain('content omitted')
    expect(plain).not.toContain(PLANS_DIR)
    await expectSameAsBefore(repo, setup)
    // A file moved without git mv takes the rename-aware path.
    renameSync(join(repo, 'long.txt'), join(repo, 'moved.txt'))
    expect(await workingDiff(setup)).toContain('rename to moved.txt')
    await expectSameAsBefore(repo, setup)
    // A project opened in a subfolder of its repo is root mode too.
    const sub = join(repo, 'src')
    expect(await resolveGitSetup(sub, undefined)).toEqual(rootSetup(sub))
    await expectSameAsBefore(sub, rootSetup(sub))
    // Before the first commit.
    const fresh = join(base, 'fresh')
    mkdirSync(fresh)
    await git(fresh, ['init', '-q'])
    writeFileSync(join(fresh, 'x.txt'), 'x\n')
    await expectSameAsBefore(fresh, await resolveGitSetup(fresh, undefined))
  })

  it('with git.repos, reads cover every repo with project-relative paths, in config order', async () => {
    const project = join(base, 'two')
    await initRepo(join(project, 'frontend'), { 'src/a.ts': 'a\n', 'long.txt': long })
    await initRepo(join(project, 'backend'), { 'main.go': 'package main\n' })
    writeFileSync(join(project, 'README.md'), 'not in any repo\n')
    const setup = await resolveGitSetup(project, { repos: { web: 'frontend', api: 'backend' } })
    expect(setup).toMatchObject({ mode: 'git', repos: [{ id: 'web', path: 'frontend' }, { id: 'api', path: 'backend' }], commits: true })

    writeFileSync(join(project, 'frontend/src/a.ts'), 'a\nb\n')
    writeFileSync(join(project, 'frontend/new.ts'), 'fresh\n')
    writeFileSync(join(project, 'backend/main.go'), 'package main\n\nfunc main() {}\n')
    await git(join(project, 'backend'), ['add', 'main.go'])
    writeFileSync(join(project, 'backend/big.bin'), 'x'.repeat(300 * 1024))

    expect(changedFiles(await status(setup))).toEqual(['frontend/src/a.ts (modified)', 'frontend/new.ts (untracked)', 'backend/main.go (modified, staged)', 'backend/big.bin (untracked)'])
    const diff = await workingDiff(setup)
    expect(splitDiff(diff).map((s) => s.path)).toEqual(['frontend/src/a.ts', 'frontend/new.ts', 'backend/main.go', 'backend/big.bin'])
    expect(diff).toContain('diff --git a/frontend/src/a.ts b/frontend/src/a.ts\n')
    expect(diff).toContain('+++ b/frontend/new.ts\n')
    expect(diff).toContain('diff --git a/backend/big.bin b/backend/big.bin\nnew file mode 100644\n(new file, 307200 bytes — content omitted)')
    expect(diff).not.toContain('README')
    expect(splitDiff(await stagedDiff(setup)).map((s) => s.path)).toEqual(['backend/main.go'])

    // A rename in a subfolder repo names project-relative paths, so inputs split and filter it.
    renameSync(join(project, 'frontend/long.txt'), join(project, 'frontend/moved.txt'))
    const renamed = await workingDiff(setup)
    expect(renamed).toContain('rename from frontend/long.txt\nrename to frontend/moved.txt')
    expect(splitDiff(renamed).map((s) => s.path)).toContain('frontend/moved.txt')
    expect((await git(join(project, 'frontend'), ['diff', '--cached', '--name-only'])).stdout).toBe('')
  })

  it('a repo inside another repo of the setup is reported once, by the inner repo', async () => {
    const project = join(base, 'nested')
    await initRepo(project, { 'root.txt': 'r\n' })
    await initRepo(join(project, 'frontend'), { 'a.ts': 'a\n' })
    const setup = await resolveGitSetup(project, { repos: { main: '.', web: 'frontend' } })
    writeFileSync(join(project, 'root.txt'), 'r\n2\n')
    writeFileSync(join(project, 'frontend/a.ts'), 'a\n2\n')
    writeFileSync(join(project, 'frontend/b.ts'), 'b\n')
    expect(changedFiles(await status(setup))).toEqual(['root.txt (modified)', 'frontend/a.ts (modified)', 'frontend/b.ts (untracked)'])
    expect(splitDiff(await workingDiff(setup)).map((s) => s.path)).toEqual(['root.txt', 'frontend/a.ts', 'frontend/b.ts'])
  })

  it('with a repo id, status and the staged diff are that repo\'s; the outer repo still leaves the inner one out', async () => {
    const project = join(base, 'one-of-many')
    await initRepo(project, { 'root.txt': 'r\n' })
    await initRepo(join(project, 'frontend'), { 'a.ts': 'a\n' })
    const setup = await resolveGitSetup(project, { repos: { main: '.', web: 'frontend' } })
    writeFileSync(join(project, 'root.txt'), 'r\n2\n')
    await git(project, ['add', 'root.txt'])
    writeFileSync(join(project, 'frontend/a.ts'), 'a\n2\n')
    await git(join(project, 'frontend'), ['add', 'a.ts'])
    writeFileSync(join(project, 'frontend/b.ts'), 'b\n')
    expect(changedFiles(await status(setup, 'main'))).toEqual(['root.txt (modified, staged)'])
    expect(changedFiles(await status(setup, 'web'))).toEqual(['frontend/a.ts (modified, staged)', 'frontend/b.ts (untracked)'])
    expect(splitDiff(await stagedDiff(setup, 'main')).map((s) => s.path)).toEqual(['root.txt'])
    expect(splitDiff(await stagedDiff(setup, 'web')).map((s) => s.path)).toEqual(['frontend/a.ts'])
    expect(await status(setup, 'unknown')).toEqual([])
  })

  it('no-git mode reads give a note and no changes', async () => {
    const none: GitSetup = { mode: 'none' }
    expect(await workingDiff(none)).toBe(NO_GIT_DIFF)
    expect(await stagedDiff(none)).toBe('')
    expect(await status(none)).toEqual([])
  })
})
