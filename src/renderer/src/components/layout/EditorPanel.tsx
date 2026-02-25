import React from 'react'
import { usePanelStore } from '../../store/usePanelStore'
import { useEditorStore } from '../../store/useEditorStore'

const headerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #3d3d3d',
  color: '#cccccc',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 7px',
  borderRadius: 3,
  lineHeight: 1.4,
  flexShrink: 0
}

interface EditorPanelProps {
  style?: React.CSSProperties
}

// Editor panel — single-file Monaco instance.
// Monaco is wired in Stage 6; this stage shows the open file path.
export default function EditorPanel({ style }: EditorPanelProps): React.ReactElement {
  const { focusEditor } = usePanelStore()
  const { openRelativePath, closeEditor } = useEditorStore()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderRight: '1px solid #3d3d3d',
        ...style
      }}
      onMouseDown={focusEditor}
    >
      {/* Editor panel header */}
      <div
        style={{
          height: 35,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 10,
          paddingRight: 6,
          gap: 6,
          background: '#2d2d2d',
          borderBottom: '1px solid #3d3d3d'
        }}
      >
        <span
          style={{
            flex: 1,
            fontSize: 13,
            color: openRelativePath ? '#cccccc' : '#858585',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {openRelativePath ?? '— no file open —'}
        </span>

        <button
          title="Toggle diff view"
          style={headerBtnStyle}
          onClick={(e) => {
            e.stopPropagation()
            /* Stage 6 */
          }}
        >
          Diff
        </button>

        <button
          title="Close file"
          style={{ ...headerBtnStyle, fontSize: 15, border: 'none' }}
          onClick={(e) => {
            e.stopPropagation()
            closeEditor()
          }}
        >
          ×
        </button>
      </div>

      {/* Monaco Editor placeholder — replaced in Stage 6 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1e1e1e',
          color: '#444',
          fontSize: 12,
          fontStyle: 'italic'
        }}
      >
        {openRelativePath ? `Opened: ${openRelativePath}` : 'Monaco Editor'}
      </div>
    </div>
  )
}
