import { diffArrays } from 'diff'
import { splitLines } from './range'

/** A line diff for Source views and text files (docs/file-viewer-spec.md, "File kinds"). */

export interface DiffLine {
  status: 'equal' | 'removed' | 'added'
  text: string
  /** File line in the base (removed and equal lines). */
  baseLine: number | null
  /** File line in the current text (added and equal lines). */
  line: number | null
  /** Change stop, 1-based; consecutive changed lines count as one. */
  change?: number
}

export interface LineDiff {
  lines: DiffLine[]
  changes: number
}

export function diffLines(base: string | null, current: string, baseLineOffset = 1, currentLineOffset = 1): LineDiff {
  const cur = splitLines(current)
  if (base === null) {
    return { lines: cur.map((text, i) => ({ status: 'equal', text, baseLine: null, line: currentLineOffset + i })), changes: 0 }
  }
  const old = splitLines(base)
  const lines: DiffLine[] = []
  let bi = 0
  let ci = 0
  let changes = 0
  let inChange = false
  for (const change of diffArrays(old, cur)) {
    if (!change.added && !change.removed) {
      inChange = false
      for (const text of change.value) lines.push({ status: 'equal', text, baseLine: baseLineOffset + bi++, line: currentLineOffset + ci++ })
      continue
    }
    if (!inChange) { changes++; inChange = true }
    for (const text of change.value) {
      if (change.removed) lines.push({ status: 'removed', text, baseLine: baseLineOffset + bi++, line: null, change: changes })
      else lines.push({ status: 'added', text, baseLine: null, line: currentLineOffset + ci++, change: changes })
    }
  }
  return { lines, changes }
}
