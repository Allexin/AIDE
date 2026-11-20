import { describeRange, sliceRange, type ViewRange } from '../../shared/viewer/range'
import { diffMarkdown } from '../../shared/viewer/mdDiff'
import { diffLines } from '../../shared/viewer/lineDiff'
import type { ViewerKind } from '../../shared/viewer/types'

/** The pure part of a show (docs/file-viewer-spec.md, "Snapshots"). */

export interface PreparedShow {
  base: string | null
  shown: string
  baseStartLine: number
  shownStartLine: number
  /** Why the base was dropped, for the tool result. */
  note?: string
}

/**
 * Base and shown parts of a show (pure): the range is cut from both versions; a base whose
 * range markers are gone is dropped rather than compared against the wrong text.
 */
export function prepareShow(kind: ViewerKind, current: string, baseFull: string | null, range: ViewRange | null): PreparedShow {
  if (kind === 'image') return { base: baseFull, shown: current, baseStartLine: 1, shownStartLine: 1 }
  const cur = sliceRange(current, range)
  if (!cur) throw new Error(`The range ${describeRange(range)} is not in the file.`)
  if (baseFull === null) return { base: null, shown: cur.text, baseStartLine: 1, shownStartLine: cur.startLine }
  const old = sliceRange(baseFull, range)
  if (!old) return { base: null, shown: cur.text, baseStartLine: 1, shownStartLine: cur.startLine, note: 'The range is not in the previous version; shown without marks.' }
  return { base: old.text, shown: cur.text, baseStartLine: old.startLine, shownStartLine: cur.startLine }
}

/** Change stops between base and shown. */
export function countChanges(kind: ViewerKind, p: PreparedShow): number {
  if (p.base === null) return 0
  if (kind === 'image') return p.base === p.shown ? 0 : 1
  if (kind === 'markdown') return diffMarkdown(p.base, p.shown).changes
  return diffLines(p.base, p.shown).changes
}
