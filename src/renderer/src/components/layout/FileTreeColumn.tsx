import React, { useCallback, useRef, useState } from 'react'
import { usePanelStore } from '../../store/usePanelStore'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useToastStore } from '../../store/useToastStore'
import FileTree from '../filetree/FileTree'
import CommitDialog from '../git/CommitDialog'

const MIN_WIDTH = 120
const MAX_WIDTH = 600

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
  const { modifiedOnly, toggleModifiedOnly, refresh, gitStatus } = useFileTreeStore()
  const [commitOpen, setCommitOpen] = useState(false)

  const handleCommitClick = (): void => {
    if (!gitStatus?.available) {
      useToastStore.getState().show('Git is not initialized. Run `git init` to get started.')
      return
    }
    const { changed, deleted, untracked } = gitStatus
    if (changed.length === 0 && deleted.length === 0 && untracked.length === 0) {
      useToastStore.getState().show('Nothing to commit — working tree clean')
      return
    }
    setCommitOpen(true)
  }

  return (
    <>
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

        {/* Commit */}
        <button title="Commit" onClick={handleCommitClick} style={toolbarBtnStyle}>
          ◎
        </button>
      </div>

      {commitOpen && <CommitDialog onClose={() => setCommitOpen(false)} />}
    </>
  )
}

export default function FileTreeColumn(): React.ReactElement {
  const { fileTreeWidthPx, setFileTreeWidth } = usePanelStore()
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      startX.current = e.clientX
      startW.current = fileTreeWidthPx
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [fileTreeWidthPx]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return
      const newW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW.current + e.clientX - startX.current))
      setFileTreeWidth(newW)
    },
    [setFileTreeWidth]
  )

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    window.editorApi.saveFileTreeWidth(usePanelStore.getState().fileTreeWidthPx)
  }, [])

  return (
    <div
      style={{
        width: fileTreeWidthPx,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        background: '#252526',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <FileTreeToolbar />
        <FileTree />
      </div>

      {/* Resize handle */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          width: 4,
          cursor: 'col-resize',
          flexShrink: 0,
          background: dragging.current ? '#007acc' : 'transparent',
          borderRight: '1px solid #3d3d3d'
        }}
        onMouseEnter={(e) => {
          if (!dragging.current) (e.currentTarget as HTMLElement).style.background = '#007acc'
        }}
        onMouseLeave={(e) => {
          if (!dragging.current) (e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      />
    </div>
  )
}
