import React, { useCallback, useEffect, useRef, useState } from 'react'

const PAGE_SIZE = 30

interface PickerSession {
  sessionId: string
  summary: string
  firstMessage: string
  title: string
  mtime: number
  toolId: string
}

interface SessionTabInfo {
  tabId: string
  sessionId: string | null
  title?: string
}

interface SessionEntry {
  sessionId: string
  summary: string
  firstMessage: string
  slug: string
  mtime: number
  toolId: string
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

function toEntry(ps: PickerSession, openTabs: SessionTabInfo[]): SessionEntry {
  const openTab = openTabs.find((t) => t.sessionId === ps.sessionId)
  return {
    sessionId: ps.sessionId,
    summary: ps.summary ?? '',
    firstMessage: ps.firstMessage ?? '',
    slug: ps.title,
    mtime: ps.mtime,
    toolId: ps.toolId,
    openTabId: openTab ? openTab.tabId : null
  }
}

export default function SessionPickerApp(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const openTabsRef = useRef<SessionTabInfo[]>([])
  const offsetRef = useRef(0)

  // Tool selector state
  const [activatedTools, setActivatedTools] = useState<{ id: string; name: string }[]>([])
  const [defaultToolId, setDefaultToolId] = useState<string | null>(null)
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false)

  useEffect(() => {
    window.sessionPickerApi.getSessions(0, PAGE_SIZE).then(({ sessions, openTabs, total }) => {
      openTabsRef.current = openTabs
      offsetRef.current = sessions.length
      setSessions(sessions.map((ps) => toEntry(ps, openTabs)))
      setHasMore(sessions.length < total)
      setLoading(false)
    })

    Promise.all([
      window.sessionPickerApi.getActivatedTools(),
      window.sessionPickerApi.getCliTools(),
      window.sessionPickerApi.getDefaultToolId()
    ]).then(([activated, allTools, defaultId]) => {
      const active = allTools.filter((t) => activated.includes(t.id))
      setActivatedTools(active)
      const effectiveId = (defaultId && activated.includes(defaultId))
        ? defaultId
        : active[0]?.id ?? null
      setDefaultToolId(effectiveId)
    })
  }, [])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const offset = offsetRef.current
    window.sessionPickerApi.getSessions(offset, PAGE_SIZE).then(({ sessions, total }) => {
      const tabs = openTabsRef.current
      setSessions((prev) => [...prev, ...sessions.map((ps) => toEntry(ps, tabs))])
      offsetRef.current = offset + sessions.length
      setHasMore(offset + sessions.length < total)
      setLoadingMore(false)
    })
  }, [loadingMore, hasMore])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      loadMore()
    }
  }, [loadMore])

  const handleSelect = (entry: SessionEntry): void => {
    if (busy) return
    setBusy(true)
    if (entry.openTabId) {
      window.sessionPickerApi.switchTab(entry.openTabId)
    } else {
      window.sessionPickerApi.resumeSession(entry.sessionId, entry.toolId)
    }
  }

  const handleOpenHistory = useCallback((entry: SessionEntry): void => {
    const title = entry.summary || entry.slug || 'Session History'
    window.sessionPickerApi.openHistory(entry.sessionId, entry.toolId, title)
  }, [])

  const handleNewSession = useCallback((toolId?: string): void => {
    if (busy) return
    setBusy(true)
    window.sessionPickerApi.newSession(toolId ?? defaultToolId ?? undefined)
  }, [busy, defaultToolId])

  const handleSelectTool = useCallback((toolId: string): void => {
    setDefaultToolId(toolId)
    setToolDropdownOpen(false)
    window.sessionPickerApi.setDefaultToolId(toolId)
  }, [])

  const currentToolName = activatedTools.find((t) => t.id === defaultToolId)?.name

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
      <div style={{ flex: 1, overflowY: 'auto' }} onScroll={handleScroll}>
        {loading ? (
          <div style={{ padding: 16, color: '#555', fontSize: 12 }}>Loading…</div>
        ) : sessions.length === 0 ? (
          <div style={{ padding: 16, color: '#555', fontSize: 12 }}>No sessions found</div>
        ) : (
          <>
            {sessions.map((entry) => (
              <SessionRow
                key={entry.sessionId}
                entry={entry}
                toolName={activatedTools.find((t) => t.id === entry.toolId)?.name ?? entry.toolId}
                onSelect={handleSelect}
                onOpenHistory={handleOpenHistory}
                disabled={busy}
              />
            ))}
            {loadingMore && (
              <div style={{ padding: '8px 16px', color: '#555', fontSize: 12, textAlign: 'center' }}>
                Loading more…
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer: New session button with tool selector */}
      <div
        style={{
          padding: '8px 16px 12px',
          borderTop: '1px solid #3d3d3d',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 6
        }}
        onClick={() => setToolDropdownOpen(false)}
      >
        {currentToolName && (
          <span style={{ fontSize: 11, color: '#666', marginRight: 2 }}>
            {currentToolName}
          </span>
        )}

        <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'stretch' }}>
            <button
              onClick={() => handleNewSession()}
              disabled={busy}
              style={{
                background: '#0e639c',
                color: '#ffffff',
                border: 'none',
                borderRight: activatedTools.length > 1 ? '1px solid #0a5080' : 'none',
                borderRadius: activatedTools.length > 1 ? '3px 0 0 3px' : 3,
                padding: '5px 14px',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.6 : 1
              }}
            >
              New session
            </button>

            {activatedTools.length > 1 && (
              <button
                onClick={() => setToolDropdownOpen((o) => !o)}
                disabled={busy}
                title="Select tool"
                style={{
                  background: '#0e639c',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '0 3px 3px 0',
                  padding: '5px 8px',
                  fontSize: 10,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1
                }}
              >
                ▾
              </button>
            )}
          </div>

          {toolDropdownOpen && activatedTools.length > 1 && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                right: 0,
                marginBottom: 4,
                background: '#252526',
                border: '1px solid #454545',
                borderRadius: 3,
                zIndex: 100,
                minWidth: 140
              }}
            >
              {activatedTools.map((tool) => (
                <button
                  key={tool.id}
                  onClick={() => handleSelectTool(tool.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '7px 14px',
                    background: tool.id === defaultToolId ? '#37373d' : 'none',
                    border: 'none',
                    color: '#ccc',
                    fontSize: 12,
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#37373d' }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = tool.id === defaultToolId ? '#37373d' : 'none'
                  }}
                >
                  {tool.name}
                </button>
              ))}
            </div>
          )}
        </div>
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
  toolName: string
  onSelect: (entry: SessionEntry) => void
  onOpenHistory: (entry: SessionEntry) => void
  disabled: boolean
}

function SessionRow({ entry, toolName, onSelect, onOpenHistory, disabled }: SessionRowProps): React.ReactElement {
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
        window.sessionPickerApi.getPreview(entry.sessionId, entry.toolId).then((msgs) => {
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

        {/* Title block: first message / last message / CLI name */}
        <span style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {/* Line 1: first user message (primary identifier, as shown in CLI) */}
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: entry.openTabId ? '#d4d4d4' : '#b0b0b0'
            }}
          >
            {entry.firstMessage || entry.slug || '—'}
          </span>
          {/* Line 2: last user message (only when different from first) */}
          {entry.slug && entry.slug !== entry.firstMessage && (
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 11,
                color: '#666'
              }}
            >
              {entry.slug}
            </span>
          )}
          {/* Line 3: CLI name */}
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 10,
              color: '#444'
            }}
          >
            {toolName}
          </span>
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

        {/* History button */}
        <button
          title="View full history"
          onClick={(e) => { e.stopPropagation(); onOpenHistory(entry) }}
          style={{
            background: 'none',
            border: 'none',
            padding: '2px 4px',
            cursor: 'pointer',
            color: hovered ? '#888' : 'transparent',
            fontSize: 13,
            flexShrink: 0,
            lineHeight: 1,
            borderRadius: 3,
            transition: 'color 0.1s'
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#cccccc' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = hovered ? '#888' : 'transparent' }}
        >
          ☰
        </button>
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
          <div style={{ color: '#444', fontSize: 10, marginBottom: 6, fontFamily: 'monospace' }}>
            {entry.sessionId}
          </div>
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
                  {msg.role === 'user' ? 'You' : toolName}:
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
