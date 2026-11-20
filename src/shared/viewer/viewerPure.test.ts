import { describe, expect, it } from 'vitest'
import { sliceRange, describeRange } from './range'
import { diffLines } from './lineDiff'
import { composeMessage } from './compose'

describe('sliceRange', () => {
  const text = '# Book\n\n## Chapter 1\none\n\n## Chapter 2\ntwo\n\n## Chapter 3\nthree'

  it('returns the whole text without a range', () => {
    expect(sliceRange(text)).toMatchObject({ startLine: 1, endLine: 10 })
  })

  it('takes markers: from shown, to not shown', () => {
    const s = sliceRange(text, { from: '## Chapter 2', to: '## Chapter 3' })
    expect(s).toEqual({ text: '## Chapter 2\ntwo\n', startLine: 6, endLine: 8 })
  })

  it('takes line numbers inclusively', () => {
    expect(sliceRange(text, { from: 3, to: 4 })).toEqual({ text: '## Chapter 1\none', startLine: 3, endLine: 4 })
  })

  it('runs to the end without to', () => {
    expect(sliceRange(text, { from: '## Chapter 3' })).toMatchObject({ startLine: 9, endLine: 10 })
  })

  it('is null when a marker is missing', () => {
    expect(sliceRange(text, { from: '## Chapter 9' })).toBeNull()
    expect(sliceRange(text, { from: '## Chapter 1', to: 'nothing' })).toBeNull()
    expect(sliceRange(text, { from: 99 })).toBeNull()
  })

  it('looks for to after from', () => {
    expect(sliceRange('## A\nx\n## A end\n## B', { from: '## A', to: '## A' })).toMatchObject({ startLine: 1, endLine: 2 })
  })

  it('describes ranges', () => {
    expect(describeRange({ from: '## Chapter 2', to: '## Chapter 3' })).toBe('"## Chapter 2" – before "## Chapter 3"')
    expect(describeRange(undefined)).toBe('')
  })
})

describe('diffLines', () => {
  it('numbers lines from the offsets and counts stops', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd', 5, 5)
    expect(d.changes).toBe(2)
    expect(d.lines.map((l) => [l.status, l.baseLine, l.line])).toEqual([
      ['equal', 5, 5],
      ['removed', 6, null],
      ['added', null, 6],
      ['equal', 7, 7],
      ['added', null, 8]
    ])
  })
})

describe('composeMessage', () => {
  it('groups comments by file and appends the free text', () => {
    const at = new Date(2026, 10, 20, 14, 2).getTime()
    const msg = composeMessage([
      { id: '1', path: 'docs/x.md', shownAt: at, quote: 'the quoted\ntext', lines: [12, 14], text: 'Shorter.' },
      { id: '2', path: 'docs/x.md', shownAt: at, quote: 'gone', lines: null, text: 'Keep this.' },
      { id: '3', path: 'docs/y.md', shownAt: at, quote: 'y', lines: [3, 3], text: 'Ok' }
    ], '  And one more thing. ')
    expect(msg).toBe(
      'Comments on docs/x.md (shown 14:02):\n\n1. Lines 12-14:\n> the quoted\n> text\nShorter.\n\n2. In removed text:\n> gone\nKeep this.' +
      '\n\nComments on docs/y.md (shown 14:02):\n\n1. Line 3:\n> y\nOk' +
      '\n\nAnd one more thing.'
    )
  })
})
