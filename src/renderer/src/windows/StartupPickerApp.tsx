import React, { useEffect, useMemo, useRef, useState } from 'react'
import { SessionHistory } from '../components/history/SessionHistory'

function formatTime(mtime: number): string {
  if (!mtime) return 'Previous tab'
  const elapsed = Date.now() - mtime
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return new Date(mtime).toLocaleDateString()
}

export default function StartupPickerApp(): React.ReactElement {
  const [data, setData] = useState<StartupPickerData | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [newToolId, setNewToolId] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const historyRequest = useRef(0)

  useEffect(() => { window.startupPickerApi.getData().then((value) => {
    if (!value) return
    setData(value); setNewToolId(value.defaultToolId); setFocusedKey(value.initialSessionKey)
  }) }, [])

  useEffect(() => {
    const request = ++historyRequest.current
    if (!focusedKey) { setHistory([]); setHistoryLoading(false); return }
    setHistory([]); setHistoryLoading(true)
    window.startupPickerApi.getHistory(focusedKey).then((entries) => {
      if (request === historyRequest.current) { setHistory(entries); setHistoryLoading(false) }
    })
  }, [focusedKey])

  const focused = data?.candidates.find((candidate) => candidate.key === focusedKey) ?? null
  const selectedCount = selectedKeys.size
  const title = useMemo(() => data?.candidates.some((candidate) => candidate.key.startsWith('saved:')) ? 'Tabs from the previous AIDE session' : 'Recent sessions', [data])
  const toggle = (candidate: StartupPickerCandidate): void => {
    if (!candidate.available) return
    setFocusedKey(candidate.key)
    setSelectedKeys((previous) => { const next = new Set(previous); next.has(candidate.key) ? next.delete(candidate.key) : next.add(candidate.key); return next })
  }
  const confirm = (): void => {
    if (busy || !data) return
    setBusy(true)
    void window.startupPickerApi.confirm([...selectedKeys], newToolId)
  }

  return <div style={{ width: '100%', height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#d4d4d4', fontFamily: 'Segoe UI, sans-serif', fontSize: 13 }}>
    <div style={{ flexShrink: 0, padding: '14px 18px 12px', borderBottom: '1px solid #3d3d3d' }}><div style={{ fontSize: 16, fontWeight: 600 }}>Start project</div><div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>Select sessions to restore, or leave everything unchecked to start a new session.</div></div>
    <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden', display: 'grid', gridTemplateColumns: '360px minmax(0, 1fr)' }}>
      <div style={{ height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', borderRight: '1px solid #3d3d3d', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '9px 14px', color: '#999', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #2d2d2d' }}>{title}</div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {!data ? <Empty text="Loading sessions…" /> : data.candidates.length === 0 ? <Empty text="No previous sessions found" /> : data.candidates.map((candidate) => <div key={candidate.key} onClick={() => setFocusedKey(candidate.key)} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderBottom: '1px solid #292929', background: candidate.key === focusedKey ? '#37373d' : 'transparent', cursor: 'pointer', opacity: candidate.available ? 1 : 0.55 }}>
            <input type="checkbox" checked={selectedKeys.has(candidate.key)} disabled={!candidate.available || busy} onClick={(event) => event.stopPropagation()} onChange={() => toggle(candidate)} style={{ marginTop: 3 }} />
            <div style={{ minWidth: 0, flex: 1 }}><div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ddd' }}>{candidate.firstMessage || candidate.title || 'Untitled session'}</div>{candidate.firstMessage && candidate.title !== candidate.firstMessage && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#777', fontSize: 11, marginTop: 2 }}>{candidate.title}</div>}<div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: '#666', fontSize: 10, marginTop: 4 }}><span>{candidate.toolName}</span><span>{candidate.unavailableReason ?? formatTime(candidate.mtime)}</span></div></div>
          </div>)}
        </div>
      </div>
      <div style={{ height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', fontFamily: 'Cascadia Code, Consolas, monospace' }}>
        <div style={{ flexShrink: 0, padding: '10px 16px', minHeight: 49, boxSizing: 'border-box', borderBottom: '1px solid #2d2d2d' }}><div style={{ fontWeight: 600, color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{focused?.firstMessage || focused?.title || 'Session history'}</div>{focused && <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>{history.length} message{history.length !== 1 ? 's' : ''} · {focused.toolName}</div>}</div>
        {focused ? <SessionHistory entries={history} toolName={focused.toolName} loading={historyLoading} resetKey={focused.key} /> : <Empty text="Select a session to view its full history" />}
      </div>
    </div>
    <div style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid #3d3d3d', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: selectedCount > 0 ? '#666' : '#aaa' }}><span>New session CLI:</span><select value={newToolId} disabled={busy || selectedCount > 0} onChange={(event) => setNewToolId(event.target.value)} style={{ background: '#252526', color: '#ddd', border: '1px solid #555', borderRadius: 3, padding: '5px 8px' }}>{data?.tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></div>
      <button disabled={busy || !data} onClick={confirm} style={{ minWidth: 150, padding: '7px 16px', border: 0, borderRadius: 3, background: '#0e639c', color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.65 : 1 }}>{busy ? 'Starting…' : selectedCount > 0 ? `Restore ${selectedCount} tab${selectedCount === 1 ? '' : 's'}` : 'Start new session'}</button>
    </div>
  </div>
}

function Empty({ text }: { text: string }): React.ReactElement { return <div style={{ padding: 18, color: '#666', fontSize: 12 }}>{text}</div> }
