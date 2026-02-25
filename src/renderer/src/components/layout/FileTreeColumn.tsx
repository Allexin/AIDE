import React from 'react'
import { usePanelStore } from '../../store/usePanelStore'

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

// Small toolbar strip inside the file tree column.
function FileTreeToolbar(): React.ReactElement {
  const { editorVisible, setEditorVisible } = usePanelStore()

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
      {/* Modified only toggle */}
      <button title="Show modified files only" onClick={() => {/* Stage 4 */}} style={toolbarBtnStyle}>
        ▣
      </button>

      {/* Refresh */}
      <button title="Refresh" onClick={() => {/* Stage 4 */}} style={toolbarBtnStyle}>
        ↺
      </button>

      {/* Commit */}
      <button title="Commit" onClick={() => {/* Stage 10 */}} style={toolbarBtnStyle}>
        ◎
      </button>

      {/* TEMP Stage 3: toggle editor visibility for testing */}
      <button
        title={editorVisible ? 'Close editor (temp)' : 'Open editor (temp)'}
        onClick={() => setEditorVisible(!editorVisible)}
        style={{
          ...toolbarBtnStyle,
          marginLeft: 'auto',
          color: editorVisible ? '#007acc' : '#555',
          fontSize: 12
        }}
      >
        E
      </button>
    </div>
  )
}

// File tree column — fixed width left column, not collapsible.
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

      {/* File tree content — populated in Stage 4 */}
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
        File Tree
      </div>
    </div>
  )
}
