/** The message Send writes to the agent's tab (docs/file-viewer-spec.md, "Free text and Send"). */

export interface ViewerComment {
  id: string
  /** Project-relative path, forward slashes. */
  path: string
  /** When the file was shown, ms since epoch. */
  shownAt: number
  quote: string
  /** File lines of the current version; null for a quote from removed text. */
  lines: [number, number] | null
  text: string
  /** 'page': text an HTML page sent (parent.postMessage({ aide: 'send', text })), not a selection. */
  from?: 'page'
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function quoted(text: string): string {
  return text.trim().split(/\r?\n/).map((line) => `> ${line}`).join('\n')
}

function where(c: ViewerComment): string {
  if (c.from === 'page') return 'From the page'
  const lines = c.lines
  if (!lines) return 'In removed text'
  return lines[0] === lines[1] ? `Line ${lines[0]}` : `Lines ${lines[0]}-${lines[1]}`
}

/** One message: the marks section (formatMarks), the comments grouped by file in the order they were made, then the free text. */
export function composeMessage(comments: ViewerComment[], freeText: string, marksSection = ''): string {
  const parts: string[] = []
  if (marksSection.trim()) parts.push(marksSection.trim())
  const files: string[] = []
  for (const c of comments) if (!files.includes(c.path)) files.push(c.path)
  for (const path of files) {
    const own = comments.filter((c) => c.path === path)
    const shownAt = Math.max(...own.map((c) => c.shownAt))
    const body = own.map((c, i) => `${i + 1}. ${where(c)}:\n${quoted(c.quote)}\n${c.text.trim()}`.trimEnd())
    parts.push(`Comments on ${path} (shown ${clock(shownAt)}):\n\n${body.join('\n\n')}`)
  }
  if (freeText.trim()) parts.push(freeText.trim())
  return parts.join('\n\n')
}
