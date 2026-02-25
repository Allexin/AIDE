import React, { useState } from 'react'
import { usePanelStore } from '../../store/usePanelStore'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useToastStore } from '../../store/useToastStore'
import FileTree from '../filetree/FileTree'
import CommitDialog from '../git/CommitDialog'

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
