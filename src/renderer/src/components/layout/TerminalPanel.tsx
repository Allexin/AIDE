import React from 'react'
import { usePanelStore } from '../../store/usePanelStore'

const headerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#858585',
  cursor: 'pointer',
  fontSize: 16,
  padding: '2px 6px',
  lineHeight: 1,
  flexShrink: 0
}

const tabStyle: React.CSSProperties = {
  background: '#1e1e1e',
  color: '#d4d4d4',
  fontSize: 12,
  padding: '4px 10px',
  borderRadius: '3px 3px 0 0',
  cursor: 'pointer',
  border: '1px solid #3d3d3d',
  borderBottom: 'none',
  whiteSpace: 'nowrap',
  lineHeight: 1.5
}

interface TerminalPanelProps {
  style?: React.CSSProperties
}

// Terminal panel — xterm.js + node-pty, populated in Stage 5.
export default function TerminalPanel({ style }: TerminalPanelProps): React.ReactElement {
  const { terminalCollapsed, collapsedWidthPx, toggleTerminalCollapse, focusTerminal } =
    usePanelStore()

  // Collapsed state: 20px vertical strip with "Claude Code" label
  if (terminalCollapsed) {
    return (
      <div
        style={{
          width: collapsedWidthPx,
          flexShrink: 0,
          background: '#1e1e1e',
          borderLeft: '1px solid #3d3d3d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          overflow: 'hidden',
          ...style
        }}
        onClick={() => {
          toggleTerminalCollapse()
          focusTerminal()
        }}
        title="Restore terminal"
      >
        <span
          style={{
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            fontSize: 11,
            color: '#555',
            letterSpacing: 1,
            userSelect: 'none',
            whiteSpace: 'nowrap'
          }}
        >
          Claude Code
        </span>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#1e1e1e',
        ...style
      }}
      onMouseDown={focusTerminal}
    >
      {/* Terminal panel header */}
      <div
        style={{
          height: 35,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 6,
          paddingRight: 4,
          gap: 2,
          background: '#2d2d2d',
          borderBottom: '1px solid #3d3d3d'
        }}
      >
        {/* Session tabs — populated in Stage 5 */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', overflow: 'hidden', gap: 2 }}>
          <div style={tabStyle}>Claude Code</div>
        </div>

        {/* [ + ] open session picker */}
        <button
          title="Open session picker"
          style={headerBtnStyle}
          onClick={(e) => {
            e.stopPropagation()
            /* Stage 5 */
          }}
        >
          +
        </button>

        {/* [ collapse ] */}
        <button
          title="Collapse terminal"
          style={headerBtnStyle}
          onClick={(e) => {
            e.stopPropagation()
            toggleTerminalCollapse()
          }}
        >
          ⌄
        </button>
      </div>

      {/* xterm.js placeholder */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#444',
          fontSize: 12,
          fontStyle: 'italic'
        }}
      >
        Terminal (xterm.js)
      </div>
    </div>
  )
}
