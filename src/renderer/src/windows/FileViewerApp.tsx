import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ViewerLivePayload, ViewerReplyTab, ViewerShowPayload } from '../../../shared/viewer/types'
import { composeMessage, type ViewerComment } from '../../../shared/viewer/compose'
import { DocumentView, type DisplaySpec } from '../components/viewer/DocumentView'
import { CommentsPanel } from '../components/viewer/CommentsPanel'
import { anchorElement, elementsFor, readSelection, type SelectionInfo } from '../components/viewer/selection'
import { MARK_TOOLS, MarkView, type MarkTool, type MarkViewHandle } from '../components/viewer/MarkView'
import { formatMarks, type Mark } from '../../../shared/viewer/marks'
import '../components/history/transcript.css'
import '../components/viewer/viewer.css'

/**
 * The file viewer window (docs/file-viewer-spec.md): what the agent showed with its changes
 * marked, live changes since the show, and comments sent back to the agent's tab.
 */

const api = window.fileViewerApi

function newId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export default function FileViewerApp(): React.ReactElement {
  const [show, setShow] = useState<ViewerShowPayload | null>(null)
  const [latestLive, setLatestLive] = useState<ViewerLivePayload | null>(null)
  const [appliedLive, setAppliedLive] = useState<ViewerLivePayload | null>(null)
  const [liveOn, setLiveOn] = useState(true)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [showRemoved, setShowRemoved] = useState(true)
  /** What the user marked as seen (the Seen button): the next marks are against it. Cleared by a new show. */
  const [seen, setSeen] = useState<{ content: string; startLine: number } | null>(null)
  const [reply, setReply] = useState<ViewerReplyTab>({ available: false })
  const [comments, setComments] = useState<ViewerComment[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [stops, setStops] = useState(0)
  const [stop, setStop] = useState(0)
  /** Marks mode (images the agent asked to mark up): the marks and the agent's originals. */
  const [marks, setMarks] = useState<Mark[] | null>(null)
  const [agentMarks, setAgentMarks] = useState<Mark[]>([])
  const [tool, setTool] = useState<MarkTool>('rect')
  const [selectedMark, setSelectedMark] = useState<string | null>(null)
  const markViewRef = useRef<MarkViewHandle>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const liveOnRef = useRef(liveOn)
  liveOnRef.current = liveOn
  const seqRef = useRef(0)
  /** Scroll target after the next render of a new show. */
  const pendingScroll = useRef<{ anchor: string | number | null } | null>(null)

  const applyShow = useCallback((payload: ViewerShowPayload | null) => {
    if (!payload || payload.seq <= seqRef.current) return
    seqRef.current = payload.seq
    setShow(payload)
    setLatestLive(null)
    setAppliedLive(null)
    setSeen(null)
    // A new show drops all marks: the kept ones are part of the image or passed again.
    setMarks(payload.marks ? payload.marks.map((m) => ({ ...m })) : null)
    setAgentMarks(payload.marks ?? [])
    setSelectedMark(null)
    setTool(payload.marks && payload.marks.length ? 'select' : 'rect')
    setReply(payload.reply)
    setNotice(null)
    pendingScroll.current = { anchor: payload.anchor }
  }, [])

  useEffect(() => {
    void api.getState().then(applyShow)
    const offShow = api.onShow(applyShow)
    const offLive = api.onLive((live) => {
      if (live.seq !== seqRef.current) return
      setLatestLive(live)
      if (liveOnRef.current) setAppliedLive(live)
    })
    const offReply = api.onReply(setReply)
    return () => { offShow(); offLive(); offReply() }
  }, [applyShow])

  useEffect(() => {
    document.title = show ? `${show.relPath} — Viewer` : 'Viewer'
  }, [show])

  /** Whether the marks differ from what the agent drew: something to send. */
  const marksChanged = marks !== null && JSON.stringify(marks.map(({ moved: _m, ...rest }) => rest)) !== JSON.stringify(agentMarks)

  // Unsent work is reported, so closing the project asks first.
  useEffect(() => {
    api.setPending(comments.length + (freeText.trim() ? 1 : 0) + (marksChanged ? 1 : 0))
  }, [comments.length, freeText, marksChanged])

  // Mark tools by key (V, T, A, L, R, E); Delete removes the selected mark.
  useEffect(() => {
    if (marks === null) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || e.ctrlKey || e.altKey || e.metaKey) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedMark) {
        e.preventDefault()
        setMarks((list) => (list ? list.filter((m) => m.id !== selectedMark) : list))
        setSelectedMark(null)
        return
      }
      if (e.key === 'Escape') { setSelectedMark(null); return }
      const t = MARK_TOOLS.find((x) => x.key === e.key.toLowerCase())
      if (t) setTool(t.tool)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [marks, selectedMark])

  const toggleLive = (on: boolean): void => {
    setLiveOn(on)
    if (on) setAppliedLive(latestLive)
  }

  // What is on screen: the live file when it moved on from the show, else what was shown.
  const liveMode = !!(show && appliedLive && appliedLive.content !== null && appliedLive.content !== show.shown)
  const current = show ? (liveMode && appliedLive?.content != null ? { text: appliedLive.content, startLine: appliedLive.startLine } : { text: show.shown, startLine: show.shownStartLine }) : null
  const spec: DisplaySpec | null = useMemo(() => {
    if (!show || !current) return null
    const common = { kind: show.kind, relPath: show.relPath, view, current: current.text, currentStartLine: current.startLine }
    if (seen) {
      return { ...common, base: seen.content === current.text ? null : seen.content, baseStartLine: seen.startLine }
    }
    if (liveMode) return { ...common, base: show.shown, baseStartLine: show.shownStartLine }
    return { ...common, base: show.base, baseStartLine: show.baseStartLine }
  }, [show, current?.text, current?.startLine, seen, liveMode, view]) // eslint-disable-line react-hooks/exhaustive-deps

  const markSeen = (): void => {
    if (current) setSeen({ content: current.text, startLine: current.startLine })
  }

  // After every render of the document: count the change stops; after a new show, scroll.
  useLayoutEffect(() => {
    const root = docRef.current
    if (!root) return
    let max = 0
    for (const el of Array.from(root.querySelectorAll('[data-change]'))) max = Math.max(max, Number(el.getAttribute('data-change')) || 0)
    setStops(max)
    const target = pendingScroll.current
    if (!target) return
    pendingScroll.current = null
    setStop(max > 0 ? 1 : 0)
    const el = (target.anchor !== null ? anchorElement(root, target.anchor) : null) ?? root.querySelector('[data-change="1"]')
    if (el) (el as HTMLElement).scrollIntoView({ block: 'center' })
    else root.scrollTop = 0
  }, [spec])

  const goTo = useCallback((n: number) => {
    const root = docRef.current
    if (!root || stops === 0) return
    const next = ((n - 1 + stops) % stops) + 1
    setStop(next)
    root.querySelector(`[data-change="${next}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [stops])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'F7') return
      e.preventDefault()
      goTo(e.shiftKey ? stop - 1 : stop + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, stop])

  // ── Comments ──
  const onDocMouseUp = (): void => {
    const root = docRef.current
    if (root) setSelection(readSelection(root))
  }
  const addComment = (): void => {
    if (!show || !selection) return
    const comment: ViewerComment = { id: newId(), path: show.relPath, shownAt: show.shownAt, quote: selection.quote, lines: selection.lines, text: '' }
    setComments((list) => [...list, comment])
    setEditingId(comment.id)
    setCollapsed(false)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }
  const highlighted = useRef<HTMLElement[]>([])
  const onHover = (comment: ViewerComment | null): void => {
    for (const el of highlighted.current) el.classList.remove('vd-hl')
    highlighted.current = []
    const root = docRef.current
    if (!comment || !root || comment.path !== show?.relPath) return
    const els = elementsFor(root, comment.lines, comment.quote)
    els.forEach((el) => el.classList.add('vd-hl'))
    highlighted.current = els
    els[0]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  const marksSection = async (): Promise<string> => {
    if (!show || marks === null || !marksChanged) return ''
    const handle = markViewRef.current
    const final = marks.filter((m) => m.type !== 'text' || m.text.trim())
    let snapshotPath: string | null = null
    try {
      const png = handle ? await handle.snapshot() : null
      if (png) snapshotPath = await api.saveMarksImage(png)
    } catch { /* the picture is a help; the marks go without it */ }
    return formatMarks({
      path: show.relPath,
      shownAt: show.shownAt,
      units: handle?.units() ?? 'image pixels',
      marks: final,
      removedAgent: agentMarks.filter((a) => !marks.some((m) => m.id === a.id)).map((a) => a.id),
      snapshotPath
    })
  }

  const send = async (): Promise<void> => {
    const text = composeMessage(comments, freeText, await marksSection())
    if (!text.trim()) return
    setSending(true)
    setNotice(null)
    try {
      const result = await api.send(text)
      if (result.ok) {
        setComments([])
        setFreeText('')
        // Sent marks are now the base: nothing new until the user changes them.
        if (marks) setAgentMarks(marks.map(({ moved: _m, ...rest }) => rest))
        setNotice({ text: 'Sent', error: false })
      } else {
        setNotice({ text: result.error ?? 'Not sent', error: true })
        if (result.error === 'Agent tab closed') setReply({ available: false })
      }
    } finally {
      setSending(false)
    }
  }

  const frozenChanged = !liveOn && latestLive !== null && latestLive !== appliedLive
  const problem = appliedLive?.content === null ? appliedLive.problem : null
  const status = !show ? ''
    : seen ? (spec?.base === null ? 'Seen' : 'Live: changes since seen')
    : liveMode ? 'Live: changes since shown'
    : show.base === null ? 'No base' : stops === 0 ? 'No changes since the previous show' : 'Changes since the previous show'

  return (
    <div className={`vw-root${showRemoved ? '' : ' vw-hide-removed'}`}>
      <div className="vw-main">
        <div className="vw-header">
          <span className="vw-path" title={show?.relPath}>{show?.relPath ?? 'Nothing shown yet'}</span>
          {show?.rangeLabel && <span className="vw-range" title="Only this part of the file is shown">{show.rangeLabel}</span>}
          <span className="vw-spacer" />
          {show && <span className={`vw-status${liveMode ? ' live' : ''}`}>{status}</span>}
          {frozenChanged && <span className="vw-frozen">File changed</span>}
          {problem && <span className="vw-problem">{problem}</span>}
          {show && (
            <span className="vw-nav">
              <button disabled={stops === 0} onClick={() => goTo(stop - 1)} title="Previous change (Shift+F7)">‹</button>
              <span>{stops === 0 ? '0 of 0' : `${stop} of ${stops}`}</span>
              <button disabled={stops === 0} onClick={() => goTo(stop + 1)} title="Next change (F7)">›</button>
            </span>
          )}
          {show && <button disabled={stops === 0} onClick={markSeen} title="Clear the marks: changes from now on are marked against what you see now">Seen</button>}
          <label className="vw-live" title="Show removed text. Uncheck to see only what is in the file now.">
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Removed
          </label>
          <label className="vw-live" title="Update the view while the file changes. Uncheck to freeze it, e.g. to copy text.">
            <input type="checkbox" checked={liveOn} onChange={(e) => toggleLive(e.target.checked)} /> Live
          </label>
          {show?.kind === 'markdown' && (
            <span className="vw-toggle">
              <button className={view === 'rendered' ? 'on' : ''} onClick={() => setView('rendered')}>Rendered</button>
              <button className={view === 'source' ? 'on' : ''} onClick={() => setView('source')}>Source</button>
            </span>
          )}
          {show && <button className="vw-open" onClick={() => api.openInEditor(show.relPath)}>Open in editor</button>}
        </div>
        {spec && marks !== null && (
          <div className="vm-tools">
            {MARK_TOOLS.map((t) => (
              <button key={t.tool} className={tool === t.tool ? 'on' : ''} onClick={() => setTool(t.tool)} title={`${t.label} (${t.key.toUpperCase()})`}>{t.label}</button>
            ))}
            <span className="vm-hint">{tool === 'select' ? 'Click a mark to select, drag to move, Delete to remove' : tool === 'text' ? 'Click where the text goes' : 'Drag on the image'}</span>
          </div>
        )}
        {spec && marks !== null
          ? <MarkView ref={markViewRef} src={spec.current} alt={spec.relPath} marks={marks} tool={tool} selectedId={selectedMark}
              onChange={setMarks} onSelect={setSelectedMark} />
          : spec
            ? <DocumentView ref={docRef} spec={spec} onMouseUp={onDocMouseUp} onMouseDown={() => setSelection(null)} />
            : <div className="vw-empty">The agent has not shown a file yet.</div>}
        {selection && show && (
          <button
            className="vw-comment-btn"
            style={{ left: Math.min(selection.rect.right + 6, window.innerWidth - 120), top: selection.rect.bottom + 4 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={addComment}
          >
            Comment
          </button>
        )}
      </div>
      <CommentsPanel
        comments={comments}
        editingId={editingId}
        freeText={freeText}
        reply={reply}
        sending={sending}
        notice={notice}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onChange={(id, text) => setComments((list) => list.map((c) => (c.id === id ? { ...c, text } : c)))}
        onDelete={(id) => setComments((list) => list.filter((c) => c.id !== id))}
        onFinishEdit={() => setEditingId(null)}
        onHover={onHover}
        onFreeText={setFreeText}
        onSend={() => void send()}
        marks={marks}
        selectedMarkId={selectedMark}
        marksChanged={marksChanged}
        onMarkText={(id, text) => setMarks((list) => list && list.map((m) => (m.id !== id ? m : m.type === 'text' ? { ...m, text } : { ...m, note: text || undefined })))}
        onMarkDelete={(id) => { setMarks((list) => list && list.filter((m) => m.id !== id)); setSelectedMark((s) => (s === id ? null : s)) }}
        onMarkSelect={setSelectedMark}
      />
    </div>
  )
}
