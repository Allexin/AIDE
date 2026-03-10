import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { FixedSizeList, ListChildComponentProps } from 'react-window'
import { usePanelStore } from '../../store/usePanelStore'
import { useLogStore, LogChannel } from '../../store/useLogStore'

// ── Row renderer (defined outside component to avoid re-creation) ─────────────

const LogRow = memo(({ index, style, data }: ListChildComponentProps<string[]>) => (
  <div
    style={{
      ...style,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      color: '#cccccc',
      whiteSpace: 'pre',
      paddingLeft: 8,
      lineHeight: '20px',
      userSelect: 'text'
    }}
  >
    {data[index]}
  </div>
))
LogRow.displayName = 'LogRow'

// ── Virtualized list ──────────────────────────────────────────────────────────

function VirtualLogList({
  lines,
  fallbackHeight
}: {
  lines: string[]
  fallbackHeight: number
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<FixedSizeList<string[]>>(null)
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

  return (
    <div ref={containerRef} style={{ height: '100%', overflow: 'hidden' }}>
      <FixedSizeList<string[]>
        ref={listRef}
        height={height}
        itemCount={lines.length}
        itemSize={20}
        width="100%"
        itemData={lines}
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
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function TabButton({ channel, isActive, onClick, onContextMenu }: TabButtonProps): React.ReactElement {
  const [dim, setDim] = useState(false)

  useEffect(() => {
    if (!channel.blinking) {
      setDim(false)
      return
    }
    const id = setInterval(() => setDim((d) => !d), 500)
    return () => clearInterval(id)
  }, [channel.blinking])

  return (
    <button
      title={channel.id}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        background: isActive ? '#1e1e1e' : 'none',
        border: 'none',
        borderTop: isActive ? '1px solid #007acc' : '1px solid transparent',
        color: channel.blinking
          ? dim
            ? '#555'
            : '#f0a500'  // amber blink for attention
          : isActive
            ? '#cccccc'
            : '#858585',
        cursor: 'pointer',
        fontSize: 12,
        padding: '0 12px',
        height: 28,
        flexShrink: 0,
        whiteSpace: 'nowrap',
        transition: 'color 0.05s'
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
          {activeChannel && activeChannel.lines.length > 0 ? (
            <VirtualLogList
              lines={activeChannel.lines}
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
              {activeChannel ? 'No output' : ''}
            </div>
          )}
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
