import React, { useEffect, useState, useRef } from 'react'

interface DiskSession {
  sessionId: string
  summary: string  // session summary (type:"summary" JSONL entry), or empty
  title: string    // last user message, or empty
  mtime: number
}

interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  title?: string
}

interface SessionEntry {
  sessionId: string
  summary: string
  slug: string
  mtime: number
  openTabId: string | null
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
          summary: ds.summary ?? '',
          slug: ds.title,
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
          <div style={{ padding: 16, color: '#555', fontSize: 12 }}>Loading…</div>
        ) : sessions.length === 0 ? (
          <div style={{ padding: 16, color: '#555', fontSize: 12 }}>No sessions found</div>
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

interface PreviewMessage {
  role: 'user' | 'assistant'
  text: string
}

interface SessionRowProps {
  entry: SessionEntry
  onSelect: (entry: SessionEntry) => void
  disabled: boolean
}

function SessionRow({ entry, onSelect, disabled }: SessionRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  const [preview, setPreview] = useState<PreviewMessage[] | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMouseEnter = () => {
    setHovered(true)
    // Small delay before loading/showing preview to avoid flicker on fast mouse-overs
    hoverTimer.current = setTimeout(() => {
      if (preview === null && !loadingPreview) {
        setLoadingPreview(true)
        window.sessionPickerApi.getPreview(entry.sessionId).then((msgs) => {
          setPreview(msgs)
          setLoadingPreview(false)
        })
      }
    }, 200)
  }

  const handleMouseLeave = () => {
    setHovered(false)
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const showPreview = hovered && (loadingPreview || (preview !== null && preview.length > 0))

  return (
    <div style={{ borderBottom: '1px solid #2d2d2d' }}>
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={() => !disabled && onSelect(entry)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 16px',
          gap: 8,
          cursor: disabled ? 'default' : 'pointer',
          background: hovered && !disabled ? '#2a2d2e' : 'transparent'
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

        {/* Title block: CC summary + last user message */}
        <span style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {entry.summary ? (
            <>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: entry.openTabId ? '#d4d4d4' : '#b0b0b0'
                }}
              >
                {entry.summary}
              </span>
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  color: '#666'
                }}
              >
                {entry.slug || '—'}
              </span>
            </>
          ) : (
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: entry.openTabId ? '#d4d4d4' : '#9d9d9d'
              }}
            >
              {entry.slug || 'Claude Code'}
            </span>
          )}
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

      {/* Hover preview panel */}
      {showPreview && (
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          style={{
            padding: '4px 16px 8px 26px',
            background: '#181818',
            maxHeight: 220,
            overflowY: 'auto',
            fontSize: 11,
            lineHeight: '1.5',
            borderTop: '1px solid #2a2a2a'
          }}
        >
          {loadingPreview && preview === null ? (
            <span style={{ color: '#555' }}>Loading…</span>
          ) : preview && preview.length > 0 ? (
            preview.slice(-8).map((msg, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <span
                  style={{
                    color: msg.role === 'user' ? '#569cd6' : '#4ec9b0',
                    fontWeight: 600
                  }}
                >
                  {msg.role === 'user' ? 'You' : 'Claude'}:
                </span>{' '}
                <span
                  style={{
                    color: '#b0b0b0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {msg.text.length > 300 ? msg.text.slice(0, 300) + '…' : msg.text}
                </span>
              </div>
            ))
          ) : null}
        </div>
      )}
    </div>
  )
}
