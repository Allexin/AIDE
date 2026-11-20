import React, { useEffect, useState } from 'react'
import { hasTasksTab, useTaskStore } from '../../store/useTaskStore'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useEditorStore } from '../../store/useEditorStore'
import { useMarkdownHtml } from '../history/markdown'
import '../history/transcript.css'
import { rankAtEnd, rankMoves } from './taskRank'
import type { TaskBoard, TaskBoardItem, TaskDetail, TaskSearchHit, TaskStatus, TaskWriteResult } from '../../../../shared/task'

/**
 * The Tasks tab of the terminal panel (docs/task-tracker-implementation.md §8): the
 * project's task tracker read from aide/tasks/. Left, the sections Now, Planned, Backlog,
 * Project and Decided against, or the hits of a search; right, the card of the selected
 * task with the changes the UI makes (tabs start tasks, agents close them).
 */

const STATUS_ICON: Record<TaskStatus, string> = { backlog: '○', planned: '○', active: '●', blocked: '!', done: '✓', cancelled: '–' }
const STATUS_COLOR: Record<TaskStatus, string> = { backlog: '#666', planned: '#9cdcfe', active: '#4ec9b0', blocked: '#f48771', done: '#4ec9b0', cancelled: '#666' }

const buttonStyle: React.CSSProperties = { background: '#3c3c3c', color: '#ccc', border: '1px solid #555', borderRadius: 3, padding: '3px 10px', fontSize: 12, cursor: 'pointer' }
const primaryStyle: React.CSSProperties = { ...buttonStyle, background: '#0e639c', color: '#fff', borderColor: '#0e639c' }
const inputStyle: React.CSSProperties = { width: '100%', padding: '3px 6px', color: '#d4d4d4', background: '#1e1e1e', border: '1px solid #555', borderRadius: 3, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12 }
const headingStyle: React.CSSProperties = { padding: '10px 10px 2px', color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }
const subheadingStyle: React.CSSProperties = { padding: '5px 10px 1px', color: '#9cdcfe', fontSize: 11 }
const quietStyle: React.CSSProperties = { padding: '2px 10px', color: '#777' }
const tabStyle = (isActive: boolean, color: string): React.CSSProperties => ({ background: isActive ? '#1e1e1e' : '#2d2d2d', color, fontSize: 12, padding: '4px 8px', borderRadius: '3px 3px 0 0', cursor: 'pointer', border: '1px solid #3d3d3d', borderBottom: isActive ? '1px solid #1e1e1e' : 'none', whiteSpace: 'nowrap', lineHeight: 1.5, flexShrink: 0, userSelect: 'none' })

/** The Tasks tab button, next to the pipeline tab button; shown when the project has aide/tasks/. */
export function TasksTabButton({ isActive, onSelect }: { isActive: boolean; onSelect: () => void }): React.ReactElement | null {
  const board = useTaskStore((s) => s.board)
  if (!board || !hasTasksTab({ board })) return null
  const problems = board.problems.length
  const color = problems && !isActive ? '#f0a500' : isActive ? '#d4d4d4' : '#858585'
  const title = `Task tracker: ${board.active.length} active, ${board.planned.length} planned${problems ? `, ${problems} problem${problems === 1 ? '' : 's'}` : ''}`
  return <div onClick={onSelect} title={title} style={tabStyle(isActive, color)}>Tasks{board.active.length ? ` ${board.active.length}` : ''}{problems ? ' !' : ''}</div>
}

/** Writes from the tab: the error stays on screen until the next write. */
function useWrite(): { error: string | null; write: (action: () => Promise<TaskWriteResult>) => Promise<TaskWriteResult>; clear: () => void } {
  const [error, setError] = useState<string | null>(null)
  const write = async (action: () => Promise<TaskWriteResult>): Promise<TaskWriteResult> => {
    let result: TaskWriteResult
    try {
      result = await action()
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    setError(result.error)
    return result
  }
  return { error, write, clear: () => setError(null) }
}

/** Opens a project-relative path (an optional "#anchor" is dropped) in the editor. */
function openInEditor(projectPath: string | null, path: string): void {
  if (!projectPath) return
  const relative = path.split('#')[0].replace(/^\.?[\\/]+/, '').replace(/\\/g, '/')
  if (!relative) return
  const sep = projectPath.includes('\\') ? '\\' : '/'
  useEditorStore.getState().openFileInEditor(`${projectPath}${sep}${relative.split('/').join(sep)}`, relative)
}

export default function TasksView(): React.ReactElement {
  const board = useTaskStore((s) => s.board)
  const selectedId = useTaskStore((s) => s.selectedId)
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState(false)
  const searching = query.trim() !== '' || history
  return <div style={{ position: 'absolute', inset: 0, display: 'flex', background: '#1e1e1e', fontFamily: 'Segoe UI, sans-serif', color: '#ccc', fontSize: 12 }}>
    <div style={{ width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333' }}>
      <div style={{ flexShrink: 0, padding: '6px 10px', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" style={inputStyle} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#999', cursor: 'pointer' }}>
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Include history
        </label>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
        {searching ? <SearchHits query={query} history={history} /> : board ? <Sections board={board} /> : <div style={quietStyle}>Loading…</div>}
      </div>
    </div>
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
      {selectedId ? <TaskCard key={selectedId} id={selectedId} /> : <div style={{ padding: 16, color: '#777' }}>Select a task to see its card.</div>}
    </div>
  </div>
}

function SearchHits({ query, history }: { query: string; history: boolean }): React.ReactElement {
  const version = useTaskStore((s) => s.version)
  const [hits, setHits] = useState<TaskSearchHit[] | null>(null)
  useEffect(() => {
    let alive = true
    void window.editorApi.tasksSearch(query, history).then((result) => { if (alive) setHits(result) })
    return () => { alive = false }
  }, [query, history, version])
  if (!hits) return <div style={quietStyle}>Searching…</div>
  if (!hits.length) return <div style={quietStyle}>No task matches.</div>
  return <>
    <div style={headingStyle}>Found {hits.length}{hits.length === 50 ? ' (the first 50)' : ''}</div>
    {hits.map((hit) => <Row key={hit.id} id={hit.id} status={hit.status} title={hit.label ?? hit.title}
      note={[hit.history ? 'in history' : hit.status, hit.claimFirstLine].filter(Boolean).join(' · ')} />)}
  </>
}

function Row({ id, status, title, note, drag }: { id: string; status: TaskStatus; title: string; note?: string | null; drag?: DragProps }): React.ReactElement {
  const selected = useTaskStore((s) => s.selectedId === id)
  return <div onClick={() => useTaskStore.getState().select(id)} {...drag?.handlers}
    style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 10px', cursor: drag ? 'grab' : 'pointer', background: selected ? '#37373d' : undefined, borderTop: `2px solid ${drag?.before ? '#0e639c' : 'transparent'}`, borderBottom: `2px solid ${drag?.after ? '#0e639c' : 'transparent'}` }}>
    <span style={{ width: 14, textAlign: 'center', flexShrink: 0, color: STATUS_COLOR[status] }}>{STATUS_ICON[status]}</span>
    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <span style={{ color: status === 'done' || status === 'cancelled' ? '#bbb' : '#ccc' }}>{title}</span>
      {note && <span style={{ color: '#777' }}> — {note}</span>}
    </span>
  </div>
}

interface DragProps {
  handlers: Pick<React.HTMLAttributes<HTMLDivElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDrop' | 'onDragEnd'>
  before: boolean
  after: boolean
}

function Sections({ board }: { board: TaskBoard }): React.ReactElement {
  const nothingNow = !board.problems.length && !board.active.length && !board.blocked.length
  return <>
    <div style={headingStyle}>Now</div>
    {board.problems.map((problem, index) => <div key={index} style={{ padding: '2px 10px', color: '#f0c674', overflowWrap: 'anywhere' }}>! {problem}</div>)}
    {board.active.map((task) => <Row key={task.id} id={task.id} status={task.status} title={task.title} note={task.workers.length ? task.workers.join(', ') : 'nobody'} />)}
    {board.blocked.map((task) => <Row key={task.id} id={task.id} status={task.status} title={task.title} note={task.reason ?? 'no reason given'} />)}
    {nothingNow && <div style={quietStyle}>Nothing active.</div>}

    <div style={headingStyle}>Planned ({board.planned.length})</div>
    <QuickAdd status="planned" items={board.planned} />
    <RankedList items={board.planned} />

    <div style={headingStyle}>Backlog ({board.backlog.length})</div>
    <QuickAdd status="backlog" items={board.backlog} />
    <RankedList items={board.backlog} />

    <div style={headingStyle}>Project</div>
    {!board.project.length && <div style={quietStyle}>No claims yet.</div>}
    {board.project.map((group) => <React.Fragment key={group.tag}>
      <div style={subheadingStyle}>{group.tag}</div>
      {group.items.map((task) => <Row key={task.id} id={task.id} status={task.status} title={task.label ?? task.title}
        note={[task.reopened ? 'reopened' : null, task.unverified ? 'unverified' : null, task.claimFirstLine].filter(Boolean).join(' · ')} />)}
    </React.Fragment>)}

    <div style={headingStyle}>Decided against ({board.decidedAgainst.length})</div>
    {!board.decidedAgainst.length && <div style={quietStyle}>Nothing.</div>}
    {board.decidedAgainst.map((task) => <Row key={task.id} id={task.id} status={task.status} title={task.label ?? task.title} note={task.decidedAgainst} />)}
  </>
}

/** Planned or Backlog: drag a task to another place to give it a rank between its new neighbours. */
function RankedList({ items }: { items: TaskBoardItem[] }): React.ReactElement {
  const [dragged, setDragged] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const { error, write } = useWrite()
  const drop = async (): Promise<void> => {
    const id = dragged
    const at = dropAt
    setDragged(null)
    setDropAt(null)
    if (id === null || at === null) return
    const from = items.findIndex((item) => item.id === id)
    // `at` is a place in the list as shown; rankMoves counts places without the moved task.
    const moves = rankMoves(items, id, at > from ? at - 1 : at)
    const revisions = new Map(items.map((item) => [item.id, item.revision]))
    for (const move of moves) {
      const result = await write(() => window.editorApi.tasksUpdate(move.id, revisions.get(move.id)!, { rank: move.rank }))
      if (result.error) return
    }
  }
  if (!items.length) return <div style={quietStyle}>None.</div>
  return <>
    {error && <div style={{ padding: '2px 10px', color: '#f48771', overflowWrap: 'anywhere' }}>{error}</div>}
    {items.map((task, index) => {
      const drag: DragProps = {
        before: dragged !== null && dropAt === index,
        after: dragged !== null && index === items.length - 1 && dropAt === items.length,
        handlers: {
          draggable: true,
          onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', task.id); setDragged(task.id) },
          onDragOver: (e) => {
            if (dragged === null) return
            e.preventDefault()
            const box = e.currentTarget.getBoundingClientRect()
            setDropAt(e.clientY < box.top + box.height / 2 ? index : index + 1)
          },
          onDrop: (e) => { e.preventDefault(); void drop() },
          onDragEnd: () => { setDragged(null); setDropAt(null) }
        }
      }
      return <Row key={task.id} id={task.id} status={task.status} title={task.title} note={task.tags.length ? task.tags.join(', ') : null} drag={drag} />
    })}
  </>
}

/** A title field at the top of Planned or Backlog: Enter creates the task, its id made from the title. */
function QuickAdd({ status, items }: { status: 'planned' | 'backlog'; items: TaskBoardItem[] }): React.ReactElement {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const { error, write } = useWrite()
  const create = async (): Promise<void> => {
    if (!title.trim() || busy) return
    setBusy(true)
    const rank = rankAtEnd(items)
    const result = await write(() => window.editorApi.tasksCreate({ title, status, ...(rank !== null ? { rank } : {}) }))
    setBusy(false)
    if (result.error) return
    setTitle('')
    if (result.id) useTaskStore.getState().select(result.id)
  }
  return <div style={{ padding: '2px 10px 4px' }}>
    <input value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
      placeholder={`Add a ${status} task: title, then Enter`} style={inputStyle} />
    {error && <div style={{ color: '#f48771', marginTop: 2, overflowWrap: 'anywhere' }}>{error}</div>}
  </div>
}

function TaskCard({ id }: { id: string }): React.ReactElement {
  const version = useTaskStore((s) => s.version)
  const board = useTaskStore((s) => s.board)
  const projectPath = useFileTreeStore((s) => s.projectPath)
  const [detail, setDetail] = useState<TaskDetail | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const { error, write, clear } = useWrite()
  useEffect(() => {
    let alive = true
    void window.editorApi.tasksGet(id).then((result) => { if (alive) setDetail(result) })
    return () => { alive = false }
  }, [id, version])
  if (detail === undefined) return <div style={{ padding: 16, color: '#777' }}>Loading…</div>
  if (detail === null) return <div style={{ padding: 16, color: '#777' }}>Task "{id}" is no longer in aide/tasks/ or cannot be read.</div>
  const { task, revision, chain } = detail
  const inHistory = task.history !== null
  const workers = [...(board?.active ?? []), ...(board?.blocked ?? [])].find((item) => item.id === id)?.workers ?? []
  const update = (fields: Record<string, unknown>): Promise<TaskWriteResult> => write(() => window.editorApi.tasksUpdate(id, revision, fields))
  const toPlanned = (): void => {
    const rank = rankAtEnd(board?.planned ?? [])
    void update({ status: 'planned', ...(rank !== null ? { rank } : {}) })
  }
  const toBacklog = (): void => {
    const rank = rankAtEnd(board?.backlog ?? [])
    void update({ status: 'backlog', ...(rank !== null ? { rank } : {}) })
  }
  const open = (task.status === 'backlog' || task.status === 'planned' || task.status === 'active') && !inHistory
  const closed = task.status === 'done' || task.status === 'cancelled'
  const select = (other: string): void => useTaskStore.getState().select(other)

  return <div style={{ padding: '8px 14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>{task.title}</div>
      <div style={{ color: '#888' }}>
        <span style={{ color: STATUS_COLOR[task.status] }}>{task.status}</span>
        {task.reopened && ' · reopened'}{inHistory && ' · in history'}{task.rank !== null && ` · rank ${task.rank}`} · {task.id}
      </div>
    </div>

    {!editing && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {task.status === 'active' && !inHistory && <button style={buttonStyle} title="Back to planned; the tabs working on it let it go" onClick={toPlanned}>Pause</button>}
      {task.status === 'backlog' && !inHistory && <button style={buttonStyle} onClick={toPlanned}>Move to planned</button>}
      {task.status === 'planned' && !inHistory && <button style={buttonStyle} onClick={toBacklog}>Move to backlog</button>}
      {open && <button style={buttonStyle} onClick={() => { clear(); setBlocking(!blocking) }}>Block…</button>}
      {task.status === 'blocked' && !inHistory && task.blockedFrom && <button style={buttonStyle} title={`Back to ${task.blockedFrom}`} onClick={() => void update({ status: task.blockedFrom })}>Unblock</button>}
      {closed && !inHistory && <button style={buttonStyle} title="Out of the project's state: no longer true or no longer relevant" onClick={() => void write(() => window.editorApi.tasksToHistory(id))}>To history</button>}
      {inHistory && <button style={buttonStyle} onClick={() => void write(() => window.editorApi.tasksRestore(id))}>Restore</button>}
      <button style={buttonStyle} onClick={() => { clear(); setEditing(true) }}>Edit</button>
    </div>}
    {error && <div style={{ padding: '4px 8px', color: '#f48771', background: '#3a1f1f', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{error}</div>}
    {blocking && open && <BlockForm onBlock={async (reason) => { if (!(await update({ status: 'blocked', reason })).error) setBlocking(false) }} />}
    {editing && <EditForm title={task.title} tags={task.tags} description={task.description} onCancel={() => setEditing(false)}
      onSave={async (fields) => { if (!Object.keys(fields).length || !(await update(fields)).error) setEditing(false) }} />}

    {task.reason && <Field name={task.status === 'blocked' ? 'Blocked' : 'Reason'}>{task.reason}</Field>}
    {task.label && <Field name="Label">{task.label}</Field>}
    {task.claim && <Field name={`Claim${task.confirmed === null ? ' (unverified)' : ''}`}><span style={{ whiteSpace: 'pre-wrap' }}>{task.claim}</span></Field>}
    {task.decidedAgainst && <Field name="Decided against"><span style={{ whiteSpace: 'pre-wrap' }}>{task.decidedAgainst}</span></Field>}
    {task.history && <Field name="History">{task.history.reason}{task.history.by && <> — <Link onClick={() => select(task.history!.by!)}>{task.history.by}</Link></>}</Field>}
    {chain.earlier.length > 0 && <Field name="Supersedes">{chain.earlier.map((entry, index) => <React.Fragment key={entry.id}>{index > 0 && ', '}<Link onClick={() => select(entry.id)}>{entry.label ?? entry.title}</Link></React.Fragment>)}</Field>}
    {chain.later.length > 0 && <Field name="Superseded by">{chain.later.map((entry, index) => <React.Fragment key={entry.id}>{index > 0 && ', '}<Link onClick={() => select(entry.id)}>{entry.label ?? entry.title}</Link></React.Fragment>)}</Field>}
    {task.tags.length > 0 && <Field name="Tags">{task.tags.join(', ')}</Field>}
    {task.status === 'active' && <Field name="Working on it">{workers.length ? workers.join(', ') : 'No tab.'}</Field>}

    {!editing && <Section name="Description">
      {task.description.trim() ? <Description text={task.description} projectPath={projectPath} /> : <span style={{ color: '#777' }}>No description.</span>}
    </Section>}
    {task.docs.length > 0 && <Section name="Docs">
      {task.docs.map((doc) => <div key={doc}><Link title="Open in the editor" onClick={() => openInEditor(projectPath, doc)}>{doc}</Link></div>)}
    </Section>}
    {task.code.length > 0 && <Section name="Code">
      {task.code.map((glob) => <div key={glob} style={{ fontFamily: 'Cascadia Code, Consolas, monospace', color: '#bbb' }}>{glob}</div>)}
    </Section>}
    <Section name={`Journal (${task.journal.length})`}>
      {task.journal.map((line, index) => <div key={index} style={{ color: '#999', overflowWrap: 'anywhere' }}>{line}</div>)}
    </Section>
  </div>
}

function Field({ name, children }: { name: string; children: React.ReactNode }): React.ReactElement {
  return <div style={{ overflowWrap: 'anywhere' }}><span style={{ color: '#888' }}>{name}: </span>{children}</div>
}

function Section({ name, children }: { name: string; children: React.ReactNode }): React.ReactElement {
  return <div>
    <div style={{ color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3 }}>{name}</div>
    {children}
  </div>
}

function Link({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }): React.ReactElement {
  return <span onClick={onClick} title={title} style={{ color: '#4ea1f3', cursor: 'pointer' }}>{children}</span>
}

/** The description as Markdown; a link to a project file opens it in the editor, a web link in the browser. */
function Description({ text, projectPath }: { text: string; projectPath: string | null }): React.ReactElement {
  const html = useMarkdownHtml(text)
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^https?:/i.test(href)) window.open(href)
      return
    }
    let path = href
    try {
      path = decodeURI(href)
    } catch {
      // Not percent-encoded after all: the link as written.
    }
    openInEditor(projectPath, path)
  }
  return <div className="md" onClick={onClick} style={{ fontSize: 12 }} dangerouslySetInnerHTML={{ __html: html }} />
}

function BlockForm({ onBlock }: { onBlock: (reason: string) => Promise<void> }): React.ReactElement {
  const [reason, setReason] = useState('')
  return <div style={{ display: 'flex', gap: 6 }}>
    <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim()) void onBlock(reason) }}
      placeholder="Why is it blocked?" style={inputStyle} />
    <button style={primaryStyle} disabled={!reason.trim()} onClick={() => void onBlock(reason)}>Block</button>
  </div>
}

/** Quick edits of the title, the tags and the description; only the changed fields are written. */
function EditForm({ title, tags, description, onSave, onCancel }: { title: string; tags: string[]; description: string; onSave: (fields: Record<string, unknown>) => Promise<void>; onCancel: () => void }): React.ReactElement {
  const [newTitle, setTitle] = useState(title)
  const [newTags, setTags] = useState(tags.join(', '))
  const [newDescription, setDescription] = useState(description)
  const save = (): void => {
    const fields: Record<string, unknown> = {}
    if (newTitle.trim() !== title) fields.title = newTitle
    const tagList = newTags.split(',').map((tag) => tag.trim()).filter(Boolean)
    if (JSON.stringify(tagList) !== JSON.stringify(tags)) fields.tags = tagList
    if (newDescription !== description) fields.description = newDescription
    void onSave(fields)
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <input value={newTitle} onChange={(e) => setTitle(e.target.value)} placeholder="Title" style={inputStyle} />
    <input value={newTags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, separated by commas" style={inputStyle} />
    <textarea value={newDescription} onChange={(e) => setDescription(e.target.value)} placeholder="Description (Markdown)" style={{ ...inputStyle, minHeight: 140, resize: 'vertical', fontFamily: 'Cascadia Code, Consolas, monospace' }} />
    <div style={{ display: 'flex', gap: 6 }}>
      <button style={primaryStyle} onClick={save}>Save</button>
      <button style={buttonStyle} onClick={onCancel}>Cancel</button>
    </div>
  </div>
}
