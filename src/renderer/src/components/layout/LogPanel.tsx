import React, { useCallback, useEffect, useRef, useState } from 'react'
import { usePanelStore } from '../../store/usePanelStore'
import { useLogStore, LogChannel } from '../../store/useLogStore'

// ── Content context menu ──────────────────────────────────────────────────────

interface ContentContextMenuProps {
  x: number
  y: number
  hasSelection: boolean
  onCopy: () => void
  onCut: () => void
  onDelete: () => void
  onDismiss: () => void
}

function ContentContextMenu({
  x,
  y,
  hasSelection,
  onCopy,
  onCut,
  onDelete,
  onDismiss
}: ContentContextMenuProps): React.ReactElement {
  useEffect(() => {
    const handler = (): void => onDismiss()
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onDismiss])

  const itemStyle = (disabled: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    background: 'none',
    border: 'none',
    color: disabled ? '#555' : '#cccccc',
    cursor: disabled ? 'default' : 'pointer',
    padding: '6px 12px',
    textAlign: 'left',
    fontSize: 13
  })

  const hoverOn = (e: React.MouseEvent, disabled: boolean): void => {
    if (!disabled) (e.currentTarget as HTMLElement).style.background = '#04395e'
  }
  const hoverOff = (e: React.MouseEvent): void => {
    ;(e.currentTarget as HTMLElement).style.background = 'none'
  }

  return (
    <div
      onMouseDown={(e) => {
        // prevent focus change so text selection is preserved when clicking menu items
        e.preventDefault()
        e.stopPropagation()
      }}
      style={{
        position: 'fixed',
        top: y,
        left: x,
        background: '#252526',
        border: '1px solid #3d3d3d',
        borderRadius: 2,
        zIndex: 9999,
        minWidth: 100,
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)'
      }}
    >
      <button
        style={itemStyle(!hasSelection)}
        onClick={hasSelection ? onCopy : undefined}
        onMouseEnter={(e) => hoverOn(e, !hasSelection)}
        onMouseLeave={hoverOff}
      >
        Copy
      </button>
      <button
        style={itemStyle(!hasSelection)}
        onClick={hasSelection ? onCut : undefined}
        onMouseEnter={(e) => hoverOn(e, !hasSelection)}
        onMouseLeave={hoverOff}
      >
        Cut
      </button>
      <button
        style={itemStyle(!hasSelection)}
        onClick={hasSelection ? onDelete : undefined}
        onMouseEnter={(e) => hoverOn(e, !hasSelection)}
        onMouseLeave={hoverOff}
      >
        Delete Lines
      </button>
    </div>
  )
}

// ── Scrollable log list ───────────────────────────────────────────────────────

const PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '2px 8px',
  fontFamily: 'Cascadia Code, Consolas, monospace',
  fontSize: 12,
  lineHeight: '20px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: '#cccccc'
}

// Map a DOM selection within a <pre> element to [startLineIndex, endLineIndex]
function getSelectionLineRange(pre: HTMLPreElement): [number, number] | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!pre.contains(range.commonAncestorContainer)) return null

  const charOffset = (container: Node, offset: number): number => {
    const r = document.createRange()
    r.setStart(pre, 0)
    r.setEnd(container, offset)
    return r.toString().length
  }

  const startChar = charOffset(range.startContainer, range.startOffset)
  const endChar = charOffset(range.endContainer, range.endOffset)
  const text = pre.textContent ?? ''

  let lineIdx = 0
  let startLine = 0
  let endLine = 0
  let foundStart = false

  for (let i = 0; i <= text.length; i++) {
    if (!foundStart && i >= startChar) {
      startLine = lineIdx
      foundStart = true
    }
    if (foundStart && i >= endChar) {
      endLine = lineIdx
      break
    }
    if (i < text.length && text[i] === '\n') lineIdx++
  }

  return foundStart ? [startLine, endLine] : null
}

function ScrollableLogList({
  channelId,
  lines,
  dimmedSet
}: {
  channelId: string
  lines: string[]
  dimmedSet: Set<number> | null
}): React.ReactElement {
  const removeLines = useLogStore((s) => s.removeLines)
  const scrollRef = useRef<HTMLDivElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const atBottomRef = useRef(true)
  // Track what's already written to the DOM to enable incremental appends
  const renderedCountRef = useRef(0)
  const firstLineRef = useRef<string | undefined>(undefined)

  const [contentMenu, setContentMenu] = useState<{
    x: number
    y: number
    hasSelection: boolean
  } | null>(null)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  // Incremental DOM writes for non-dimmed mode — preserves active text selection
  useEffect(() => {
    if (dimmedSet !== null) return
    const pre = preRef.current
    if (!pre) return

    const needsReset =
      lines.length < renderedCountRef.current || lines[0] !== firstLineRef.current

    if (needsReset) {
      pre.textContent = lines.join('\n')
      renderedCountRef.current = lines.length
      firstLineRef.current = lines[0]
    } else if (lines.length > renderedCountRef.current) {
      const newText =
        (renderedCountRef.current === 0 ? '' : '\n') +
        lines.slice(renderedCountRef.current).join('\n')
      pre.appendChild(document.createTextNode(newText))
      renderedCountRef.current = lines.length
      firstLineRef.current = lines[0]
    }
  })

  // Reset DOM tracking when switching to/from dim mode or on explicit clear
  useEffect(() => {
    renderedCountRef.current = 0
    firstLineRef.current = undefined
  }, [dimmedSet])

  // Auto-scroll to bottom when new lines arrive (only if already at bottom)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [lines.length])

  const getActivePre = (): HTMLPreElement | null =>
    scrollRef.current?.querySelector('pre') ?? null

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const sel = window.getSelection()
    const hasSelection = !!(sel && !sel.isCollapsed && sel.toString().length > 0)
    setContentMenu({ x: e.clientX, y: e.clientY, hasSelection })
  }, [])

  const handleCopy = (): void => {
    const text = window.getSelection()?.toString() ?? ''
    navigator.clipboard.writeText(text)
    setContentMenu(null)
  }

  const handleCut = (): void => {
    const text = window.getSelection()?.toString() ?? ''
    navigator.clipboard.writeText(text)
    const pre = getActivePre()
    if (pre) {
      const range = getSelectionLineRange(pre)
      if (range) removeLines(channelId, range[0], range[1])
    }
    window.getSelection()?.removeAllRanges()
    setContentMenu(null)
  }

  const handleDelete = (): void => {
    const pre = getActivePre()
    if (pre) {
      const range = getSelectionLineRange(pre)
      if (range) removeLines(channelId, range[0], range[1])
    }
    window.getSelection()?.removeAllRanges()
    setContentMenu(null)
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onContextMenu={handleContextMenu}
      style={{ height: '100%', overflow: 'auto', userSelect: 'text' }}
    >
      {dimmedSet !== null ? (
        // Dim mode: React-managed spans, filtering active so selection less critical
        <pre style={PRE_STYLE}>
          {lines.map((line, i) => (
            <span key={i} style={{ opacity: dimmedSet.has(i) ? 0.15 : 1 }}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        // Normal mode: DOM-managed pre, React never touches its children
        <pre ref={preRef} style={PRE_STYLE} />
      )}
      {contentMenu && (
        <ContentContextMenu
          x={contentMenu.x}
          y={contentMenu.y}
          hasSelection={contentMenu.hasSelection}
          onCopy={handleCopy}
          onCut={handleCut}
          onDelete={handleDelete}
          onDismiss={() => setContentMenu(null)}
        />
      )}
    </div>
  )
}

// ── Blinking tab button ───────────────────────────────────────────────────────

interface TabButtonProps {
  channel: LogChannel
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

// Lerp between two hex colors by t (0..1)
function lerpColor(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)]
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)]
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t)
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t)
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`
}

// Two-phase decay: 0→1s fade 50%, 1→11s fade remaining 50%
function flashIntensity(elapsed: number): number {
  if (elapsed <= 0) return 1
  if (elapsed < 1000) return 1 - 0.5 * (elapsed / 1000)
  if (elapsed < 11000) return 0.5 * (1 - (elapsed - 1000) / 10000)
  return 0
}

const FLASH_COLOR = '#f0a500'
const REST_COLOR = '#858585'

function TabButton({ channel, isActive, onClick, onContextMenu }: TabButtonProps): React.ReactElement {
  const [dim, setDim] = useState(false)
  const [flashColor, setFlashColor] = useState<string | null>(null)
  const prevFlashKey = useRef(channel.flashKey)
  const rafRef = useRef(0)

  // Persistent attention blink (for channels with attention: true)
  useEffect(() => {
    if (!channel.blinking) {
      setDim(false)
      return
    }
    const id = setInterval(() => setDim((d) => !d), 500)
    return () => clearInterval(id)
  }, [channel.blinking])

  // Gradual flash decay on new content
  useEffect(() => {
    if (channel.flashKey === prevFlashKey.current) return
    prevFlashKey.current = channel.flashKey
    if (!channel.flashEnabled) return

    const start = performance.now()
    const tick = (now: number): void => {
      const elapsed = now - start
      const intensity = flashIntensity(elapsed)
      if (intensity <= 0) {
        setFlashColor(null)
        return
      }
      setFlashColor(lerpColor(REST_COLOR, FLASH_COLOR, intensity))
      rafRef.current = requestAnimationFrame(tick)
    }
    // Kick off immediately with full brightness
    setFlashColor(FLASH_COLOR)
    rafRef.current = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(rafRef.current)
  }, [channel.flashKey, channel.flashEnabled, isActive])

  let color: string
  if (channel.blinking) {
    color = dim ? '#555' : '#f0a500'
  } else if (flashColor) {
    color = flashColor
  } else if (isActive) {
    color = '#cccccc'
  } else {
    color = '#858585'
  }

  return (
    <button
      title={channel.id}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        background: isActive ? '#1e1e1e' : 'none',
        border: 'none',
        borderTop: isActive ? '1px solid #007acc' : '1px solid transparent',
        color,
        cursor: 'pointer',
        fontSize: 12,
        padding: '0 12px',
        height: 28,
        flexShrink: 0,
        whiteSpace: 'nowrap'
      }}
    >
      {channel.id}
    </button>
  )
}

// ── Tab context menu ──────────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number
  y: number
  onClear: () => void
  onClose: () => void
  onDismiss: () => void
}

function TabContextMenu({ x, y, onClear, onClose, onDismiss }: ContextMenuProps): React.ReactElement {
  // Close on any outside click
  useEffect(() => {
    const handler = (): void => onDismiss()
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onDismiss])

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: y,
        left: x,
        background: '#252526',
        border: '1px solid #3d3d3d',
        borderRadius: 2,
        zIndex: 9999,
        minWidth: 100,
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
        fontSize: 13
      }}
    >
      <button
        onClick={onClear}
        style={{
          display: 'block',
          width: '100%',
          background: 'none',
          border: 'none',
          color: '#cccccc',
          cursor: 'pointer',
          padding: '6px 12px',
          textAlign: 'left'
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '#04395e')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}
      >
        Clear
      </button>
      <div style={{ height: 1, background: '#3d3d3d', margin: '2px 0' }} />
      <button
        onClick={onClose}
        style={{
          display: 'block',
          width: '100%',
          background: 'none',
          border: 'none',
          color: '#cccccc',
          cursor: 'pointer',
          padding: '6px 12px',
          textAlign: 'left'
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '#04395e')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'none')}
      >
        Close
      </button>
    </div>
  )
}

// ── Main LogPanel component ───────────────────────────────────────────────────

const LOG_MIN_HEIGHT = 100
const LOG_MAX_HEIGHT = 600

export default function LogPanel(): React.ReactElement {
  const { logPanelExpanded, logPanelExpandedHeightPx, setLogPanelHeight, toggleLogPanel } =
    usePanelStore()
  const { channels, activeChannelId, setActive, stopBlink, clear, close } = useLogStore()

  const [filter, setFilter] = useState('')
  const [filterMode, setFilterMode] = useState<'hide' | 'dim'>('hide')

  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      startY.current = e.clientY
      startH.current = logPanelExpandedHeightPx
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [logPanelExpandedHeightPx]
  )

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return
      // dragging up = smaller clientY = bigger height
      const newH = Math.min(
        LOG_MAX_HEIGHT,
        Math.max(LOG_MIN_HEIGHT, startH.current - (e.clientY - startY.current))
      )
      setLogPanelHeight(newH)
    },
    [setLogPanelHeight]
  )

  const onResizePointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    window.editorApi.saveLogPanelHeight(usePanelStore.getState().logPanelExpandedHeightPx)
  }, [])

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    channelId: string
  } | null>(null)

  // Effective active channel: prefer explicit selection, fall back to first channel
  const effectiveActiveId =
    activeChannelId && channels.some((c) => c.id === activeChannelId)
      ? activeChannelId
      : (channels[0]?.id ?? null)

  const activeChannel = channels.find((c) => c.id === effectiveActiveId) ?? null

  const handleTabClick = (channelId: string): void => {
    setActive(channelId)
    stopBlink(channelId)
    if (!logPanelExpanded) toggleLogPanel()
  }

  const handleTabContextMenu = (e: React.MouseEvent, channelId: string): void => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, channelId })
  }

  return (
    <div
      style={{
        height: logPanelExpanded ? logPanelExpandedHeightPx : 28,
        flexShrink: 0,
        background: '#1e1e1e',
        borderTop: '1px solid #3d3d3d',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* Resize handle — only when expanded */}
      {logPanelExpanded && (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          style={{
            height: 4,
            cursor: 'row-resize',
            flexShrink: 0,
            background: dragging.current ? '#007acc' : 'transparent'
          }}
          onMouseEnter={(e) => {
            if (!dragging.current) (e.currentTarget as HTMLElement).style.background = '#007acc'
          }}
          onMouseLeave={(e) => {
            if (!dragging.current) (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        />
      )}

      {/* Tab strip — always visible */}
      <div
        style={{
          height: 28,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'stretch',
          borderBottom: logPanelExpanded ? '1px solid #3d3d3d' : 'none',
          background: '#252526'
        }}
      >
        {/* Channel tabs */}
        {channels.map((ch) => (
          <TabButton
            key={ch.id}
            channel={ch}
            isActive={ch.id === effectiveActiveId}
            onClick={() => handleTabClick(ch.id)}
            onContextMenu={(e) => handleTabContextMenu(e, ch.id)}
          />
        ))}

        <div style={{ flex: 1 }} />

        {/* Filter input — only when expanded */}
        {logPanelExpanded && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px' }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              style={{
                background: filter ? '#1e1e1e' : '#2d2d2d',
                border: `1px solid ${filter ? '#007acc' : '#3d3d3d'}`,
                borderRadius: 3,
                color: '#cccccc',
                fontSize: 12,
                height: 18,
                outline: 'none',
                padding: '0 6px',
                width: 160,
                fontFamily: 'Cascadia Code, Consolas, monospace'
              }}
            />
            <button
              title={filterMode === 'hide' ? 'Switch to dim mode' : 'Switch to hide mode'}
              onClick={() => setFilterMode((m) => (m === 'hide' ? 'dim' : 'hide'))}
              style={{
                background: 'none',
                border: 'none',
                color: filter ? '#858585' : '#444',
                cursor: 'pointer',
                fontSize: 11,
                lineHeight: '18px',
                padding: '0 4px',
                marginLeft: 2,
                fontFamily: 'Cascadia Code, Consolas, monospace'
              }}
            >
              {filterMode === 'hide' ? '▼' : '≈'}
            </button>
            {filter && (
              <button
                title="Clear filter"
                onClick={() => setFilter('')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#858585',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: '18px',
                  padding: '0 4px',
                  marginLeft: 0
                }}
              >
                ×
              </button>
            )}
          </div>
        )}

        <button
          title={logPanelExpanded ? 'Collapse log panel' : 'Expand log panel'}
          onClick={toggleLogPanel}
          style={{
            background: 'none',
            border: 'none',
            color: '#858585',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 10px',
            height: 28,
            flexShrink: 0
          }}
        >
          {logPanelExpanded ? '∨' : '∧'}
        </button>
      </div>

      {/* Content area — only rendered when expanded */}
      {logPanelExpanded && (
        <div style={{ flex: 1, overflow: 'hidden', background: '#1e1e1e' }}>
          {(() => {
            const rawLines = activeChannel?.lines ?? []
            const lowerFilter = filter.toLowerCase()

            let visibleLines: string[]
            let dimmedSet: Set<number> | null = null

            if (!filter) {
              visibleLines = rawLines
            } else if (filterMode === 'hide') {
              visibleLines = rawLines.filter((l) => l.toLowerCase().includes(lowerFilter))
            } else {
              // dim mode: show all, dim non-matching
              visibleLines = rawLines
              dimmedSet = new Set(
                rawLines.reduce<number[]>((acc, l, i) => {
                  if (!l.toLowerCase().includes(lowerFilter)) acc.push(i)
                  return acc
                }, [])
              )
            }

            return visibleLines.length > 0 ? (
              <ScrollableLogList
                channelId={effectiveActiveId ?? ''}
                lines={visibleLines}
                dimmedSet={dimmedSet}
              />
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#444',
                  fontSize: 12,
                  fontStyle: 'italic'
                }}
              >
                {!activeChannel ? '' : filter ? 'No matching lines' : 'No output'}
              </div>
            )
          })()}
        </div>
      )}

      {/* Tab context menu */}
      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClear={() => {
            clear(contextMenu.channelId)
            setContextMenu(null)
          }}
          onClose={() => {
            close(contextMenu.channelId)
            setContextMenu(null)
          }}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
