import React from 'react'
import { usePanelStore } from '../../store/usePanelStore'

// Log panel — horizontally tabbed output panel.
// Collapsed by default; attention system and channels populated in Stage 7.
export default function LogPanel(): React.ReactElement {
  const { logPanelExpanded, logPanelExpandedHeightPx, toggleLogPanel } = usePanelStore()

  return (
    <div
      style={{
        height: logPanelExpanded ? logPanelExpandedHeightPx : 28,
        flexShrink: 0,
        background: '#252526',
        borderTop: '1px solid #3d3d3d',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {/* Strip / tab row — always visible */}
      <div
        style={{
          height: 28,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 8,
          paddingRight: 4,
          gap: 4,
          borderBottom: logPanelExpanded ? '1px solid #3d3d3d' : 'none'
        }}
      >
        {/* Channel tabs appear here in Stage 7 */}
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
            padding: '2px 8px',
            lineHeight: 1
          }}
        >
          {logPanelExpanded ? '∨' : '∧'}
        </button>
      </div>

      {/* Content area — populated in Stage 7 */}
      {logPanelExpanded && (
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
          Log Panel
        </div>
      )}
    </div>
  )
}
