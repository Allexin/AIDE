import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { diffMarkdown } from '../../../../shared/viewer/mdDiff'
import { diffLines } from '../../../../shared/viewer/lineDiff'
import type { ViewerKind } from '../../../../shared/viewer/types'
import { colorize, languageForPath } from '../history/markdown'

/** The document area of the file viewer: rendered Markdown, source lines or an image, with changes marked. */

export interface DisplaySpec {
  kind: ViewerKind
  relPath: string
  base: string | null
  current: string
  baseStartLine: number
  currentStartLine: number
  view: 'rendered' | 'source'
}

const PURIFY = {
  FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed', 'video', 'audio'],
  FORBID_ATTR: ['style']
}

function MarkdownBody({ spec }: { spec: DisplaySpec }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    const rendered = diffMarkdown(spec.base, spec.current, { baseLineOffset: spec.baseStartLine, currentLineOffset: spec.currentStartLine })
    return DOMPurify.sanitize(rendered.html, PURIFY) as string
  }, [spec.base, spec.current, spec.baseStartLine, spec.currentStartLine])

  // Colorize plain code blocks once the HTML is in place; changed code keeps its line marks.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let alive = true
    for (const pre of Array.from(root.querySelectorAll('pre.md-code:not(.md-code-diff)'))) {
      const code = pre.querySelector('code')
      if (!code) continue
      void colorize(code.textContent ?? '', pre.getAttribute('data-lang') ?? '').then((colored) => {
        if (alive && colored !== null) code.innerHTML = colored
      })
    }
    return () => { alive = false }
  }, [html])

  return <div ref={ref} className="md vd-doc" dangerouslySetInnerHTML={{ __html: html }} />
}

function splitColored(html: string | null, expected: number): string[] | null {
  if (html === null) return null
  const inner = html.replace(/^<div[^>]*>/, '').replace(/<\/div>\s*$/, '')
  const lines = inner.split(/<br\s*\/?>/)
  if (lines.length > expected && lines[lines.length - 1] === '') lines.pop()
  return lines.length === expected ? lines : null
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function SourceBody({ spec }: { spec: DisplaySpec }): React.ReactElement {
  const diff = useMemo(
    () => diffLines(spec.base, spec.current, spec.baseStartLine, spec.currentStartLine),
    [spec.base, spec.current, spec.baseStartLine, spec.currentStartLine]
  )
  const [colored, setColored] = useState<{ base: string[] | null; current: string[] | null } | null>(null)
  useEffect(() => {
    let alive = true
    setColored(null)
    const lang = languageForPath(spec.relPath)
    const curCount = spec.current.split(/\r?\n/).length
    const baseCount = spec.base === null ? 0 : spec.base.split(/\r?\n/).length
    void Promise.all([
      colorize(spec.current, lang),
      spec.base === null ? Promise.resolve(null) : colorize(spec.base, lang)
    ]).then(([cur, base]) => {
      if (alive) setColored({ current: splitColored(cur, curCount), base: splitColored(base, baseCount) })
    })
    return () => { alive = false }
  }, [spec.relPath, spec.base, spec.current])

  return (
    <div className="vd-source">
      {diff.lines.map((line, i) => {
        const fromBase = line.status === 'removed'
        const lineNo = fromBase ? line.baseLine : line.line
        const coloredLine = fromBase
          ? colored?.base?.[(line.baseLine ?? 0) - spec.baseStartLine]
          : colored?.current?.[(line.line ?? 0) - spec.currentStartLine]
        return (
          <div
            key={i}
            className={`vd-src-line${line.status === 'equal' ? '' : ` vd-src-${line.status}`}`}
            data-lines={`${lineNo}-${lineNo}`}
            data-side={fromBase ? 'base' : undefined}
            data-change={line.change}
          >
            <span className="vd-src-no">{lineNo}</span>
            <span className="vd-src-sign">{line.status === 'added' ? '+' : line.status === 'removed' ? '−' : ' '}</span>
            <span className="vd-src-text" dangerouslySetInnerHTML={{ __html: (coloredLine ?? escape(line.text)) || ' ' }} />
          </div>
        )
      })}
    </div>
  )
}

function ImageBody({ spec }: { spec: DisplaySpec }): React.ReactElement {
  const changed = spec.base !== null && spec.base !== spec.current
  const [before, setBefore] = useState(false)
  const [actual, setActual] = useState(false)
  useEffect(() => setBefore(false), [spec.current])
  const src = before && spec.base ? spec.base : spec.current
  return (
    <div className="vd-image">
      {changed && (
        <div className="vd-image-bar" data-change="1">
          <span className="vd-badge">Changed since last show</span>
          <button className={before ? '' : 'on'} onClick={() => setBefore(false)}>After</button>
          <button className={before ? 'on' : ''} onClick={() => setBefore(true)}>Before</button>
        </div>
      )}
      <div className={`vd-image-frame${actual ? ' actual' : ''}`} onClick={() => setActual((a) => !a)} title={actual ? 'Fit to window' : 'Actual size'}>
        <img src={src} alt={spec.relPath} />
      </div>
    </div>
  )
}

export const DocumentView = forwardRef<HTMLDivElement, { spec: DisplaySpec; onMouseUp: () => void; onMouseDown: () => void }>(
  function DocumentView({ spec, onMouseUp, onMouseDown }, ref) {
    // Links never navigate the window: external ones open in the browser, the rest do nothing.
    const onClick = (e: React.MouseEvent): void => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (/^(https?|mailto):/i.test(href)) window.open(href)
    }
    return (
      <div className="vd-scroll" ref={ref} onMouseUp={onMouseUp} onMouseDown={onMouseDown} onClick={onClick}>
        {spec.kind === 'image' ? <ImageBody spec={spec} />
          : spec.kind === 'markdown' && spec.view === 'rendered' ? <MarkdownBody spec={spec} />
          : <SourceBody spec={spec} />}
      </div>
    )
  }
)
