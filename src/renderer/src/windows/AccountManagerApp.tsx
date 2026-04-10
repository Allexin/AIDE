import React, { useEffect, useState, useCallback } from 'react'

interface CliAccountInfo {
  id: string
  name: string
  identifier: string
  savedAt: string
}

interface ToolInfo {
  id: string
  name: string
}

interface AccountSwitchConflict {
  savedName: string
  savedIdentifier: string
  currentIdentifier: string
}

interface AccountManagerAPI {
  getTools: () => Promise<ToolInfo[]>
  isLoggedIn: (toolId: string) => Promise<boolean>
  getLoginIdentifier: (toolId: string) => Promise<string | null>
  listAccounts: (toolId: string) => Promise<CliAccountInfo[]>
  saveCurrent: (toolId: string, name: string) => Promise<CliAccountInfo | null>
  deleteAccount: (toolId: string, accountId: string) => Promise<void>
  updateAccount: (toolId: string, accountId: string) => Promise<CliAccountInfo | null>
  loadAccount: (toolId: string, accountId: string, autoSaveMode?: 'check' | 'force' | 'skip') => Promise<true | false | { conflict: AccountSwitchConflict }>
}

const api = () => (window as unknown as { accountManagerApi: AccountManagerAPI }).accountManagerApi

export default function AccountManagerApp(): React.ReactElement {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [activeToolId, setActiveToolId] = useState<string>('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginIdentifier, setLoginIdentifier] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<CliAccountInfo[]>([])
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [conflict, setConflict] = useState<(AccountSwitchConflict & { accountId: string }) | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  useEffect(() => {
    api().getTools().then((t) => {
      setTools(t)
      if (t.length > 0) setActiveToolId(t[0].id)
    })
  }, [])

  const refresh = useCallback(async (toolId: string) => {
    if (!toolId) return
    const [loggedInResult, identifier, accs] = await Promise.all([
      api().isLoggedIn(toolId),
      api().getLoginIdentifier(toolId),
      api().listAccounts(toolId)
    ])
    setLoggedIn(loggedInResult)
    setLoginIdentifier(identifier)
    setAccounts(accs)
  }, [])

  useEffect(() => {
    refresh(activeToolId)
  }, [activeToolId, refresh])

  const handleSaveCurrent = async (): Promise<void> => {
    const name = saveName.trim()
    if (!name) return
    setSaving(true)
    const result = await api().saveCurrent(activeToolId, name)
    setSaving(false)
    if (result) {
      setSaveName('')
      showToast('Account saved')
      refresh(activeToolId)
    } else {
      showToast('Not logged in — cannot save')
    }
  }

  const handleDelete = async (accountId: string): Promise<void> => {
    await api().deleteAccount(activeToolId, accountId)
    showToast('Account deleted')
    refresh(activeToolId)
  }

  const handleUpdate = async (accountId: string): Promise<void> => {
    const result = await api().updateAccount(activeToolId, accountId)
    if (result) {
      showToast('Account updated with current credentials')
      refresh(activeToolId)
    } else {
      showToast('Not logged in — cannot update')
    }
  }

  const handleLoad = async (accountId: string, autoSaveMode: 'check' | 'force' | 'skip' = 'check'): Promise<void> => {
    const result = await api().loadAccount(activeToolId, accountId, autoSaveMode)
    if (result === true) {
      showToast('Account loaded — restart AIDE to apply')
      refresh(activeToolId)
    } else if (result === false) {
      showToast('Failed to load account')
    } else {
      setConflict({ ...result.conflict, accountId })
    }
  }

  return (
    <div style={styles.container}>
      {/* Tool tabs */}
      <div style={styles.tabBar}>
        {tools.map((t) => (
          <button
            key={t.id}
            style={{
              ...styles.tab,
              ...(t.id === activeToolId ? styles.tabActive : {})
            }}
            onClick={() => setActiveToolId(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* Status */}
      <div style={styles.section}>
        <div style={styles.statusLine}>
          <span style={{ color: loggedIn ? '#4ec9b0' : '#808080' }}>
            {loggedIn ? '\u25CF' : '\u25CB'}
          </span>
          {' '}
          {loggedIn
            ? `Logged in${loginIdentifier ? ` as ${loginIdentifier}` : ''}`
            : 'Not logged in'}
        </div>
      </div>

      {/* Saved accounts */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Saved accounts</div>
        {accounts.length === 0 ? (
          <div style={styles.empty}>No saved accounts</div>
        ) : (
          <div style={styles.accountList}>
            {accounts.map((acc) => (
              <div key={acc.id} style={styles.accountRow}>
                <div style={styles.accountInfo}>
                  <div style={styles.accountName}>{acc.name}</div>
                  <div style={styles.accountMeta}>
                    {acc.identifier} &middot; saved{' '}
                    {new Date(acc.savedAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={styles.accountActions}>
                  <button style={styles.smallBtn} onClick={() => handleLoad(acc.id)} title="Load this account's credentials">
                    Load
                  </button>
                  <button style={styles.smallBtn} onClick={() => handleUpdate(acc.id)} title="Update with current credentials">
                    Update
                  </button>
                  <button
                    style={{ ...styles.smallBtn, color: '#f44' }}
                    onClick={() => handleDelete(acc.id)}
                    title="Delete saved account"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Save current */}
      <div style={styles.section}>
        <div style={styles.saveRow}>
          <input
            style={styles.input}
            type="text"
            placeholder="Account name..."
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCurrent() }}
          />
          <button
            style={styles.btn}
            onClick={handleSaveCurrent}
            disabled={saving || !saveName.trim() || !loggedIn}
          >
            Save Current As...
          </button>
        </div>
      </div>

      {/* Conflict dialog */}
      {conflict && (
        <div style={styles.overlay}>
          <div style={styles.dialog}>
            <div style={styles.dialogTitle}>Account mismatch</div>
            <div style={styles.dialogBody}>
              <p>Account <strong>{conflict.savedName}</strong> was saved as <strong>{conflict.savedIdentifier}</strong>.</p>
              <p>Currently logged in as <strong>{conflict.currentIdentifier}</strong>.</p>
              <p>Overwrite <strong>{conflict.savedName}</strong> credentials with the current login?</p>
            </div>
            <div style={styles.dialogActions}>
              <button
                style={styles.btn}
                onClick={() => { setConflict(null); handleLoad(conflict.accountId, 'force') }}
              >
                Overwrite
              </button>
              <button
                style={styles.secondaryBtn}
                onClick={() => { setConflict(null); handleLoad(conflict.accountId, 'skip') }}
              >
                Skip &amp; Load
              </button>
              <button
                style={styles.secondaryBtn}
                onClick={() => setConflict(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <div style={styles.toast}>{toast}</div>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: 'Segoe UI, sans-serif',
    color: '#ccc',
    background: '#1e1e1e',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    padding: '0',
    position: 'relative',
    overflow: 'hidden'
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid #333',
    background: '#252526'
  },
  tab: {
    padding: '8px 16px',
    background: 'transparent',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: 13,
    borderBottom: '2px solid transparent'
  },
  tabActive: {
    color: '#ccc',
    borderBottomColor: '#569cd6'
  },
  section: {
    padding: '12px 16px'
  },
  sectionTitle: {
    fontSize: 12,
    color: '#888',
    marginBottom: 8,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px'
  },
  statusLine: {
    fontSize: 14
  },
  empty: {
    color: '#666',
    fontSize: 13,
    fontStyle: 'italic'
  },
  accountList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  accountRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    background: '#2d2d2d',
    borderRadius: 4
  },
  accountInfo: {
    flex: 1,
    minWidth: 0
  },
  accountName: {
    fontSize: 13,
    color: '#ddd',
    fontWeight: 500
  },
  accountMeta: {
    fontSize: 11,
    color: '#888',
    marginTop: 2
  },
  accountActions: {
    display: 'flex',
    gap: 4,
    marginLeft: 8,
    flexShrink: 0
  },
  smallBtn: {
    padding: '3px 8px',
    background: '#3c3c3c',
    border: '1px solid #555',
    borderRadius: 3,
    color: '#ccc',
    cursor: 'pointer',
    fontSize: 11
  },
  saveRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center'
  },
  input: {
    flex: 1,
    padding: '6px 10px',
    background: '#3c3c3c',
    border: '1px solid #555',
    borderRadius: 4,
    color: '#ccc',
    fontSize: 13,
    outline: 'none'
  },
  btn: {
    padding: '6px 14px',
    background: '#0e639c',
    border: 'none',
    borderRadius: 4,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    whiteSpace: 'nowrap' as const
  },
  toast: {
    position: 'absolute',
    bottom: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#333',
    color: '#ccc',
    padding: '8px 16px',
    borderRadius: 6,
    fontSize: 13,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    zIndex: 100
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200
  },
  dialog: {
    background: '#252526',
    border: '1px solid #444',
    borderRadius: 6,
    padding: '20px 24px',
    maxWidth: 380,
    width: '90%',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)'
  },
  dialogTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#ddd',
    marginBottom: 12
  },
  dialogBody: {
    fontSize: 13,
    color: '#bbb',
    lineHeight: 1.5,
    marginBottom: 16
  },
  dialogActions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end'
  },
  secondaryBtn: {
    padding: '6px 14px',
    background: '#3c3c3c',
    border: '1px solid #555',
    borderRadius: 4,
    color: '#ccc',
    cursor: 'pointer',
    fontSize: 13,
    whiteSpace: 'nowrap' as const
  }
}
