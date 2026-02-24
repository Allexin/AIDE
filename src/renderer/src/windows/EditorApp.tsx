import React, { useEffect, useState } from 'react'

export default function EditorApp(): React.ReactElement {
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    window.editorApi.getProjectPath().then(setProjectPath)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '8px',
        fontFamily: 'Consolas, monospace'
      }}
    >
      <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '1px' }}>
        Stage 1 — Editor Placeholder
      </div>
      <div style={{ fontSize: '14px', color: '#858585' }}>
        {projectPath ?? 'Loading…'}
      </div>
    </div>
  )
}
