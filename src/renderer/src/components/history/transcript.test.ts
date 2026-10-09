import { describe, expect, it } from 'vitest'
import { diffLines } from './lineDiff'
import { buildTranscriptRows, toolLabel, transcriptToMarkdown } from './transcriptRows'

describe('diffLines', () => {
  it('interleaves changes with short context', () => {
    const lines = diffLines('a\nb\nc\nd\ne\nf', 'a\nb\nX\nd\ne\nf')
    expect(lines.map((l) => l.op + l.text)).toEqual([' a', ' b', '-c', '+X', ' d', ' e'])
  })

  it('handles pure insertion', () => {
    expect(diffLines('', 'new').map((l) => l.op + l.text)).toEqual(['-', '+new'])
  })
})

describe('buildTranscriptRows', () => {
  const entries: HistoryEntry[] = [
    { role: 'user', blocks: [{ type: 'text', text: 'Fix it' }] },
    { role: 'assistant', blocks: [{ type: 'thinking', thinking: 'hmm' }] },
    { role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, view: { kind: 'shell', command: 'ls' } }] },
    { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: 'Done' }] }
  ]

  it('groups same-role entries and attaches tool results to their calls', () => {
    const rows = buildTranscriptRows(entries)
    expect(rows.map((r) => r.type)).toEqual(['header', 'text', 'header', 'thinking', 'tool', 'text'])
    const tool = rows.find((r) => r.type === 'tool')
    expect(tool && tool.type === 'tool' ? tool.result : null).toBe('file.txt')
  })

  it('keeps row keys stable when entries are appended', () => {
    const before = buildTranscriptRows(entries.slice(0, 3)).map((r) => r.key)
    const after = buildTranscriptRows(entries).map((r) => r.key)
    expect(after.slice(0, before.length)).toEqual(before)
  })

  it('labels tools and exports Markdown', () => {
    const rows = buildTranscriptRows(entries)
    expect(toolLabel(entries[2].blocks[0])).toBe('$ ls')
    const md = transcriptToMarkdown(rows, 'Claude Code')
    expect(md).toContain('## You')
    expect(md).toContain('## Claude Code')
    expect(md).toContain('**→ $ ls**')
  })
})
