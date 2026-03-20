import React, { useCallback, useEffect, useRef } from 'react'
import { useThinkingStore } from '../../store/useThinkingStore'
import { useSessionStore } from '../../store/useSessionStore'

const PANEL_MIN_HEIGHT = 80
const PANEL_MAX_HEIGHT = 500
const PANEL_DEFAULT_HEIGHT = 200

export default function ThinkingPanel(): React.ReactElement {
  const { thinking, index, total, isExpanded, setBlock, setTotal, reset, toggleExpanded } =
    useThinkingStore()
  const activeTabId = useSessionStore((s) => s.activeTabId)

  const panelHeight = useRef(PANEL_DEFAULT_HEIGHT)
  const dragging = useRef(false)
  const dragStartY = useRef(0)
  const dragStartH = useRef(0)
  // Re-render trigger for panel height during drag
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0)

  const isAtLast = total === 0 || index === total - 1

  // Fetch a block by index for the active tab
  const fetchBlock = useCallback(
    async (tabId: string, idx: number | 'last') => {
      const result = await window.editorApi.thinkingGetBlock(tabId, idx)
      if (result) {
        useThinkingStore.getState().setBlock(result.thinking, result.index, result.total)
      } else {
        useThinkingStore.getState().reset()
      }
    },
    []
  )

  // When active tab changes and panel is expanded, fetch last block for new tab
  useEffect(() => {
    if (!isExpanded || !activeTabId) {
      reset()
      return
    }
    fetchBlock(activeTabId, 'last')
  }, [activeTabId, isExpanded]) // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for thinking:update events from main process
  useEffect(() => {
    return window.editorApi.onThinkingUpdate((tabId, newTotal) => {
      const state = useThinkingStore.getState()
      const currentActiveTabId = useSessionStore.getState().activeTabId
      if (tabId !== currentActiveTabId) return

      if (!state.isExpanded) {
        // Panel collapsed — just track total so ▶ lights up when expanded
        setTotal(newTotal)
        return
      }

      const currentIsAtLast = state.total === 0 || state.index === state.total - 1
      if (currentIsAtLast) {
        fetchBlock(tabId, 'last')
      } else {
        setTotal(newTotal)
      }
    })
  }, [fetchBlock, setTotal])

  const [rawLog, setRawLog] = React.useState(false)
  const handleToggleRawLog = useCallback(() => {
    const next = !rawLog
    setRawLog(next)
    window.editorApi.setPtyRawLog(next)
  }, [rawLog])

  const handleExpand = useCallback(() => {
    toggleExpanded()
    // If expanding: fetch data. If collapsing: keep data in store (no need to clear)
    if (!isExpanded && activeTabId) {
      fetchBlock(activeTabId, 'last')
    }
  }, [isExpanded, activeTabId, fetchBlock, toggleExpanded])

  const handlePrev = useCallback(() => {
    if (!activeTabId || index <= 0) return
    fetchBlock(activeTabId, index - 1)
  }, [activeTabId, index, fetchBlock])

  const handleNext = useCallback(() => {
    if (!activeTabId || index >= total - 1) return
    fetchBlock(activeTabId, index + 1)
  }, [activeTabId, index, total, fetchBlock])

  // Resize drag
  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    dragStartY.current = e.clientY
    dragStartH.current = panelHeight.current
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    const newH = Math.min(
      PANEL_MAX_HEIGHT,
      Math.max(PANEL_MIN_HEIGHT, dragStartH.current - (e.clientY - dragStartY.current))
    )
    panelHeight.current = newH
    forceUpdate()
  }, [])

  const onResizePointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const hasData = total > 0

  return (
    <div
      style={{
        height: isExpanded ? panelHeight.current : 28,
        flexShrink: 0,
        background: '#1e1e1e',
        borderTop: '1px solid #3d3d3d',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* Resize handle */}
      {isExpanded && (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          style={{ height: 4, cursor: 'row-resize', flexShrink: 0, background: 'transparent' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = '#007acc'
          }}
          onMouseLeave={(e) => {
            if (!dragging.current) (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        />
      )}

      {/* Header strip — always visible */}
      <div
        style={{
          height: 28,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          borderBottom: isExpanded ? '1px solid #3d3d3d' : 'none',
          background: '#252526',
          gap: 0
        }}
      >
        {/* Label */}
        <span
          style={{
            color: '#858585',
            fontSize: 12,
            padding: '0 10px',
            userSelect: 'none',
            flexShrink: 0
          }}
        >
          Thinking
        </span>

        {/* Navigation — only when there's data */}
        {hasData && (
          <>
            <button
              onClick={handlePrev}
              disabled={index <= 0}
              title="Previous thinking block"
              style={navButtonStyle(index <= 0)}
            >
              ◀
            </button>
            <span
              style={{
                color: '#858585',
                fontSize: 12,
                padding: '0 6px',
                userSelect: 'none',
                flexShrink: 0
              }}
            >
              {index + 1} / {total}
            </span>
            <button
              onClick={handleNext}
              disabled={isAtLast}
              title="Next thinking block"
              style={navButtonStyle(isAtLast)}
            >
              ▶
            </button>
          </>
        )}

        <div style={{ flex: 1 }} />

        {/* Raw log toggle — debug tool */}
        <button
          title={rawLog ? 'Stop PTY raw log' : 'Start PTY raw log (debug)'}
          onClick={handleToggleRawLog}
          style={{
            background: rawLog ? '#3c3c00' : 'none',
            border: 'none',
            color: rawLog ? '#d7ba7d' : '#555',
            cursor: 'pointer',
            fontSize: 10,
            padding: '0 8px',
            height: 28,
            flexShrink: 0,
            fontFamily: 'monospace'
          }}
        >
          RAW
        </button>

        {/* Collapse toggle */}
        <button
          title={isExpanded ? 'Collapse thinking panel' : 'Expand thinking panel'}
          onClick={handleExpand}
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
          {isExpanded ? '∨' : '∧'}
        </button>
      </div>

      {/* Content — only when expanded */}
      {isExpanded && (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
          {thinking && thinking.length > 0 ? (
            <pre
              style={{
                margin: 0,
                fontFamily: 'Cascadia Code, Consolas, monospace',
                fontSize: 12,
                lineHeight: '20px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#9d9d9d'
              }}
            >
              {thinking}
            </pre>
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
              No thinking blocks yet
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function navButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: 'none',
    border: 'none',
    color: disabled ? '#444' : '#858585',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 11,
    padding: '0 4px',
    height: 28,
    flexShrink: 0
  }
}
