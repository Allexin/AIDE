import { Marked, Parser, type Token, type Tokens } from 'marked'
import { diffArrays } from 'diff'

/**
 * Rendered Markdown diff (docs/file-viewer-spec.md, "Rendered Markdown diff").
 *
 * Both versions are split into blocks (paragraphs, headings, single list items, single table
 * rows, code blocks…), the block lists are diffed by their source, and similar blocks of a
 * change are paired and diffed word by word over their inline tokens. Every piece of output
 * is a whole block or a whole inline atom with its own formatting, so the markup stays
 * balanced whatever the diff is.
 *
 * The HTML is not sanitized here: the renderer passes it through DOMPurify. Pure apart from
 * `marked`; runs in main (to count changes) and in the renderer.
 */

type BlockKind = 'heading' | 'paragraph' | 'code' | 'blockquote' | 'listItem' | 'tableRow' | 'hr' | 'html' | 'other'

export interface Block {
  kind: BlockKind
  /** What the block diff compares. */
  key: string
  /** 1-based, within the text given to `splitBlocks`. */
  startLine: number
  endLine: number
  token: Token
  // listItem
  depth?: number
  ordered?: boolean
  number?: number
  loose?: boolean
  task?: boolean
  checked?: boolean
  content?: Token[]
  // tableRow
  tableKey?: string
  header?: boolean
  cells?: Tokens.TableCell[]
  align?: Array<'center' | 'left' | 'right' | null>
}

export type DiffItem =
  | { status: 'equal' | 'added'; block: Block }
  | { status: 'removed'; block: Block }
  | { status: 'changed'; base: Block; current: Block }

/** Word-level similarity below which a changed block is shown as removed + added. */
export const PAIR_THRESHOLD = 0.4

// ── Marked setup ─────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function codeLang(lang: string | undefined): string {
  return (lang ?? '').trim().split(/\s+/)[0] ?? ''
}

/** A Mermaid diagram: its source, rendered into a diagram by the viewer (src/renderer/.../viewer/mermaid.ts). */
function mermaidHtml(text: string): string {
  return `<pre class="md-mermaid"><code>${escapeHtml(text)}</code></pre>`
}

const md = new Marked({ gfm: true, breaks: false, async: false })
md.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = codeLang(lang)
      if (language.toLowerCase() === 'mermaid') return mermaidHtml(text)
      return `<pre class="md-code" data-lang="${escapeHtml(language)}"><code>${escapeHtml(text)}</code></pre>`
    }
  }
})
// One parser for everything: md.parser() would build its own and rebind the renderer.
const parser = new Parser(md.defaults)

// ── Blocks ───────────────────────────────────────────────────────────────────

function lineStarts(src: string): number[] {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1)
  return starts
}

function lineOfOffset(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function countLines(raw: string): number {
  return Math.max(1, raw.replace(/\n+$/, '').split('\n').length)
}

/** First line at or after `from` (1-based) whose trimmed text equals `first`; `from` when none. */
function findLine(lines: string[], first: string, from: number): number {
  const needle = first.trim()
  for (let i = from - 1; i < lines.length; i++) if (lines[i].trim() === needle) return i + 1
  return from
}

function firstLine(raw: string): string {
  return raw.replace(/^\n+/, '').split('\n')[0] ?? ''
}

function listItems(list: Tokens.List, depth: number, lines: string[], fromLine: number, out: Block[]): number {
  let cursor = fromLine
  const start = typeof list.start === 'number' ? list.start : 1
  list.items.forEach((item, index) => {
    const startLine = findLine(lines, firstLine(item.raw), cursor)
    const nested = item.tokens.filter((t): t is Tokens.List => t.type === 'list')
    const content = item.tokens.filter((t) => t.type !== 'list')
    const contentRaw = content.map((t) => t.raw).join('').trim()
    const ownLines = countLines(content.map((t) => t.raw).join('') || item.raw)
    out.push({
      kind: 'listItem',
      key: `li|${depth}|${list.ordered ? 'o' : 'u'}|${item.task ? (item.checked ? 'x' : ' ') : '-'}|${contentRaw}`,
      startLine,
      endLine: startLine + ownLines - 1,
      token: item,
      depth,
      ordered: list.ordered,
      number: start + index,
      loose: item.loose,
      task: item.task,
      checked: item.checked,
      content
    })
    cursor = startLine + 1
    for (const sub of nested) cursor = listItems(sub, depth + 1, lines, cursor, out)
    cursor = Math.max(cursor, startLine + countLines(item.raw))
  })
  return cursor
}

/** The blocks of a Markdown text, in order. */
export function splitBlocks(text: string): Block[] {
  const src = text.replace(/\r\n?/g, '\n')
  const starts = lineStarts(src)
  const lines = src.split('\n')
  const tokens = md.lexer(src)
  const out: Block[] = []
  let offset = 0
  for (const token of tokens) {
    const at = src.indexOf(token.raw, offset)
    const pos = at >= 0 ? at : offset
    offset = pos + token.raw.length
    if (token.type === 'space' || token.type === 'def') continue
    const startLine = lineOfOffset(starts, pos + (token.raw.length - token.raw.replace(/^\n+/, '').length))
    if (token.type === 'list') {
      listItems(token as Tokens.List, 1, lines, startLine, out)
      continue
    }
    if (token.type === 'table') {
      const table = token as Tokens.Table
      const rawLines = table.raw.replace(/\n+$/, '').split('\n')
      const tableKey = `${rawLines[0]?.trim()}|${rawLines[1]?.trim()}`
      const align = table.align
      out.push({ kind: 'tableRow', key: `th|${rawLines[0]?.trim()}`, startLine, endLine: startLine, token, tableKey, header: true, cells: table.header, align })
      table.rows.forEach((row, i) => {
        const line = startLine + 2 + i
        out.push({ kind: 'tableRow', key: `tr|${(rawLines[2 + i] ?? '').trim()}`, startLine: line, endLine: line, token, tableKey, header: false, cells: row, align })
      })
      continue
    }
    const kind: BlockKind =
      token.type === 'heading' || token.type === 'paragraph' || token.type === 'code' || token.type === 'blockquote' || token.type === 'hr' || token.type === 'html'
        ? token.type
        : 'other'
    out.push({ kind, key: `${kind}|${token.raw.trim()}`, startLine, endLine: startLine + countLines(token.raw.replace(/^\n+/, '')) - 1, token })
  }
  return out
}

// ── Inline atoms ─────────────────────────────────────────────────────────────

interface Atom {
  key: string
  html: string
  word: boolean
}

interface Wrap {
  open: string
  close: string
  sig: string
}

function wrapped(wraps: Wrap[], inner: string): string {
  return wraps.map((w) => w.open).join('') + inner + wraps.map((w) => w.close).reverse().join('')
}

function atomize(tokens: Token[], wraps: Wrap[], out: Atom[]): void {
  const sig = wraps.map((w) => w.sig).join(',')
  for (const token of tokens) {
    const t = token as Tokens.Generic
    switch (token.type) {
      case 'text':
      case 'escape':
        if (Array.isArray(t.tokens) && t.tokens.length) {
          atomize(t.tokens, wraps, out)
        } else {
          for (const piece of String(t.text ?? '').split(/(\s+)/)) {
            if (!piece) continue
            const space = /^\s+$/.test(piece)
            out.push({ key: `${sig}|${space ? ' ' : piece}`, html: wrapped(wraps, space ? ' ' : piece), word: !space })
          }
        }
        break
      case 'strong':
        atomize(t.tokens ?? [], [...wraps, { open: '<strong>', close: '</strong>', sig: 'b' }], out)
        break
      case 'em':
        atomize(t.tokens ?? [], [...wraps, { open: '<em>', close: '</em>', sig: 'i' }], out)
        break
      case 'del':
        atomize(t.tokens ?? [], [...wraps, { open: '<s>', close: '</s>', sig: 's' }], out)
        break
      case 'link': {
        const href = String(t.href ?? '')
        const title = t.title ? ` title="${escapeHtml(String(t.title))}"` : ''
        atomize(t.tokens ?? [], [...wraps, { open: `<a href="${escapeHtml(href)}"${title}>`, close: '</a>', sig: `a:${href}` }], out)
        break
      }
      case 'br':
        out.push({ key: `${sig}|<br>`, html: '<br>', word: true })
        break
      default:
        out.push({ key: `${sig}|${token.raw}`, html: wrapped(wraps, parser.parseInline([token])), word: true })
    }
  }
}

const BREAK: Token = { type: 'br', raw: '\n' } as Token

/** Inline tokens of a block whose text can be diffed word by word; null otherwise. */
function inlineTokens(block: Block): Token[] | null {
  const t = block.token as Tokens.Generic
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return t.tokens ?? []
    case 'blockquote':
    case 'listItem': {
      const children: Token[] = block.kind === 'listItem' ? (block.content ?? []) : (t.tokens ?? [])
      const parts = children.filter((c) => c.type !== 'space')
      if (parts.some((c) => c.type !== 'paragraph' && c.type !== 'text')) return null
      const out: Token[] = []
      parts.forEach((c, i) => {
        if (i > 0) out.push(BREAK)
        out.push(...(((c as Tokens.Generic).tokens as Token[] | undefined) ?? [{ type: 'text', raw: c.raw, text: (c as Tokens.Text).text } as Token]))
      })
      return out
    }
    default:
      return null
  }
}

function atomsOf(tokens: Token[]): Atom[] {
  const out: Atom[] = []
  atomize(tokens, [], out)
  return out
}

function words(block: Block): string[] {
  if (block.kind === 'tableRow') return (block.cells ?? []).flatMap((c) => c.text.split(/\s+/)).filter(Boolean)
  if (block.kind === 'code') return String((block.token as Tokens.Code).text).split(/\s+/).filter(Boolean)
  const tokens = inlineTokens(block)
  return tokens ? atomsOf(tokens).filter((a) => a.word).map((a) => a.key) : []
}

/** 2 × common words / (words A + words B). */
export function similarity(a: string[], b: string[]): number {
  if (a.length + b.length === 0) return 1
  let common = 0
  for (const change of diffArrays(a, b)) if (!change.added && !change.removed) common += change.count ?? change.value.length
  return (2 * common) / (a.length + b.length)
}

function pairable(base: Block, current: Block): boolean {
  if (base.kind !== current.kind) return false
  switch (base.kind) {
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'listItem':
      if (!inlineTokens(base) || !inlineTokens(current)) return false
      break
    case 'tableRow':
      if ((base.cells?.length ?? 0) !== (current.cells?.length ?? 0) || base.header !== current.header) return false
      break
    case 'code':
      break
    default:
      return false
  }
  return similarity(words(base), words(current)) >= PAIR_THRESHOLD
}

// ── Diff ─────────────────────────────────────────────────────────────────────

function pairRun(removed: Block[], added: Block[], out: DiffItem[]): void {
  let j = 0
  for (const r of removed) {
    let k = -1
    for (let i = j; i < added.length; i++) {
      if (pairable(r, added[i])) { k = i; break }
    }
    if (k < 0) {
      out.push({ status: 'removed', block: r })
      continue
    }
    for (; j < k; j++) out.push({ status: 'added', block: added[j] })
    out.push({ status: 'changed', base: r, current: added[k] })
    j = k + 1
  }
  for (; j < added.length; j++) out.push({ status: 'added', block: added[j] })
}

/** The block diff of two Markdown texts; with no base, every block is equal. */
export function diffBlocks(base: string | null, current: string): DiffItem[] {
  const cur = splitBlocks(current)
  if (base === null) return cur.map((block) => ({ status: 'equal', block }))
  const old = splitBlocks(base)
  const out: DiffItem[] = []
  let oi = 0
  let ci = 0
  let removed: Block[] = []
  let added: Block[] = []
  const flush = (): void => {
    if (removed.length || added.length) pairRun(removed, added, out)
    removed = []
    added = []
  }
  for (const change of diffArrays(old.map((b) => b.key), cur.map((b) => b.key))) {
    const n = change.count ?? change.value.length
    if (change.removed) {
      removed.push(...old.slice(oi, oi + n))
      oi += n
    } else if (change.added) {
      added.push(...cur.slice(ci, ci + n))
      ci += n
    } else {
      flush()
      for (let i = 0; i < n; i++) out.push({ status: 'equal', block: cur[ci + i] })
      oi += n
      ci += n
    }
  }
  flush()
  return out
}

// ── Rendering ────────────────────────────────────────────────────────────────

function atomDiffHtml(base: Token[], current: Token[]): string {
  const a = atomsOf(base)
  const b = atomsOf(current)
  let html = ''
  let ai = 0
  let bi = 0
  for (const change of diffArrays(a.map((x) => x.key), b.map((x) => x.key))) {
    const n = change.count ?? change.value.length
    if (change.removed) {
      html += `<del class="vd-del">${a.slice(ai, ai + n).map((x) => x.html).join('')}</del>`
      ai += n
    } else if (change.added) {
      html += `<ins class="vd-ins">${b.slice(bi, bi + n).map((x) => x.html).join('')}</ins>`
      bi += n
    } else {
      html += b.slice(bi, bi + n).map((x) => x.html).join('')
      ai += n
      bi += n
    }
  }
  return html
}

function taskBox(block: Block): string {
  return block.task ? `<span class="vd-task">${block.checked ? '☑' : '☐'}</span> ` : ''
}

function cellTag(block: Block, i: number): { open: string; close: string } {
  const tag = block.header ? 'th' : 'td'
  const align = block.align?.[i]
  return { open: `<${tag}${align ? ` align="${align}"` : ''}>`, close: `</${tag}>` }
}

function blockInner(block: Block): string {
  switch (block.kind) {
    case 'listItem':
      return taskBox(block) + parser.parse(block.content ?? [], !!block.loose)
    case 'tableRow':
      return (block.cells ?? []).map((cell, i) => {
        const { open, close } = cellTag(block, i)
        return open + parser.parseInline(cell.tokens) + close
      }).join('')
    default:
      return parser.parse([block.token])
  }
}

function changedInner(base: Block, current: Block): string {
  switch (current.kind) {
    case 'paragraph':
      return `<p>${atomDiffHtml(inlineTokens(base) ?? [], inlineTokens(current) ?? [])}</p>`
    case 'heading': {
      const depth = (current.token as Tokens.Heading).depth
      return `<h${depth}>${atomDiffHtml(inlineTokens(base) ?? [], inlineTokens(current) ?? [])}</h${depth}>`
    }
    case 'blockquote':
      return `<blockquote><p>${atomDiffHtml(inlineTokens(base) ?? [], inlineTokens(current) ?? [])}</p></blockquote>`
    case 'listItem':
      return taskBox(current) + atomDiffHtml(inlineTokens(base) ?? [], inlineTokens(current) ?? [])
    case 'tableRow':
      return (current.cells ?? []).map((cell, i) => {
        const { open, close } = cellTag(current, i)
        return open + atomDiffHtml(base.cells?.[i]?.tokens ?? [], cell.tokens) + close
      }).join('')
    case 'code': {
      const lang = codeLang((current.token as Tokens.Code).lang)
      if (lang.toLowerCase() === 'mermaid' && codeLang((base.token as Tokens.Code).lang).toLowerCase() === 'mermaid') {
        // A changed diagram: both pictures; Source shows the line diff.
        return '<div class="md-mermaid-pair">' +
          `<div class="md-mermaid-before"><div class="md-mermaid-label">Before</div>${mermaidHtml(String((base.token as Tokens.Code).text))}</div>` +
          `<div class="md-mermaid-after"><div class="md-mermaid-label">After</div>${mermaidHtml(String((current.token as Tokens.Code).text))}</div>` +
          '</div>'
      }
      const a = String((base.token as Tokens.Code).text).split('\n')
      const b = String((current.token as Tokens.Code).text).split('\n')
      let body = ''
      for (const change of diffArrays(a, b)) {
        const cls = change.removed ? ' vd-line-del' : change.added ? ' vd-line-ins' : ''
        for (const line of change.value) body += `<span class="vd-line${cls}">${escapeHtml(line)}\n</span>`
      }
      return `<pre class="md-code md-code-diff" data-lang="${escapeHtml(lang)}"><code>${body}</code></pre>`
    }
    default:
      return blockInner(current)
  }
}

export interface RenderOptions {
  /** File line of the base text's first line (a range starts mid-file). */
  baseLineOffset?: number
  /** File line of the current text's first line. */
  currentLineOffset?: number
}

export interface RenderedDiff {
  html: string
  /** Change stops: consecutive changed items count as one. */
  changes: number
}

/** HTML of a block diff, with `data-lines` (file lines) and `data-change` (stop index, 1-based) attributes. */
export function renderDiff(items: DiffItem[], options: RenderOptions = {}): RenderedDiff {
  const baseOff = (options.baseLineOffset ?? 1) - 1
  const curOff = (options.currentLineOffset ?? 1) - 1
  let html = ''
  const lists: boolean[] = []
  let table: string | null = null
  let changes = 0
  let inChange = false

  const closeLists = (depth: number): void => {
    while (lists.length > depth) html += lists.pop() ? '</ol>' : '</ul>'
  }
  const closeTable = (): void => {
    if (table !== null) html += '</table>'
    table = null
  }

  for (const item of items) {
    const block = item.status === 'changed' ? item.current : item.block
    if (item.status === 'equal') inChange = false
    else if (!inChange) { changes++; inChange = true }

    const fromBase = item.status === 'removed'
    const off = fromBase ? baseOff : curOff
    const cls = item.status === 'equal' ? '' : `vd-${item.status}`
    const attrs =
      ` data-lines="${block.startLine + off}-${block.endLine + off}"` +
      (fromBase ? ' data-side="base"' : '') +
      (item.status === 'equal' ? '' : ` data-change="${changes}"`)
    const inner = item.status === 'changed' ? changedInner(item.base, item.current) : blockInner(block)

    if (block.kind === 'listItem') {
      closeTable()
      const depth = block.depth ?? 1
      closeLists(depth)
      if (lists.length === depth && lists[depth - 1] !== !!block.ordered) closeLists(depth - 1)
      while (lists.length < depth) {
        const ordered = lists.length === depth - 1 ? !!block.ordered : false
        html += ordered ? `<ol start="${block.number ?? 1}">` : '<ul>'
        lists.push(ordered)
      }
      html += `<li class="vd-item ${cls}"${attrs}>${inner}</li>`
      continue
    }
    closeLists(0)
    if (block.kind === 'tableRow') {
      if (table !== block.tableKey) {
        closeTable()
        html += '<table>'
        table = block.tableKey ?? ''
      }
      html += `<tr class="vd-row ${cls}"${attrs}>${inner}</tr>`
      continue
    }
    closeTable()
    html += `<div class="vd-block ${cls}"${attrs}>${inner}</div>`
  }
  closeLists(0)
  closeTable()
  return { html, changes }
}

/** Diff and render in one call; `base` null renders the document without marks. */
export function diffMarkdown(base: string | null, current: string, options: RenderOptions = {}): RenderedDiff {
  return renderDiff(diffBlocks(base, current), options)
}
