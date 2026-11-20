/**
 * The part of a file the viewer shows (docs/file-viewer-spec.md, "Range"). A bound is a
 * 1-based line number or a marker: the text of a line (a heading, an HTML comment). Markers
 * are looked up again on every read, so the range follows edits made above it.
 */

export type RangeBound = number | string

export interface ViewRange {
  /** First line shown: a line number, or the first line containing this text (shown). */
  from?: RangeBound
  /** A line number: the last line shown. Text: the first line after `from` containing it, not shown. */
  to?: RangeBound
}

export interface Slice {
  text: string
  /** 1-based line of the slice's first line in the file. */
  startLine: number
  /** 1-based line of the slice's last line in the file. */
  endLine: number
}

export function splitLines(content: string): string[] {
  return content.replace(/\r\n?/g, '\n').split('\n')
}

function findLine(lines: string[], marker: string, fromIndex: number): number {
  const needle = marker.trim()
  if (!needle) return -1
  for (let i = fromIndex; i < lines.length; i++) if (lines[i].includes(needle)) return i
  return -1
}

/**
 * The slice of `content` that `range` names; the whole content without a range; null when
 * a bound cannot be found (a marker missing, a line out of the file).
 */
export function sliceRange(content: string, range?: ViewRange | null): Slice | null {
  const lines = splitLines(content)
  if (!range || (range.from === undefined && range.to === undefined)) {
    return { text: lines.join('\n'), startLine: 1, endLine: lines.length }
  }
  let start = 0
  if (typeof range.from === 'number') {
    if (!Number.isInteger(range.from) || range.from < 1 || range.from > lines.length) return null
    start = range.from - 1
  } else if (typeof range.from === 'string') {
    start = findLine(lines, range.from, 0)
    if (start < 0) return null
  }
  let end = lines.length - 1
  if (typeof range.to === 'number') {
    if (!Number.isInteger(range.to) || range.to < start + 1) return null
    end = Math.min(range.to, lines.length) - 1
  } else if (typeof range.to === 'string') {
    // A text bound is where what follows begins: the line after `from`, not shown.
    const at = findLine(lines, range.to, start + 1)
    if (at < 0) return null
    end = at - 1
  }
  return { text: lines.slice(start, end + 1).join('\n'), startLine: start + 1, endLine: end + 1 }
}

/** A short human form of a range, for headers and tool results. */
export function describeRange(range?: ViewRange | null): string {
  if (!range || (range.from === undefined && range.to === undefined)) return ''
  const bound = (b: RangeBound | undefined, fallback: string): string =>
    b === undefined ? fallback : typeof b === 'number' ? `line ${b}` : `"${b.trim()}"`
  return `${bound(range.from, 'start')} – ${range.to === undefined ? 'end' : typeof range.to === 'number' ? bound(range.to, 'end') : `before ${bound(range.to, 'end')}`}`
}
