import React, { useEffect, useState } from 'react'

interface DiskSession {
  sessionId: string
  slug: string | null
  mtime: number
}

interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  slug: string
}

interface SessionEntry {
  sessionId: string
  slug: string | null
  mtime: number
  openTabId: string | null // non-null if already open as a tab
}

function formatRelativeTime(mtime: number): string {
  const now = Date.now()
  const diff = now - mtime
  const min = Math.floor(diff / 60000)
  const hour = Math.floor(diff / 3600000)
  const day = Math.floor(diff / 86400000)

  if (min < 1) return 'Just now'
  if (min < 60) return `${min}m ago`
  if (hour < 24) {
    const d = new Date(mtime)
    return `Today ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (day === 1) return 'Yesterday'
  if (day < 7) return `${day} days ago`
  return new Date(mtime).toLocaleDateString()
}

export default function SessionPickerApp(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.sessionPickerApi.getSessions().then(({ diskSessions, openTabs }) => {
      const entries: SessionEntry[] = diskSessions.map((ds: DiskSession) => {
        const openTab = openTabs.find(
          (t: SessionTabInfo) => t.sessionId === ds.sessionId
        )
        return {
          sessionId: ds.sessionId,
          slug: ds.slug,
          mtime: ds.mtime,
          openTabId: openTab ? openTab.tabId : null
        }
      })
      setSessions(entries)
      setLoading(false)
    })
  }, [])

  const handleSelect = (entry: SessionEntry) => {
    if (busy) return
    setBusy(true)
    if (entry.openTabId) {
      window.sessionPickerApi.switchTab(entry.openTabId)
    } else {
      window.sessionPickerApi.resumeSession(entry.sessionId)
    }
  }

  const handleNewSession = () => {
    if (busy) return
    setBusy(true)
    window.sessionPickerApi.newSession()
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: '#1e1e1e',
        color: '#d4d4d4',
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: 13,
        userSelect: 'none'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px 8px',
          borderBottom: '1px solid #3d3d3d',
          fontSize: 14,
          fontWeight: 600,
          color: '#cccccc'
        }}
      >
        Sessions
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div
            style={{
              padding: 16,
              color: '#555',
              fontSize: 12
            }}
          >
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div
            style={{
              padding: 16,
              color: '#555',
              fontSize: 12
            }}
          >
            No sessions found
          </div>
        ) : (
          sessions.map((entry) => (
            <SessionRow
              key={entry.sessionId}
              entry={entry}
              onSelect={handleSelect}
              disabled={busy}
            />
          ))
        )}
      </div>

      {/* Footer: New session button */}
      <div
        style={{
          padding: '8px 16px 12px',
          borderTop: '1px solid #3d3d3d',
          display: 'flex',
          justifyContent: 'flex-end'
        }}
      >
        <button
          onClick={handleNewSession}
          disabled={busy}
          style={{
            background: '#0e639c',
            color: '#ffffff',
            border: 'none',
            borderRadius: 3,
            padding: '5px 14px',
            fontSize: 12,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1
          }}
        >
          New session
        </button>
      </div>
    </div>
  )
}

interface SessionRowProps {
  entry: SessionEntry
  onSelect: (entry: SessionEntry) => void
  disabled: boolean
}

function SessionRow({ entry, onSelect, disabled }: SessionRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => !disabled && onSelect(entry)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '8px 16px',
        gap: 8,
        cursor: disabled ? 'default' : 'pointer',
        background: hovered && !disabled ? '#2a2d2e' : 'transparent',
        borderBottom: '1px solid #2d2d2d'
      }}
    >
      {/* Running indicator */}
      <span
        style={{
          fontSize: 10,
          color: entry.openTabId ? '#4ec9b0' : 'transparent',
          flexShrink: 0,
          width: 10
        }}
      >
        ●
      </span>

      {/* Slug / session ID */}
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: entry.openTabId ? '#d4d4d4' : '#9d9d9d'
        }}
      >
        {entry.slug || entry.sessionId.slice(0, 8)}
      </span>

      {/* Relative time */}
      <span
        style={{
          fontSize: 11,
          color: '#555',
          flexShrink: 0,
          whiteSpace: 'nowrap'
        }}
      >
        {formatRelativeTime(entry.mtime)}
      </span>
    </div>
  )
}
