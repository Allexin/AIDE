import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { git } from './git'
import type { GitSetup } from './gitConfig'
import { ShadowStore, shadowScopes, unavailableDiff, type ShadowTarget } from './shadow'

const root = mkdtempSync(join(tmpdir(), 'aide-shadow-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
/** A project folder with files, and a shadow store outside it. */
function project(files: Record<string, string>): { dir: string; store: ShadowStore; shadowRoot: string } {
  const dir = join(root, `p${++counter}`)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  mkdirSync(dir, { recursive: true })
  const shadowRoot = join(dir, '.aide', 'users', 'u', 'shadow')
  return { dir, store: new ShadowStore(shadowRoot), shadowRoot }
}

const noGit = (dir: string, runId = 'run-1', shadowExclude?: string[]): ShadowTarget => ({ runId, projectPath: dir, setup: { mode: 'none', ...(shadowExclude ? { shadowExclude } : {}) } })

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'init'])
}

const paths = (diff: string): string[] => [...diff.matchAll(/^diff --git a\/(\S+) /gm)].map((m) => m[1])

describe('ShadowStore', () => {
  it('a baseline keeps earlier changes out; a checkpoint keeps the work before it out', async () => {
    const { dir, store } = project({ 'a.txt': 'one\n', 'b.txt': 'b\n' })
    const target = noGit(dir)
    const base = await store.snapshot(target, 'baseline')
    expect(Object.keys(base)).toEqual(['project'])
    expect(await store.diff(target, base)).toBe('\n')

    writeFileSync(join(dir, 'a.txt'), 'two\n')
    writeFileSync(join(dir, 'c.txt'), 'new\n')
    const first = await store.diff(target, base)
    expect(paths(first)).toEqual(['a.txt', 'c.txt'])
    expect(first).toContain('-one\n+two')
    expect(await store.changes(target, base)).toEqual([
      { path: 'a.txt', kind: 'modified', staged: false, unstaged: true },
      { path: 'c.txt', kind: 'added', staged: false, unstaged: true }
    ])

    const checkpoint = await store.snapshot(target, 'checkpoint commit')
    rmSync(join(dir, 'b.txt'))
    const second = await store.diff(target, checkpoint)
    expect(paths(second)).toEqual(['b.txt'])
    expect(second).toContain('deleted file mode')
  })

  it('leaves out .aide, the plan files, the default list and git.shadowExclude', async () => {
    const { dir, store } = project({ 'src/a.ts': 'a\n' })
    const target = noGit(dir, 'run-1', ['assets/raw/'])
    const base = await store.snapshot(target, 'baseline')
    for (const path of ['.aide/x.json', 'aide/plans/p.json', 'node_modules/m/index.js', 'build/out.js', 'debug.log', 'assets/raw/big.psd', 'aide/config.json', 'src/b.ts']) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), 'x\n')
    }
    expect(paths(await store.diff(target, base))).toEqual(['aide/config.json', 'src/b.ts'])
  })

  it('shows a big file as a stub, compared by size with the checkpoint', async () => {
    const { dir, store } = project({ 'a.txt': 'a\n', 'big.bin': 'x'.repeat(300 * 1024) })
    const target = noGit(dir)
    const base = await store.snapshot(target, 'baseline')
    expect(await store.diff(target, base)).toBe('\n')
    writeFileSync(join(dir, 'new.bin'), 'y'.repeat(400 * 1024))
    writeFileSync(join(dir, 'big.bin'), 'x'.repeat(310 * 1024))
    const diff = await store.diff(target, base)
    expect(diff).toContain(`diff --git a/new.bin b/new.bin\nnew file mode 100644\n(new file, ${400 * 1024} bytes — content omitted)`)
    expect(diff).toContain(`diff --git a/big.bin b/big.bin\n(changed file, ${300 * 1024} → ${310 * 1024} bytes — content omitted)`)
    expect(diff).not.toContain('yyyy')
    rmSync(join(dir, 'big.bin'))
    expect(await store.diff(target, base)).toContain('(deleted file, 307200 bytes — content omitted)')
  })

  it('detects a moved file as a rename', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const { dir, store } = project({ 'old/name.ts': text })
    const target = noGit(dir)
    const base = await store.snapshot(target, 'baseline')
    mkdirSync(join(dir, 'new'))
    renameSync(join(dir, 'old', 'name.ts'), join(dir, 'new', 'name.ts'))
    const diff = await store.diff(target, base)
    expect(diff).toContain('rename from old/name.ts\nrename to new/name.ts')
    expect(await store.changes(target, base)).toEqual([{ path: 'new/name.ts', kind: 'renamed', staged: false, unstaged: true }])
  })

  it('refuses a project over the file-count limit', async () => {
    const { dir, shadowRoot } = project({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' })
    const store = new ShadowStore(shadowRoot, 2)
    await expect(store.snapshot(noGit(dir), 'baseline')).rejects.toThrow('the project has more than 2 files to snapshot')
  })

  it('without a git binary names that as the reason', async () => {
    const { dir, store } = project({ 'a.txt': '1' })
    const path = process.env.PATH
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const saved = process.env[pathKey]
    process.env[pathKey] = join(root, 'nowhere')
    try {
      await expect(store.snapshot(noGit(dir), 'baseline')).rejects.toThrow('git is not installed')
    } finally {
      process.env[pathKey] = saved
      if (pathKey !== 'PATH' && path !== undefined) process.env.PATH = path
    }
    expect(unavailableDiff('git is not installed')).toBe('(diff unavailable: git is not installed; read the files the implementer reports)\n')
  })

  it('in a real repo with commits off, never touches its .git, index or files; prefixes a repo in a subfolder', async () => {
    const { dir, store } = project({ 'frontend/src/a.ts': 'a\n', 'notes.txt': 'n\n' })
    const repo = join(dir, 'frontend')
    await initRepo(repo)
    writeFileSync(join(repo, 'src', 'a.ts'), 'changed before the run\n')
    const statusBefore = (await git(repo, ['status', '--porcelain'])).stdout
    const indexBefore = readFileSync(join(repo, '.git', 'index'))
    const setup: GitSetup = { mode: 'git', repos: [{ id: 'web', path: 'frontend', abs: repo }], commits: false }
    const target: ShadowTarget = { runId: 'run-9', projectPath: dir, setup }
    expect(shadowScopes(setup, dir).map((s) => s.id)).toEqual(['web', 'project'])

    const base = await store.snapshot(target, 'baseline')
    writeFileSync(join(repo, 'src', 'b.ts'), 'b\n')
    writeFileSync(join(dir, 'notes.txt'), 'm\n')
    const diff = await store.diff(target, base)
    expect(paths(diff)).toEqual(['frontend/src/b.ts', 'notes.txt'])

    expect((await git(repo, ['status', '--porcelain'])).stdout).toBe(statusBefore + '?? src/b.ts\n')
    expect(readFileSync(join(repo, '.git', 'index'))).toEqual(indexBefore)
    expect((await git(repo, ['log', '--format=%s'])).stdout.trim()).toBe('init')
    expect(readFileSync(join(repo, 'src', 'a.ts'), 'utf8')).toBe('changed before the run\n')
  })

  it('skips a repository embedded in a no-git project instead of recording it', async () => {
    const { dir, store } = project({ 'lib/x.ts': 'x\n', 'a.txt': 'a\n' })
    await initRepo(join(dir, 'lib'))
    const target = noGit(dir)
    const base = await store.snapshot(target, 'baseline')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    expect(paths(await store.diff(target, base))).toEqual(['b.txt'])
  })

  it('removes a run\'s dirs, and the leftovers of other runs', async () => {
    const { dir, store, shadowRoot } = project({ 'a.txt': 'a\n' })
    await store.snapshot(noGit(dir, 'run-a'), 'baseline')
    await store.snapshot(noGit(dir, 'run-b'), 'baseline')
    await store.snapshot(noGit(dir, 'run-c'), 'baseline')
    expect(statSync(join(shadowRoot, 'run-a', 'project.git')).isDirectory()).toBe(true)
    await store.remove('run-a')
    expect(existsSync(join(shadowRoot, 'run-a'))).toBe(false)
    await store.removeLeftovers(['run-c'])
    expect(existsSync(join(shadowRoot, 'run-b'))).toBe(false)
    expect(existsSync(join(shadowRoot, 'run-c'))).toBe(true)
  })
})
