import { describe, expect, it } from 'vitest'
import { globToRegExp, renderInputs, splitDiff } from './inputs'

describe('globToRegExp', () => {
  const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path)
  it('keeps * within a segment and lets ** cross segments', () => {
    expect(matches('Source/Scenarios/**/*.txt', 'Source/Scenarios/a/b/c.txt')).toBe(true)
    expect(matches('Source/Scenarios/**/*.txt', 'Source/Scenarios/c.txt')).toBe(true)
    expect(matches('Source/*.txt', 'Source/a/c.txt')).toBe(false)
    expect(matches('Source/Scenarios/**/*.txt', 'Other/Scenarios/c.txt')).toBe(false)
  })
  it('matches a pattern without a slash against the file name at any depth', () => {
    expect(matches('*.snap', 'a/b/c.snap')).toBe(true)
    expect(matches('*.snap', 'c.snap')).toBe(true)
    expect(matches('*.snap', 'c.snapx')).toBe(false)
  })
  it('supports alternation and directory patterns', () => {
    expect(matches('src/**/*.{ts,tsx}', 'src/x/y.tsx')).toBe(true)
    expect(matches('src/**/*.{ts,tsx}', 'src/x/y.js')).toBe(false)
    expect(matches('golden/', 'golden/deep/file.txt')).toBe(true)
  })
})

describe('splitDiff', () => {
  it('names each section by its new path, the old one for deletions, and counts lines', () => {
    const diff = [
      'diff --git a/a b.ts b/a b.ts', '--- a/a b.ts', '+++ b/a b.ts', '@@ -1 +1 @@', '-old', '+new', '+more',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '-x',
      'diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts',
      'diff --git a/img.png b/img.png', 'Binary files differ'
    ].join('\n')
    expect(splitDiff(diff).map((s) => [s.path, s.added, s.removed])).toEqual([['a b.ts', 2, 1], ['gone.ts', 0, 1], ['new.ts', 0, 0], ['img.png', 0, 0]])
  })
})

describe('renderInputs', () => {
  const scope = { params: { spec: 'Do X' }, outputs: {}, run: { changedFiles: ['src/a.ts (modified)', 'golden/b.txt (untracked)'] } }
  it('filters run.changedFiles and leaves other refs as they are', () => {
    const [files, spec] = renderInputs([{ ref: 'run.changedFiles', include: ['src/**'] }, 'params.spec'], scope, () => 'unused')
    expect(files).toBe('## run.changedFiles\n\nFiltered by the machine (include src/**): 1 of 2 files.\n\n- src/a.ts (modified)')
    expect(spec).toBe('## params.spec\n\nDo X')
  })
  it('saves a large value without files and shows its beginning', () => {
    const saved: string[] = []
    const [section] = renderInputs(['params.spec'], { ...scope, params: { spec: 'y'.repeat(100_001) } }, (name) => { saved.push(name); return `/runs/${name}.txt` })
    expect(saved).toEqual(['params.spec'])
    expect(section).toContain('saved it to `/runs/params.spec.txt`')
    expect(section).toContain('It begins:')
  })
})
