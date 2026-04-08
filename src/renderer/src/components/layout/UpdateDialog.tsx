import React, { useEffect } from 'react'

interface Props {
  status: UpdateStatus
  onClose: () => void
}

export default function UpdateDialog({ status, onClose }: Props): React.ReactElement {
  const { currentVersion, latestVersion, newReleases } = status

  // Mark notification as seen so the timer resets
  useEffect(() => {
    void window.editorApi.updaterDismissNotification()
  }, [])

  const handleDownload = (): void => {
    window.editorApi.updaterOpenReleases()
    onClose()
  }

  const handleSkip = (): void => {
    if (latestVersion) {
      void window.editorApi.updaterSkipVersion(latestVersion)
    }
    onClose()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: '#1e1e1e',
          border: '1px solid #444',
          borderRadius: 6,
          width: 560,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)'
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #333' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#e0e0e0' }}>
            Update Available
          </div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
            v{currentVersion} → v{latestVersion}
          </div>
        </div>

        {/* Changelogs */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {newReleases.map((release) => (
            <div key={release.version} style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#4ec9b0',
                  marginBottom: 6,
                  fontFamily: 'Cascadia Code, Consolas, monospace'
                }}
              >
                v{release.version}
              </div>
              {release.notes ? (
                <pre
                  style={{
                    margin: 0,
                    fontSize: 12,
                    color: '#ccc',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'Cascadia Code, Consolas, monospace',
                    lineHeight: 1.6
                  }}
                >
                  {release.notes}
                </pre>
              ) : (
                <span style={{ fontSize: 12, color: '#666', fontStyle: 'italic' }}>
                  No description
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Buttons */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #333',
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end'
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '5px 14px',
              background: 'transparent',
              border: '1px solid #555',
              borderRadius: 3,
              color: '#ccc',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSkip}
            style={{
              padding: '5px 14px',
              background: 'transparent',
              border: '1px solid #555',
              borderRadius: 3,
              color: '#ccc',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            Skip Version
          </button>
          <button
            onClick={handleDownload}
            style={{
              padding: '5px 14px',
              background: '#0e639c',
              border: 'none',
              borderRadius: 3,
              color: '#fff',
              fontSize: 12,
              cursor: 'pointer'
            }}
          >
            Download Update
          </button>
        </div>
      </div>
    </div>
  )
}
