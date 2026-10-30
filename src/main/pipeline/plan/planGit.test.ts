import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { commitIndex, commitsSince, git, headSha, stagedDiff, stagePaths, status, workingDiff } from '../git'
import { withPlanTrailer } from '../engine/runner'

/** Plan files on a real repository: not part of a run's work, and they go in with the task's commit. */
describe('plan files in git', () => {
  let repo = ''
  const write = (path: string, text: string): void => writeFileSync(join(repo, path), text, 'utf8')

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'aide-plan-git-'))
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'user.name', 'Test'])
    mkdirSync(join(repo, 'aide', 'plans'), { recursive: true })
    write('src.txt', 'one\n')
    write('aide/plans/p.json', '{"v":1}\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-q', '-m', 'start'])
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('leaves plan files out of the status and the diffs, tracked or new', async () => {
    write('aide/plans/p.json', '{"v":2}\n')
    write('aide/plans/new.json', '{"new":true}\n')
    write('src.txt', 'two\n')
    expect((await status(repo)).map((c) => c.path)).toEqual(['src.txt'])
    const diff = await workingDiff(repo)
    expect(diff).toContain('src.txt')
    expect(diff).not.toContain('aide/plans')
  })

  it('also with a moved file, when the diff detects renames', async () => {
    rmSync(join(repo, 'src.txt'))
    write('moved.txt', 'two\n')
    const diff = await workingDiff(repo)
    expect(diff).toContain('moved.txt')
    expect(diff).not.toContain('aide/plans')
    rmSync(join(repo, 'moved.txt'))
    write('src.txt', 'two\n')
  })

  it('a staged plan file goes into the commit but not into what a commit reviewer reads', async () => {
    await git(repo, ['add', 'src.txt'])
    await stagePaths(repo, ['aide/plans/p.json'])
    expect(await stagedDiff(repo)).not.toContain('aide/plans')
    const before = (await headSha(repo))!
    const commit = await commitIndex(repo, withPlanTrailer('Do it\n\nBody.', { plan: 'p', task: 'one' }))
    expect(commit.files.sort()).toEqual(['aide/plans/p.json', 'src.txt'])
    const log = await git(repo, ['log', '-1', '--format=%(trailers:key=Plan-Task,valueonly)'])
    expect(log.stdout.trim()).toBe('p/one')
    expect(await commitsSince(repo, before)).toEqual([expect.stringMatching(/ Do it$/)])
    expect(await commitsSince(repo, 'no-such-commit')).toEqual([])
  })
})

describe('withPlanTrailer', () => {
  const link = { plan: 'p', task: 't' }

  it('adds a paragraph after a body, joins a trailer block, and never takes a subject for trailers', () => {
    expect(withPlanTrailer('Subject\n\nBody text.', link)).toBe('Subject\n\nBody text.\n\nPlan-Task: p/t\n')
    expect(withPlanTrailer('Subject\n\nBody.\n\nCo-Authored-By: A <a@b>\n', link)).toBe('Subject\n\nBody.\n\nCo-Authored-By: A <a@b>\nPlan-Task: p/t\n')
    expect(withPlanTrailer('Fix: the thing', link)).toBe('Fix: the thing\n\nPlan-Task: p/t\n')
  })
})
