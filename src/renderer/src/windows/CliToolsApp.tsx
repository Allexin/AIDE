import React, { useEffect, useState } from 'react'

interface CliToolEntry {
  id: string
  name: string
  installUrl: string | null
  activated: boolean
}

type RowState = 'idle' | 'loading' | 'error'

export default function CliToolsApp(): React.ReactElement {
  const [tools, setTools] = useState<CliToolEntry[]>([])
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

  useEffect(() => {
    window.cliToolsApi.getAll().then(setTools)
  }, [])

  const activatedCount = tools.filter((t) => t.activated).length

  const handleActivate = async (toolId: string): Promise<void> => {
    setRowStates((s) => ({ ...s, [toolId]: 'loading' }))
    setRowErrors((e) => ({ ...e, [toolId]: '' }))
    const result = await window.cliToolsApi.activate(toolId)
    if (result.ok) {
      setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, activated: true } : t)))
      setRowStates((s) => ({ ...s, [toolId]: 'idle' }))
    } else {
      setRowStates((s) => ({ ...s, [toolId]: 'error' }))
      setRowErrors((e) => ({ ...e, [toolId]: result.error ?? 'Unknown error' }))
    }
  }

  const handleDeactivate = async (toolId: string): Promise<void> => {
    setOpenDropdown(null)
    await window.cliToolsApi.deactivate(toolId)
    setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, activated: false } : t)))
  }

  const handleClose = (): void => {
    window.cliToolsApi.close()
    window.close()
  }

  return (
    <div
      style={{
        padding: '20px 24px',
        color: '#ccc',
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: 13,
        background: '#1e1e1e',
        minHeight: '100vh',
        boxSizing: 'border-box'
      }}
      onClick={() => setOpenDropdown(null)}
    >
      <h2 style={{ margin: '0 0 6px', fontSize: 16, color: '#e0e0e0' }}>CLI Tools</h2>
      <p style={{ margin: '0 0 20px', fontSize: 12, color: '#777' }}>
        Activate the tools you have installed. AIDE will use activated tools to create sessions.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tools.map((tool) => {
          const state = rowStates[tool.id] ?? 'idle'
          const err = rowErrors[tool.id] ?? ''
          const isOpen = openDropdown === tool.id

          return (
            <div
              key={tool.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                padding: '10px 14px',
                background: '#252526',
                border: '1px solid #3d3d3d',
                borderRadius: 4
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: '#e0e0e0', marginBottom: 2 }}>{tool.name}</div>
                {tool.installUrl && (
                  <a
                    href={tool.installUrl}
                    onClick={(e) => { e.preventDefault(); window.open(tool.installUrl!) }}
                    style={{ fontSize: 11, color: '#569cd6', textDecoration: 'none' }}
                  >
                    ↗ Install
                  </a>
                )}
                {state === 'error' && err && (
                  <div style={{ fontSize: 11, color: '#f48771', marginTop: 4 }}>{err}</div>
                )}
              </div>

              <div style={{ position: 'relative', flexShrink: 0, marginLeft: 12 }}>
                {!tool.activated ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleActivate(tool.id) }}
                    disabled={state === 'loading'}
                    style={{
                      padding: '5px 14px',
                      background: state === 'loading' ? '#2d2d2d' : '#0e639c',
                      border: 'none',
                      borderRadius: 3,
                      color: state === 'loading' ? '#666' : '#fff',
                      fontSize: 12,
                      cursor: state === 'loading' ? 'default' : 'pointer'
                    }}
                  >
                    {state === 'loading' ? 'Checking…' : 'Activate'}
                  </button>
                ) : (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); setOpenDropdown(isOpen ? null : tool.id) }}
                      style={{
                        padding: '5px 12px',
                        background: '#2d4f2d',
                        border: '1px solid #3a6a3a',
                        borderRadius: 3,
                        color: '#89d185',
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6
                      }}
                    >
                      Activated ▾
                    </button>
                    {isOpen && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          position: 'absolute',
                          top: '100%',
                          right: 0,
                          marginTop: 2,
                          background: '#252526',
                          border: '1px solid #454545',
                          borderRadius: 3,
                          zIndex: 100,
                          minWidth: 110
                        }}
                      >
                        <button
                          onClick={() => handleDeactivate(tool.id)}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '7px 14px',
                            background: 'none',
                            border: 'none',
                            color: '#ccc',
                            fontSize: 12,
                            cursor: 'pointer',
                            textAlign: 'left'
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#37373d' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                        >
                          Deactivate
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {activatedCount === 0 && tools.length > 0 && (
        <p style={{ marginTop: 16, fontSize: 11, color: '#666', lineHeight: 1.5 }}>
          No tools activated — AIDE will open a plain terminal instead.
        </p>
      )}

      <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleClose}
          style={{
            padding: '6px 20px',
            background: '#3d3d3d',
            border: 'none',
            borderRadius: 3,
            color: '#d4d4d4',
            fontSize: 13,
            cursor: 'pointer'
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}
