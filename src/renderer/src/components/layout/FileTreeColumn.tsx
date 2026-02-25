import React from 'react'
import { usePanelStore } from '../../store/usePanelStore'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import FileTree from '../filetree/FileTree'

const toolbarBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#cccccc',
  cursor: 'pointer',
  fontSize: 14,
  padding: '2px 5px',
  borderRadius: 3,
  lineHeight: 1,
  flexShrink: 0
}

function FileTreeToolbar(): React.ReactElement {
  const { modifiedOnly, toggleModifiedOnly, refresh } = useFileTreeStore()

  return (
    <div
      style={{
        height: 28,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 6,
        paddingRight: 6,
        gap: 2,
        borderBottom: '1px solid #3d3d3d'
      }}
    >
      {/* Modified only toggle — active state shown in blue */}
      <button
        title={modifiedOnly ? 'Show all files' : 'Show modified files only'}
        onClick={toggleModifiedOnly}
        style={{ ...toolbarBtnStyle, color: modifiedOnly ? '#007acc' : '#cccccc' }}
      >
        ▣
      </button>

      {/* Refresh */}
      <button title="Refresh" onClick={() => refresh()} style={toolbarBtnStyle}>
        ↺
      </button>

      {/* Commit — Stage 10 */}
      <button
        title="Commit"
        onClick={() => {
          /* Stage 10 */
        }}
        style={toolbarBtnStyle}
      >
        ◎
      </button>
    </div>
  )
}

export default function FileTreeColumn(): React.ReactElement {
  const { fileTreeWidthPx } = usePanelStore()

  return (
    <div
      style={{
        width: fileTreeWidthPx,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#252526',
        borderRight: '1px solid #3d3d3d',
        overflow: 'hidden'
      }}
    >
      <FileTreeToolbar />
      <FileTree />
    </div>
  )
}
