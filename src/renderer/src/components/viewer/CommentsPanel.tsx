import React, { useEffect, useRef } from 'react'
import type { ViewerComment } from '../../../../shared/viewer/compose'
import type { ViewerReplyTab } from '../../../../shared/viewer/types'

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
}

function linesLabel(c: ViewerComment): string {
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
  const canSend = reply.available && !sending && (comments.length > 0 || freeText.trim() !== '')
  return (
    <div className="vc-panel">
      <div className="vc-header">
        <span>Comments ({comments.length})</span>
        <button className="vc-collapse" title="Hide comments" onClick={props.onToggle}>›</button>
      </div>
      <div className="vc-list">
        {comments.length === 0 && <div className="vc-empty">Select text in the document and press Comment.</div>}
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
