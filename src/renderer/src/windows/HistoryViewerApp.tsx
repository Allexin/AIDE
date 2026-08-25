import React, { useEffect, useState } from 'react'
import { SessionHistory } from '../components/history/SessionHistory'

export default function HistoryViewerApp(): React.ReactElement {
  const [toolInfo, setToolInfo] = useState<{ title: string; toolName: string } | null>(null)
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  useEffect(() => {
    window.historyViewerApi.getData().then((data) => {
      setToolInfo({ title: data.title, toolName: data.toolName })
      setEntries(data.entries)
    })
    return window.historyViewerApi.onNewEntries((newEntries) => setEntries((previous) => [...previous, ...newEntries]))
  }, [])

  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#1e1e1e', color: '#d4d4d4', fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13 }}>
    <div style={{ padding: '10px 16px', borderBottom: '1px solid #3d3d3d', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#cccccc' }}>{toolInfo?.title || 'Session History'}</div>
      {toolInfo && <div style={{ fontSize: 11, color: '#666' }}>{entries.length} message{entries.length !== 1 ? 's' : ''} · {toolInfo.toolName}</div>}
    </div>
    <SessionHistory entries={entries} toolName={toolInfo?.toolName ?? ''} loading={toolInfo === null} />
  </div>
}
