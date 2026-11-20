import type { ViewRange } from './range'
import type { Mark } from './marks'

/** What crosses between main and the viewer window (docs/file-viewer-spec.md). */

export type ViewerKind = 'markdown' | 'image' | 'text'

export interface ViewerReplyTab {
  available: boolean
  title?: string
}

/** A `view_show`: the presented diff is base → shown. */
export interface ViewerShowPayload {
  seq: number
  relPath: string
  kind: ViewerKind
  /** Text of the range (or a data URL for images); null: no marks. */
  base: string | null
  shown: string
  /** File line of the first line of base / shown (ranges start mid-file). */
  baseStartLine: number
  shownStartLine: number
  range: ViewRange | null
  rangeLabel: string
  shownAt: number
  anchor: string | number | null
  reply: ViewerReplyTab
  /** Marks mode (images only): null — view only; a list — the user may mark, starting from the agent's marks. */
  marks: Mark[] | null
}

/** The displayed file changed on disk: live diff is shown → content. */
export interface ViewerLivePayload {
  seq: number
  relPath: string
  /** Null when the file is gone or the range markers are not in it any more. */
  content: string | null
  startLine: number
  problem?: string
}

export interface ViewerSendResult {
  ok: boolean
  error?: string
}
