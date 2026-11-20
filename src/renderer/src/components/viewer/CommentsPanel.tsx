import React, { useEffect, useRef } from 'react'
import type { ViewerComment } from '../../../../shared/viewer/compose'
import type { ViewerReplyTab } from '../../../../shared/viewer/types'
import type { Mark } from '../../../../shared/viewer/marks'

/** The comments panel on the right of the file viewer (docs/file-viewer-spec.md, "Comments"). */

interface Props {
  comments: ViewerComment[]
  editingId: string | null
  freeText: string
  reply: ViewerReplyTab
  sending: boolean
  notice: { text: string; error: boolean } | null
  collapsed: boolean
  onToggle: () => void
  onChange: (id: string, text: string) => void
  onDelete: (id: string) => void
  onFinishEdit: () => void
  onHover: (comment: ViewerComment | null) => void
  onFreeText: (text: string) => void
  onSend: () => void
  /** Marks mode: the marks as cards above the comments; null when the image is view-only. */
  marks: Mark[] | null
  selectedMarkId: string | null
  marksChanged: boolean
  onMarkText: (id: string, text: string) => void
  onMarkDelete: (id: string) => void
  onMarkSelect: (id: string | null) => void
  /** An HTML page is on screen: its text cannot be selected for comments. */
  pageView: boolean
}

const MARK_LABEL: Record<Mark['type'], string> = { text: 'Text', arrow: 'Arrow', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse' }

function MarkCard({ mark, selected, onText, onDelete, onSelect }: {
  mark: Mark
  selected: boolean
  onText: (id: string, text: string) => void
  onDelete: (id: string) => void
  onSelect: (id: string | null) => void
}): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  const value = mark.type === 'text' ? mark.text : (mark.note ?? '')
  useEffect(() => {
    // A new text mark is typed into right away.
    if (selected && mark.type === 'text' && !mark.text) ref.current?.focus()
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div className={`vc-card vc-mark by-${mark.by}${selected ? ' selected' : ''}`} onMouseEnter={() => onSelect(mark.id)}>
      <div className="vc-card-head">
        <span className="vc-lines">{MARK_LABEL[mark.type]} {mark.id}{mark.by === 'agent' ? ` · agent${mark.moved ? ', moved' : ''}` : ''}</span>
        <button className="vc-delete" title="Delete mark" onClick={() => onDelete(mark.id)}>×</button>
      </div>
      <textarea
        ref={ref}
        className="vc-text"
        value={value}
        placeholder={mark.type === 'text' ? 'Text on the image…' : 'Note…'}
        rows={Math.min(6, Math.max(1, value.split(/\n/).length))}
        onChange={(e) => onText(mark.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
        }}
      />
    </div>
  )
}

function linesLabel(c: ViewerComment): string {
  if (c.from === 'page') return 'from the page'
  if (!c.lines) return 'in removed text'
  return c.lines[0] === c.lines[1] ? `L${c.lines[0]}` : `L${c.lines[0]}–${c.lines[1]}`
}

function Card({ comment, editing, onChange, onDelete, onFinishEdit, onHover }: {
  comment: ViewerComment
  editing: boolean
  onChange: Props['onChange']
  onDelete: Props['onDelete']
  onFinishEdit: Props['onFinishEdit']
  onHover: Props['onHover']
}): React.ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) {
      ref.current?.focus()
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [editing])
  return (
    <div className="vc-card" onMouseEnter={() => onHover(comment)} onMouseLeave={() => onHover(null)}>
      <div className="vc-card-head">
        <span className="vc-lines">{linesLabel(comment)}</span>
        <button className="vc-delete" title="Delete comment" onClick={() => onDelete(comment.id)}>×</button>
      </div>
      <div className="vc-quote" title={comment.quote}>{comment.quote}</div>
      <textarea
        ref={ref}
        className="vc-text"
        value={comment.text}
        placeholder="Comment…"
        rows={Math.min(8, Math.max(2, comment.text.split('\n').length))}
        onChange={(e) => onChange(comment.id, e.target.value)}
        onBlur={onFinishEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() }
        }}
      />
    </div>
  )
}

export function CommentsPanel(props: Props): React.ReactElement {
  const { comments, collapsed, reply, sending, freeText, notice } = props
  if (collapsed) {
    return (
      <div className="vc-panel collapsed" onClick={props.onToggle} title="Show comments">
        <span className="vc-strip">Comments ({comments.length})</span>
      </div>
    )
  }
  const files = [...new Set(comments.map((c) => c.path))]
  const canSend = reply.available && !sending && (comments.length > 0 || freeText.trim() !== '' || props.marksChanged)
  return (
    <div className="vc-panel">
      <div className="vc-header">
        <span>Comments ({comments.length})</span>
        <button className="vc-collapse" title="Hide comments" onClick={props.onToggle}>›</button>
      </div>
      <div className="vc-list">
        {props.marks !== null && (
          <div className="vc-file">
            <div className="vc-file-name">Marks ({props.marks.length})</div>
            {props.marks.length === 0 && <div className="vc-empty">Pick a tool above the image and draw on it.</div>}
            {props.marks.map((m) => (
              <MarkCard key={m.id} mark={m} selected={props.selectedMarkId === m.id}
                onText={props.onMarkText} onDelete={props.onMarkDelete} onSelect={props.onMarkSelect} />
            ))}
          </div>
        )}
        {comments.length === 0 && props.marks === null && <div className="vc-empty">{props.pageView ? 'What the page sends shows up here. Write anything else below.' : 'Select text in the document and press Comment.'}</div>}
        {files.map((path) => (
          <div key={path} className="vc-file">
            {files.length > 1 && <div className="vc-file-name">{path}</div>}
            {comments.filter((c) => c.path === path).map((c) => (
              <Card
                key={c.id}
                comment={c}
                editing={props.editingId === c.id}
                onChange={props.onChange}
                onDelete={props.onDelete}
                onFinishEdit={props.onFinishEdit}
                onHover={props.onHover}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="vc-footer">
        <textarea
          className="vc-free"
          value={freeText}
          placeholder="Anything else for the agent…"
          rows={3}
          onChange={(e) => props.onFreeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey && canSend) { e.preventDefault(); props.onSend() }
          }}
        />
        <div className="vc-send-row">
          <span className={`vc-notice${notice?.error ? ' error' : ''}`}>
            {notice?.text ?? (reply.available ? `To: ${reply.title ?? 'agent tab'}` : 'No agent tab to reply to')}
          </span>
          <button className="vc-send" disabled={!canSend} onClick={props.onSend} title="Send to the agent (Ctrl+Enter)">
            {sending ? 'Sending…' : `Send${comments.length ? ` (${comments.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
