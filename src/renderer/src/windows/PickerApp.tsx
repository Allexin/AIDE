import React, { useState } from 'react'

export default function PickerApp(): React.ReactElement {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleOpenFolder = async (): Promise<void> => {
    setError(null)

    const folderPath = await window.pickerApi.selectFolder()
    if (!folderPath) return

    setLoading(true)
    const result = await window.pickerApi.openProject(folderPath)
    setLoading(false)

    if (!result.success) {
      setError(result.error)
    }
    // On success, main process closes this window
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '12px'
      }}
    >
      <div style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px' }}>AIDE</div>
      <div style={{ fontSize: '13px', color: '#858585' }}>AI-Driven Code Editor</div>

      <button
        onClick={handleOpenFolder}
        disabled={loading}
        style={{
          marginTop: '20px',
          padding: '9px 22px',
          fontSize: '13px',
          backgroundColor: loading ? '#555' : '#0e639c',
          color: '#fff',
          border: 'none',
          borderRadius: '3px',
          cursor: loading ? 'wait' : 'pointer',
          outline: 'none'
        }}
      >
        {loading ? 'Opening…' : 'Open Folder…'}
      </button>

      {error && (
        <div
          style={{
            fontSize: '12px',
            color: '#f14c4c',
            maxWidth: '380px',
            textAlign: 'center',
            lineHeight: 1.5,
            padding: '0 16px'
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
