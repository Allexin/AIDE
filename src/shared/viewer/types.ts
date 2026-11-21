import type { ViewRange } from './range'
import type { Mark } from './marks'

/** What crosses between main and the viewer window (docs/file-viewer-spec.md). */

export type ViewerKind = 'markdown' | 'image' | 'html' | 'text'

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
  /** HTML pages: the page under the offline and the network token of aide-preview://. */
  page: { offline: string; network: string } | null
  /** Where the Network button of a page starts (the setting privacy.viewerPagesNetwork). */
  pageNetwork: boolean
  /** aide-preview:// URL of the shown file's folder (ends with /): relative images of Markdown resolve against it. */
  assetBase: string
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

/** A file the shown document loaded (a page's CSS or script, an image of Markdown) changed: it reloads (when Live is on). */
export interface ViewerPageChanged {
  seq: number
}

export interface ViewerSendResult {
  ok: boolean
  error?: string
}
