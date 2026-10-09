import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { checkCommitCoverage, commitIndex, git, headSha, parsePorcelain, stagedDiff, status, workingDiff } from './git'

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
})
