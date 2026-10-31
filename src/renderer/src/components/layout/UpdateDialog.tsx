import React, { useEffect, useState } from 'react'

interface Props {
  status: UpdateStatus
  onClose: () => void
}

const secondaryButton: React.CSSProperties = {
  padding: '5px 14px',
  background: 'transparent',
  border: '1px solid #555',
  borderRadius: 3,
  color: '#ccc',
  fontSize: 12,
  cursor: 'pointer'
}

const primaryButton: React.CSSProperties = {
  padding: '5px 14px',
  background: '#0e639c',
  border: 'none',
  borderRadius: 3,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer'
}

const IDLE_STATE: InstallState = { phase: 'idle', version: null, received: 0, total: null, error: null }

function progressText(state: InstallState): string {
  switch (state.phase) {
    case 'downloading': {
      const received = (state.received / (1024 * 1024)).toFixed(1)
      if (!state.total) return `Downloading v${state.version}: ${received} MB`
      const total = (state.total / (1024 * 1024)).toFixed(1)
      return `Downloading v${state.version}: ${received} of ${total} MB`
    }
    case 'verifying': return 'Verifying the download...'
    case 'unpacking': return 'Unpacking...'
    default: return ''
  }
}

function hasBlockers(blockers: UpdateBlockers): boolean {
  return blockers.work.length > 0 || blockers.toolbarProcesses > 0 || blockers.otherInstances.length > 0
}

export default function UpdateDialog({ status, onClose }: Props): React.ReactElement {
  const { currentVersion, latestVersion, newReleases, canInstall } = status
  const [install, setInstall] = useState<InstallState>(IDLE_STATE)
  const [blockers, setBlockers] = useState<UpdateBlockers | null>(null)
  const [applying, setApplying] = useState(false)

  // Mark notification as seen so the timer resets
  useEffect(() => {
    void window.editorApi.updaterDismissNotification()
  }, [])

  useEffect(() => {
    void window.editorApi.updaterInstallState().then(setInstall)
    return window.editorApi.onUpdaterInstallState(setInstall)
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

  const handleUpdate = (): void => {
    void window.editorApi.updaterInstallStart().then((answer) => {
      setBlockers(!answer.ok && hasBlockers(answer.blockers) ? answer.blockers : null)
    })
  }

  const handleRestart = (): void => {
    setApplying(true)
    void window.editorApi.updaterInstallApply().then((answer) => {
      setApplying(false)
      setBlockers(!answer.ok && hasBlockers(answer.blockers) ? answer.blockers : null)
    })
  }

  const busy = install.phase === 'downloading' || install.phase === 'verifying' || install.phase === 'unpacking'
  const percent = install.phase === 'downloading' && install.total
    ? Math.floor((install.received / install.total) * 100)
    : null

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
            {blockers ? 'Stop All Work First' : 'Update Available'}
          </div>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
            v{currentVersion} → v{latestVersion}
          </div>
        </div>

        {blockers ? (
          <BlockerList blockers={blockers} />
        ) : (
          <>
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

            {/* Install progress */}
            {busy && (
              <div style={{ padding: '10px 20px', borderTop: '1px solid #333', fontSize: 12, color: '#ccc' }}>
                <div>{progressText(install)}</div>
                <div style={{ marginTop: 6, height: 4, background: '#333', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${percent ?? 100}%`, background: '#0e639c', opacity: percent === null ? 0.5 : 1 }} />
                </div>
              </div>
            )}
            {install.phase === 'ready' && (
              <div style={{ padding: '10px 20px', borderTop: '1px solid #333', fontSize: 12, color: '#ccc' }}>
                v{install.version} is ready. AIDE will close and start again; terminal sessions are closed and resumed on start.
              </div>
            )}
            {install.phase === 'failed' && (
              <div style={{ padding: '10px 20px', borderTop: '1px solid #333', fontSize: 12, color: '#f44747', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                Update failed: {install.error}
              </div>
            )}
          </>
        )}

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
          {blockers ? (
            <>
              <button onClick={() => setBlockers(null)} style={secondaryButton}>Back</button>
              <button
                onClick={install.phase === 'ready' ? handleRestart : handleUpdate}
                disabled={applying}
                style={primaryButton}
              >
                {applying ? 'Checking...' : 'Check Again'}
              </button>
            </>
          ) : busy ? (
            <>
              <button onClick={onClose} style={secondaryButton}>Hide</button>
              <button onClick={() => void window.editorApi.updaterInstallCancel()} style={secondaryButton}>Cancel Update</button>
            </>
          ) : install.phase === 'ready' ? (
            <>
              <button onClick={onClose} style={secondaryButton}>Later</button>
              <button onClick={() => void window.editorApi.updaterInstallCancel()} style={secondaryButton}>Discard Update</button>
              <button onClick={handleRestart} disabled={applying} style={primaryButton}>
                {applying ? 'Checking...' : 'Restart to Update'}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} style={secondaryButton}>Cancel</button>
              <button onClick={handleSkip} style={secondaryButton}>Skip Version</button>
              {canInstall && install.phase === 'failed' && (
                <button onClick={handleDownload} style={secondaryButton}>Download Manually</button>
              )}
              {canInstall ? (
                <button onClick={handleUpdate} style={primaryButton}>
                  {install.phase === 'failed' ? 'Try Again' : 'Update'}
                </button>
              ) : (
                <button onClick={handleDownload} style={primaryButton}>Download Update</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function BlockerList({ blockers }: { blockers: UpdateBlockers }): React.ReactElement {
  const section: React.CSSProperties = { marginBottom: 14 }
  const heading: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#e0e0e0', marginBottom: 4 }
  const line: React.CSSProperties = { fontSize: 12, color: '#ccc', lineHeight: 1.6 }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
      {blockers.work.length > 0 && (
        <div style={section}>
          <div style={heading}>Stop all pipeline runs first</div>
          {blockers.work.map((item) => <div key={item} style={line}>{item}</div>)}
        </div>
      )}
      {blockers.toolbarProcesses > 0 && (
        <div style={section}>
          <div style={heading}>Stop toolbar processes first</div>
          <div style={line}>{blockers.toolbarProcesses} still running</div>
        </div>
      )}
      {blockers.otherInstances.length > 0 && (
        <div style={section}>
          <div style={heading}>Close other AIDE windows first</div>
          {blockers.otherInstances.map((item) => <div key={item.pid} style={line}>{item.title}</div>)}
        </div>
      )}
    </div>
  )
}
