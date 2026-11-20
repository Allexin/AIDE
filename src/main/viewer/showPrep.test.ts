import { describe, expect, it } from 'vitest'
import { countChanges, prepareShow } from './showPrep'
import { parseShowArgs } from '../pipeline/mcp/viewTools'

const book = (ch2: string): string => `# Book\n\n## Chapter 1\none\n\n## Chapter 2\n${ch2}\n\n## Chapter 3\nthree`

describe('prepareShow', () => {
  it('has no base on the first show', () => {
    const p = prepareShow('markdown', book('two'), null, null)
    expect(p.base).toBeNull()
    expect(countChanges('markdown', p)).toBe(0)
  })

  it('cuts the range from both versions with their own line offsets', () => {
    const before = book('two')
    const after = 'Intro line\n\n' + book('two, longer')
    const p = prepareShow('markdown', after, before, { from: '## Chapter 2', to: '## Chapter 3' })
    expect(p.shownStartLine).toBe(8)
    expect(p.baseStartLine).toBe(6)
    expect(p.shown).toBe('## Chapter 2\ntwo, longer\n')
    expect(countChanges('markdown', p)).toBe(1)
  })

  it('drops a base whose range markers are gone, with a note', () => {
    const p = prepareShow('markdown', book('two'), '# Other text', { from: '## Chapter 2', to: '## Chapter 3' })
    expect(p.base).toBeNull()
    expect(p.note).toMatch(/previous version/)
  })

  it('refuses a range that is not in the file', () => {
    expect(() => prepareShow('markdown', book('two'), null, { from: '## Chapter 9' })).toThrow(/not in the file/)
  })

  it('counts an image change as one', () => {
    expect(countChanges('image', prepareShow('image', 'data:b', 'data:a', null))).toBe(1)
    expect(countChanges('image', prepareShow('image', 'data:a', 'data:a', null))).toBe(0)
  })
})

describe('parseShowArgs', () => {
  it('reads path, base, range and anchor', () => {
    expect(parseShowArgs({ path: 'docs/x.md', base: 'head', range: { from: '## A', to: 40 }, anchor: 12 }))
      .toEqual({ path: 'docs/x.md', base: 'head', range: { from: '## A', to: 40 }, anchor: 12 })
  })

  it('refuses bad arguments with readable text', () => {
    expect(() => parseShowArgs({})).toThrow(/path/)
    expect(() => parseShowArgs({ path: 'a', base: 'last' })).toThrow(/base/)
    expect(() => parseShowArgs({ path: 'a', range: { from: 0 } })).toThrow(/range.from/)
  })
})
