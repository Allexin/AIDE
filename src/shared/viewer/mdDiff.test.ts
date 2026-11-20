import { describe, expect, it } from 'vitest'
import { diffBlocks, diffMarkdown, renderDiff, similarity, splitBlocks } from './mdDiff'

/** Every opened tag of the kinds we emit is closed, in order. */
function balanced(html: string): boolean {
  const stack: string[] = []
  const voids = new Set(['br', 'hr', 'img', 'input'])
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/gi)) {
    const [, closing, name, selfClosing] = m
    const tag = name.toLowerCase()
    if (voids.has(tag) || selfClosing) continue
    if (!closing) stack.push(tag)
    else if (stack.pop() !== tag) return false
  }
  return stack.length === 0
}

describe('splitBlocks', () => {
  it('splits paragraphs, headings, list items and table rows with their lines', () => {
    const text = '# Title\n\nFirst para\nwraps.\n\n- one\n  - nested\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    const blocks = splitBlocks(text)
    expect(blocks.map((b) => [b.kind, b.startLine, b.endLine])).toEqual([
      ['heading', 1, 1],
      ['paragraph', 3, 4],
      ['listItem', 6, 6],
      ['listItem', 7, 7],
      ['listItem', 8, 8],
      ['tableRow', 10, 10],
      ['tableRow', 12, 12]
    ])
    expect(blocks[3].depth).toBe(2)
  })
})

describe('diffBlocks', () => {
  it('marks nothing without a base', () => {
    const r = diffMarkdown(null, '# A\n\ntext')
    expect(r.changes).toBe(0)
    expect(r.html).not.toMatch(/vd-(added|removed|changed)|data-change/)
  })

  it('pairs a lightly edited paragraph and diffs its words', () => {
    const items = diffBlocks('The quick brown fox jumps.', 'The quick red fox jumps.')
    expect(items.map((i) => i.status)).toEqual(['changed'])
    const { html, changes } = renderDiff(items)
    expect(changes).toBe(1)
    expect(html).toContain('<del class="vd-del">brown</del>')
    expect(html).toContain('<ins class="vd-ins">red</ins>')
    expect(balanced(html)).toBe(true)
  })

  it('shows a rewritten paragraph as removed + added', () => {
    const items = diffBlocks('Alpha beta gamma delta.', 'Completely different words here now.')
    expect(items.map((i) => i.status)).toEqual(['removed', 'added'])
  })

  it('keeps formatting balanced when a word inside bold changes', () => {
    const { html } = diffMarkdown('Some **very bold text** here.', 'Some **very loud text** here.')
    expect(balanced(html)).toBe(true)
    expect(html).toContain('<del class="vd-del"><strong>bold</strong></del>')
  })

  it('treats a formatting-only change as removed + added words', () => {
    const { html } = diffMarkdown('make it bold now please', 'make it **bold** now please')
    expect(html).toContain('<del class="vd-del">bold</del><ins class="vd-ins"><strong>bold</strong></ins>')
  })

  it('places an inserted list item in its list', () => {
    const { html, changes } = diffMarkdown('- one\n- three\n', '- one\n- two\n- three\n')
    expect(changes).toBe(1)
    expect(html.match(/<ul>/g)?.length).toBe(1)
    expect(html).toMatch(/<li class="vd-item vd-added" data-lines="2-2" data-change="1">two<\/li>/)
    expect(balanced(html)).toBe(true)
  })

  it('nests list items by depth', () => {
    const { html } = diffMarkdown(null, '- a\n  - b\n- c\n')
    expect(html).toBe('<ul><li class="vd-item " data-lines="1-1">a</li><ul><li class="vd-item " data-lines="2-2">b</li></ul><li class="vd-item " data-lines="3-3">c</li></ul>')
  })

  it('keeps a removed table row inside its table', () => {
    const { html } = diffMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n', '| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(html.match(/<table>/g)?.length).toBe(1)
    expect(html).toContain('class="vd-row vd-removed" data-lines="4-4" data-side="base"')
    expect(balanced(html)).toBe(true)
  })

  it('diffs table cells word by word', () => {
    const { html } = diffMarkdown('| a | b |\n|---|---|\n| one two three | x |\n', '| a | b |\n|---|---|\n| one two four | x |\n')
    expect(html).toContain('<td>one two <del class="vd-del">three</del><ins class="vd-ins">four</ins></td>')
  })

  it('line-diffs a changed code block', () => {
    const { html } = diffMarkdown('```ts\nconst a = 1\nconst b = 2\n```', '```ts\nconst a = 1\nconst b = 3\n```')
    expect(html).toContain('md-code-diff')
    expect(html).toContain('<span class="vd-line vd-line-del">const b = 2\n</span>')
    expect(html).toContain('<span class="vd-line vd-line-ins">const b = 3\n</span>')
  })

  it('counts consecutive changes as one stop', () => {
    const { changes } = diffMarkdown('a\n\nb\n\nc\n\nd', 'a\n\nB2 new\n\nC2 new\n\nd')
    expect(changes).toBe(1)
  })

  it('applies line offsets of a range', () => {
    const { html } = diffMarkdown('x\n\nold words here', 'x\n\nnew stuff entirely', { baseLineOffset: 10, currentLineOffset: 20 })
    expect(html).toContain('data-lines="12-12" data-side="base"')
    expect(html).toContain('data-lines="22-22" data-change="1"')
  })

  it('escapes html in code spans and text', () => {
    const { html } = diffMarkdown('a `<b>` c d e', 'a `<b>` c d f')
    expect(html).toContain('<code>&lt;b&gt;</code>')
  })
})

describe('similarity', () => {
  it('is 1 for equal and 0 for disjoint lists', () => {
    expect(similarity(['a', 'b'], ['a', 'b'])).toBe(1)
    expect(similarity(['a'], ['b'])).toBe(0)
  })
})
