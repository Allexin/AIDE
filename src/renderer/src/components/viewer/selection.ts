/** Mapping between the rendered document and file lines (docs/file-viewer-spec.md, "Source line range"). */

export interface SelectionInfo {
  quote: string
  /** File lines of the current version; null when the selection is only in removed text. */
  lines: [number, number] | null
  rect: DOMRect
}

function parseLines(el: Element): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(el.getAttribute('data-lines') ?? '')
  return m ? [Number(m[1]), Number(m[2])] : null
}

/**
 * The text of a selection without the removed words inside lines. `user-select: none` keeps
 * them from being highlighted, but Selection.toString() still returns them, so the range is
 * copied, they are dropped, and the text is read from the copy laid out off-screen
 * (innerText keeps the line breaks between blocks).
 */
function quoteOf(range: Range): string {
  const holder = document.createElement('div')
  holder.className = 'md vd-doc'
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:800px;'
  holder.appendChild(range.cloneContents())
  holder.querySelectorAll('del.vd-del, .vd-line-del').forEach((el) => el.remove())
  document.body.appendChild(holder)
  const text = holder.innerText
  holder.remove()
  return text.replace(/ /g, ' ').trim()
}

/** The selection inside `root`, with the union of the current-version lines it touches. */
export function readSelection(root: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const quote = quoteOf(range)
  if (!quote) return null
  let from = Infinity
  let to = -Infinity
  for (const el of Array.from(root.querySelectorAll('[data-lines]'))) {
    if (el.getAttribute('data-side') === 'base' || !range.intersectsNode(el)) continue
    // Skip containers whose own children carry lines (lists inside list items).
    const lines = parseLines(el)
    if (!lines) continue
    from = Math.min(from, lines[0])
    to = Math.max(to, lines[1])
  }
  const rects = range.getClientRects()
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
  return { quote, lines: Number.isFinite(from) ? [from, to] : null, rect }
}

/** Elements of the displayed document that show the lines of a comment (or its removed quote). */
export function elementsFor(root: HTMLElement, lines: [number, number] | null, quote: string): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>('[data-lines]'))
  if (!lines) {
    const probe = quote.slice(0, 40)
    return all.filter((el) => el.getAttribute('data-side') === 'base' && (el.textContent ?? '').includes(probe))
  }
  return all.filter((el) => {
    if (el.getAttribute('data-side') === 'base') return false
    const own = parseLines(el)
    return own !== null && own[0] <= lines[1] && own[1] >= lines[0]
  })
}

/** The element to scroll to for an anchor: a line number, or a heading containing the text. */
export function anchorElement(root: HTMLElement, anchor: string | number): HTMLElement | null {
  if (typeof anchor === 'number') {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-lines]'))) {
      if (el.getAttribute('data-side') === 'base') continue
      const own = parseLines(el)
      if (own && own[1] >= anchor) return el
    }
    return null
  }
  const needle = anchor.replace(/^#+\s*/, '').trim().toLowerCase()
  for (const h of Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
    if ((h.textContent ?? '').toLowerCase().includes(needle)) return h
  }
  return null
}
