import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { FixedSizeList, ListChildComponentProps } from 'react-window'
import { usePanelStore } from '../../store/usePanelStore'
import { useLogStore, LogChannel } from '../../store/useLogStore'

// ── Row renderer (defined outside component to avoid re-creation) ─────────────

interface LogListData {
  lines: string[]
  dimmedSet: Set<number> | null
}

const LogRow = memo(({ index, style, data }: ListChildComponentProps<LogListData>) => (
  <div
    style={{
      ...style,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      color: '#cccccc',
      whiteSpace: 'pre',
      paddingLeft: 8,
      lineHeight: '20px',
      userSelect: 'text',
      opacity: data.dimmedSet?.has(index) ? 0.15 : 1
    }}
  >
    {data.lines[index]}
  </div>
))
LogRow.displayName = 'LogRow'

// ── Virtualized list ──────────────────────────────────────────────────────────

function VirtualLogList({
  lines,
  dimmedSet,
  fallbackHeight
}: {
  lines: string[]
  dimmedSet: Set<number> | null
  fallbackHeight: number
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<FixedSizeList<LogListData>>(null)
  const [height, setHeight] = useState(fallbackHeight)

  // Measure actual container height via ResizeObserver
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      setHeight(entries[0].contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-scroll to bottom when lines are appended
  useEffect(() => {
    if (lines.length > 0) {
      listRef.current?.scrollToItem(lines.length - 1, 'end')
    }
  }, [lines.length])

  const itemData: LogListData = { lines, dimmedSet }

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'hidden' }}>
      <FixedSizeList<LogListData>
        ref={listRef}
        height={height}
        itemCount={lines.length}
        itemSize={20}
        width="100%"
        itemData={itemData}
        overscanCount={8}
        style={{ outline: 'none' }}
      >
        {LogRow}
      </FixedSizeList>
    </div>
  )
}

// ── Blinking tab button ───────────────────────────────────────────────────────

interface TabButtonProps {
  channel: LogChannel
  isActive: boolean
  expanded: boolean
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

function TabButton({ channel, isActive, expanded, onClick, onContextMenu }: TabButtonProps): React.ReactElement {
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
    if (!channel.flashEnabled || (isActive && expanded)) return

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
  }, [channel.flashKey, channel.flashEnabled, isActive, expanded])

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
            expanded={logPanelExpanded}
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
              <VirtualLogList
                lines={visibleLines}
                dimmedSet={dimmedSet}
                fallbackHeight={logPanelExpandedHeightPx - 28}
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
