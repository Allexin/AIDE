/**
 * Flattens history entries into virtualizable rows: one header row per run of
 * same-role entries, then one row per block. Tool results are attached to their
 * tool call (matched by id) instead of appearing as separate "user" messages.
 */

export type TranscriptRow =
  | { key: string; type: 'header'; role: 'user' | 'assistant'; first: boolean }
  | { key: string; type: 'text'; role: 'user' | 'assistant'; text: string }
  | { key: string; type: 'thinking'; text: string }
  | { key: string; type: 'tool'; block: HistoryBlock; result: string | null }
  | { key: string; type: 'result'; content: string }

export function toolResultText(content: HistoryBlock['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block.type === 'text' && block.text).map((block) => block.text ?? '').join('\n')
}

export function buildTranscriptRows(entries: HistoryEntry[]): TranscriptRow[] {
  const toolUseIds = new Set<string>()
  const results = new Map<string, string>()
  for (const entry of entries) {
    for (const block of entry.blocks) {
      if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id)
      else if (block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, toolResultText(block.content))
    }
  }

  const rows: TranscriptRow[] = []
  let lastRole: 'user' | 'assistant' | null = null
  entries.forEach((entry, entryIndex) => {
    const visible = entry.blocks
      .map((block, blockIndex) => ({ block, key: `${entryIndex}:${blockIndex}` }))
      .filter(({ block }) => !(block.type === 'tool_result' && block.tool_use_id && toolUseIds.has(block.tool_use_id)))
    if (visible.length === 0) return
    if (entry.role !== lastRole) {
      rows.push({ key: `${entryIndex}:h`, type: 'header', role: entry.role, first: lastRole === null })
      lastRole = entry.role
    }
    for (const { block, key } of visible) {
      if (block.type === 'text' && block.text?.trim()) rows.push({ key, type: 'text', role: entry.role, text: block.text })
      else if (block.type === 'thinking' && block.thinking?.trim()) rows.push({ key, type: 'thinking', text: block.thinking })
      else if (block.type === 'tool_use') rows.push({ key, type: 'tool', block, result: block.id ? results.get(block.id) ?? null : null })
      else if (block.type === 'tool_result') rows.push({ key, type: 'result', content: toolResultText(block.content) })
    }
  })
  return rows
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** One-line description of a tool call for its collapsed header. */
export function toolLabel(block: HistoryBlock): string {
  const name = block.name ?? 'tool'
  const view = block.view
  if (view) {
    switch (view.kind) {
      case 'edit': return `${name} ${view.path}${view.edits.length > 1 ? ` (${view.edits.length} edits)` : ''}`
      case 'patch': return `Patch ${view.paths.join(', ') || '(no files)'}`
      case 'write': return `${name} ${view.path}`
      case 'read': return `${name} ${view.path}${view.range ? ` (${view.range})` : ''}`
      case 'shell': return `$ ${firstLine(view.command)}`
      case 'search': return `${name} ${view.pattern}${view.path ? ` in ${view.path}` : ''}`
      case 'script': return `${name} ${firstLine(view.summary)}`
    }
  }
  const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {}
  const hint = str(input.file_path) ?? str(input.path) ?? str(input.command) ?? str(input.pattern)
    ?? str(input.url) ?? str(input.query) ?? str(input.description) ?? str(input.prompt)
  return hint ? `${name} ${firstLine(hint)}` : name
}

function fence(text: string, language = ''): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${language}\n${text}\n${ticks}`
}

export function transcriptToMarkdown(rows: TranscriptRow[], toolName: string): string {
  const parts: string[] = []
  for (const row of rows) {
    if (row.type === 'header') parts.push(`## ${row.role === 'user' ? 'You' : toolName || 'Assistant'}`)
    else if (row.type === 'text') parts.push(row.text)
    else if (row.type === 'thinking') parts.push(row.text.split('\n').map((line) => `> ${line}`).join('\n'))
    else if (row.type === 'tool') {
      parts.push(`**→ ${toolLabel(row.block)}**`)
      if (row.result) parts.push(fence(row.result))
    } else parts.push(fence(row.content))
  }
  return parts.join('\n\n') + '\n'
}
