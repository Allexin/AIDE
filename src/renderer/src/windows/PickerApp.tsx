import React, { useState, useEffect } from 'react'

function folderName(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export default function PickerApp(): React.ReactElement {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [staleErrors, setStaleErrors] = useState<Record<string, string>>({})

  async function loadState(): Promise<void> {
    const state = await window.pickerApi.getState()
    setRecents(state.recentProjects)
  }

  useEffect(() => {
    loadState()
  }, [])

  async function handleOpenFolder(): Promise<void> {
    setGlobalError(null)
    const folderPath = await window.pickerApi.selectFolder()
    if (!folderPath) return

    setLoading(true)
    const result = await window.pickerApi.openProject(folderPath)
    setLoading(false)

    if (!result.success) {
      setGlobalError(result.error)
    }
    // On success the main process closes this window
  }

  async function handleRecentClick(project: RecentProject): Promise<void> {
    const exists = await window.pickerApi.validatePath(project.path)
    if (!exists) {
      setStaleErrors(prev => ({
        ...prev,
        [project.path]: 'This folder no longer exists.'
      }))
      return
    }

    setStaleErrors(prev => {
      const next = { ...prev }
      delete next[project.path]
      return next
    })

    const result = await window.pickerApi.openProject(project.path)
    if (!result.success) {
      setStaleErrors(prev => ({ ...prev, [project.path]: result.error }))
    }
  }

  async function handleRemove(projectPath: string): Promise<void> {
    await window.pickerApi.removeRecentProject(projectPath)
    setStaleErrors(prev => {
      const next = { ...prev }
      delete next[projectPath]
      return next
    })
    await loadState()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          padding: '16px 20px 12px',
          borderBottom: '1px solid #333',
          flexShrink: 0
        }}
      >
        <div style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-0.3px' }}>AIDE</div>
        <div style={{ fontSize: '11px', color: '#858585', marginTop: '2px' }}>
          AI-Driven Code Editor
        </div>
      </div>

      {/* Section label */}
      <div
        style={{
          padding: '10px 20px 4px',
          fontSize: '11px',
          color: '#858585',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          flexShrink: 0
        }}
      >
        Recent Projects
      </div>

      {/* Recent projects list */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {recents.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#555',
              fontSize: '13px'
            }}
          >
            No recent projects
          </div>
        ) : (
          recents.map(project => {
            const err = staleErrors[project.path]
            return (
              <div key={project.path}>
                <div
                  onClick={() => handleRecentClick(project)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 20px',
                    cursor: 'pointer',
                    gap: '12px'
                  }}
                  onMouseEnter={e => {
                    ;(e.currentTarget as HTMLDivElement).style.backgroundColor = '#2a2d2e'
                  }}
                  onMouseLeave={e => {
                    ;(e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: '#cccccc',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {folderName(project.path)}
                    </div>
                    <div
                      style={{
                        fontSize: '11px',
                        color: '#6e6e6e',
                        marginTop: '1px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {project.path}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#6e6e6e',
                      flexShrink: 0,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {formatDate(project.lastOpened)}
                  </div>
                </div>

                {err && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '4px 20px 6px',
                      backgroundColor: '#1a1a1a'
                    }}
                  >
                    <span style={{ fontSize: '11px', color: '#f14c4c', flex: 1 }}>{err}</span>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        handleRemove(project.path)
                      }}
                      style={{
                        fontSize: '11px',
                        color: '#858585',
                        background: 'none',
                        border: '1px solid #444',
                        borderRadius: '3px',
                        padding: '2px 8px',
                        cursor: 'pointer',
                        flexShrink: 0
                      }}
                    >
                      Remove from list
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Bottom bar */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid #333',
          flexShrink: 0
        }}
      >
        <button
          onClick={handleOpenFolder}
          disabled={loading}
          style={{
            width: '100%',
            padding: '8px 0',
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

        {globalError && (
          <div
            style={{
              marginTop: '6px',
              fontSize: '11px',
              color: '#f14c4c',
              lineHeight: 1.4
            }}
          >
            {globalError}
          </div>
        )}
      </div>
    </div>
  )
}
