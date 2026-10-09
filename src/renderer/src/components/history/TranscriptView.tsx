import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { buildTranscriptRows, toolLabel, transcriptToMarkdown, type TranscriptRow } from './transcriptRows'
import { languageForPath, useHighlightedCode, useMarkdownHtml } from './markdown'
import { diffLines } from './lineDiff'
import './transcript.css'

const MAX_RESULT_CHARS = 100_000
const BOTTOM_THRESHOLD_PX = 100

/**
 * Read-only, virtualized transcript of an agent session.
 * Only rows in (and near) the viewport are mounted; row heights are measured
 * as they render, and expanded/collapsed state lives here so it survives rows
 * unmounting during scroll.
 */
export function TranscriptView({ entries, toolName, loading = false, resetKey }: {
  entries: HistoryEntry[]
  toolName: string
  loading?: boolean
  resetKey?: string | null
}): React.ReactElement {
  const rows = useMemo(() => buildTranscriptRows(entries), [entries])
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const openRef = useRef(new Set<string>())
  const [, setOpenVersion] = useState(0)

  useEffect(() => {
    atBottomRef.current = true
    openRef.current = new Set()
  }, [resetKey])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowHeight(rows[index]),
    getItemKey: (index) => rows[index].key,
    overscan: 8,
    paddingStart: 12,
    paddingEnd: 12
  })

  const totalSize = virtualizer.getTotalSize()
  // Follow the live tail while the user is at the bottom. Keep scrolling strictly
  // inside this widget: scrollIntoView() would also move ancestor containers.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && atBottomRef.current) element.scrollTop = element.scrollHeight
  }, [totalSize, rows.length])

  const toggle = useCallback((key: string) => {
    const open = openRef.current
    if (open.has(key)) open.delete(key)
    else open.add(key)
    setOpenVersion((version) => version + 1)
  }, [])

  const onScroll = (): void => {
    const element = scrollRef.current
    if (element) atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_THRESHOLD_PX
  }

  // Links open in the external browser (the window's open handler does that);
  // anything else, e.g. relative file links, must not navigate the window.
  const onClick = (event: React.MouseEvent): void => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank')
  }

  const body = loading
    ? <Empty text="Loading history…" />
    : rows.length === 0
      ? <Empty text="No messages found" />
      : <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>
            <Row row={row} toolName={toolName} open={openRef.current.has(row.key)} toggle={toggle} />
          </div>
        })}
      </div>

  return <div style={{ flex: '1 1 0', height: '100%', minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <div ref={scrollRef} onScroll={onScroll} onClick={onClick}
      style={{ flex: '1 1 0', minHeight: 0, overflowX: 'hidden', overflowY: 'auto', overscrollBehavior: 'contain', userSelect: 'text' }}>
      {body}
    </div>
    {!loading && rows.length > 0 && <CopyButton getText={() => transcriptToMarkdown(rows, toolName)} />}
  </div>
}

function estimateRowHeight(row: TranscriptRow): number {
  if (row.type === 'header') return row.first ? 26 : 38
  if (row.type === 'text') return 20 + Math.ceil(row.text.length / 100) * 20
  return 36
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div style={{ padding: '16px 20px', color: '#777', fontSize: 12 }}>{text}</div>
}

function CopyButton({ getText }: { getText: () => string }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return <button onClick={copy} title="Copy the whole transcript as Markdown"
    style={{ position: 'absolute', top: 6, right: 14, padding: '3px 8px', fontSize: 11, border: '1px solid #444', borderRadius: 3, background: 'rgba(37, 37, 38, 0.92)', color: copied ? '#4ec9b0' : '#999', cursor: 'pointer', fontFamily: 'Segoe UI, sans-serif' }}>
    {copied ? 'Copied' : 'Copy as Markdown'}
  </button>
}

const ROW_PADDING = '3px 20px'

function Row({ row, toolName, open, toggle }: { row: TranscriptRow; toolName: string; open: boolean; toggle: (key: string) => void }): React.ReactElement {
  switch (row.type) {
    case 'header': {
      const isUser = row.role === 'user'
      return <div style={{ padding: row.first ? '2px 20px 4px' : '10px 20px 4px', borderTop: row.first ? 'none' : '1px solid #252525', marginTop: row.first ? 0 : 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: isUser ? '#569cd6' : '#4ec9b0', userSelect: 'none' }}>
        {isUser ? 'You' : toolName || 'Assistant'}
      </div>
    }
    case 'text':
      return <div style={{ padding: ROW_PADDING }}><Markdown text={row.text} /></div>
    case 'thinking':
      return <div style={{ padding: ROW_PADDING }}>
        <Collapsible label="Thinking" color="#858585" open={open} toggle={() => toggle(row.key)}>
          <Markdown text={row.text} className="md md-thinking" />
        </Collapsible>
      </div>
    case 'tool':
      return <div style={{ padding: ROW_PADDING }}>
        <Collapsible label={`→ ${toolLabel(row.block)}`} color={toolColor(row.block)} open={open} toggle={() => toggle(row.key)}>
          <ToolBody block={row.block} result={row.result} />
        </Collapsible>
      </div>
    case 'result':
      return <div style={{ padding: ROW_PADDING }}>
        <Collapsible label="← result" color="#4ec9b0" open={open} toggle={() => toggle(row.key)}>
          <Output text={row.content} />
        </Collapsible>
      </div>
  }
}

function Markdown({ text, className = 'md' }: { text: string; className?: string }): React.ReactElement {
  const html = useMarkdownHtml(text)
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

function Collapsible({ label, color, open, toggle, children }: { label: string; color: string; open: boolean; toggle: () => void; children: React.ReactNode }): React.ReactElement {
  return <div style={{ border: '1px solid #3a3a3a', borderRadius: 4, overflow: 'hidden' }}>
    <div onClick={toggle} title={label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#252526', cursor: 'pointer', userSelect: 'none', minWidth: 0 }}>
      <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
      <span style={{ fontSize: 12, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Cascadia Code, Consolas, monospace' }}>{label}</span>
    </div>
    {open && <div style={{ padding: '8px 10px', background: '#1a1a1a', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>}
  </div>
}

function toolColor(block: HistoryBlock): string {
  switch (block.view?.kind) {
    case 'edit':
    case 'patch':
    case 'write': return '#dcdcaa'
    case 'shell':
    case 'script': return '#ce9178'
    case 'read':
    case 'search': return '#9cdcfe'
    default: return '#c586c0'
  }
}

function ToolBody({ block, result }: { block: HistoryBlock; result: string | null }): React.ReactElement {
  const view = block.view
  const resultSection = result === null
    ? <div style={{ color: '#666', fontSize: 11 }}>No result yet</div>
    : <Output text={result} />
  if (!view) {
    return <>
      <Code code={formatJson(block.input)} language="json" />
      {resultSection}
    </>
  }
  switch (view.kind) {
    case 'edit':
      return <>
        {view.edits.map((edit, index) => <Diff key={index} oldText={edit.oldText} newText={edit.newText} />)}
        {result !== null && <Output text={result} dim />}
      </>
    case 'patch':
      return <>
        <PatchView patch={view.patch} />
        {result !== null && <Output text={result} dim />}
      </>
    case 'write':
      return <>
        <Code code={view.content} language={languageForPath(view.path)} />
        {result !== null && <Output text={result} dim />}
      </>
    case 'shell':
      return <>
        <Code code={view.command} language="shell" />
        {resultSection}
      </>
    case 'script':
      return <>
        <Code code={view.code} language={view.language} />
        {resultSection}
      </>
    case 'read':
    case 'search':
      return resultSection
  }
}

function Code({ code, language }: { code: string; language: string }): React.ReactElement {
  const html = useHighlightedCode(code, language)
  return html
    ? <pre className="tx-code" dangerouslySetInnerHTML={{ __html: html }} />
    : <pre className="tx-code" style={{ color: '#d4d4d4' }}>{code}</pre>
}

function Output({ text, dim = false }: { text: string; dim?: boolean }): React.ReactElement {
  const shown = text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${text.length - MAX_RESULT_CHARS} more characters)`
    : text
  return <pre className="tx-code" style={{ color: dim ? '#808080' : '#b0b0b0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{shown || '(empty)'}</pre>
}

const DIFF_STYLES = {
  ' ': { color: '#9a9a9a', background: 'transparent' },
  '-': { color: '#f0a0a0', background: 'rgba(255, 80, 80, 0.12)' },
  '+': { color: '#a6e3a1', background: 'rgba(80, 200, 120, 0.12)' }
} as const

function Diff({ oldText, newText }: { oldText: string; newText: string }): React.ReactElement {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText])
  return <pre className="tx-code">
    {lines.map((line, index) => <div key={index} style={DIFF_STYLES[line.op]}>{line.op} {line.text}</div>)}
  </pre>
}

function PatchView({ patch }: { patch: string }): React.ReactElement {
  return <pre className="tx-code">
    {patch.split('\n').map((line, index) => {
      const style = line.startsWith('***') || line.startsWith('@@')
        ? { color: '#569cd6', background: 'transparent' }
        : line.startsWith('+') ? DIFF_STYLES['+'] : line.startsWith('-') ? DIFF_STYLES['-'] : DIFF_STYLES[' ']
      return <div key={index} style={style}>{line || ' '}</div>
    })}
  </pre>
}

function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
