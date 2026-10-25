import React, { useEffect, useState, useCallback } from 'react'

interface CliAccountInfo {
  id: string
  name: string
  identifier: string
  savedAt: string
  inPool: boolean
  exhausted: boolean
  exhaustedUntil: string | null
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
  getActiveAccount: (toolId: string) => Promise<string | null>
  setInPool: (toolId: string, accountId: string, inPool: boolean) => Promise<void>
  moveAccount: (toolId: string, accountId: string, delta: -1 | 1) => Promise<void>
  loadAccount: (toolId: string, accountId: string, autoSaveMode?: 'check' | 'force' | 'skip') => Promise<true | false | { conflict: AccountSwitchConflict }>
}

const api = () => (window as unknown as { accountManagerApi: AccountManagerAPI }).accountManagerApi

export default function AccountManagerApp(): React.ReactElement {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [activeToolId, setActiveToolId] = useState<string>('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginIdentifier, setLoginIdentifier] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<CliAccountInfo[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
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
    const [loggedInResult, identifier, accs, active] = await Promise.all([
      api().isLoggedIn(toolId),
      api().getLoginIdentifier(toolId),
      api().listAccounts(toolId),
      api().getActiveAccount(toolId)
    ])
    setLoggedIn(loggedInResult)
    setLoginIdentifier(identifier)
    setAccounts(accs)
    setActiveAccountId(active)
  }, [])

  useEffect(() => {
    refresh(activeToolId)
    // The pipeline account pool switches accounts and marks them exhausted while the window is open.
    const onFocus = (): void => { void refresh(activeToolId) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
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

  const handleInPool = async (accountId: string, inPool: boolean): Promise<void> => {
    await api().setInPool(activeToolId, accountId, inPool)
    refresh(activeToolId)
  }

  const handleMove = async (accountId: string, delta: -1 | 1): Promise<void> => {
    await api().moveAccount(activeToolId, accountId, delta)
    refresh(activeToolId)
  }

  const handleLoad = async (accountId: string, autoSaveMode: 'check' | 'force' | 'skip' = 'check'): Promise<void> => {
    const result = await api().loadAccount(activeToolId, accountId, autoSaveMode)
    if (result === true) {
      showToast('Account loaded')
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
            {accounts.map((acc, index) => (
              <div key={acc.id} style={styles.accountRow}>
                <input
                  type="checkbox"
                  style={styles.poolCheck}
                  checked={acc.inPool}
                  onChange={(e) => handleInPool(acc.id, e.target.checked)}
                  title="Switch to this account automatically when a pipeline step hits a usage limit"
                />
                <div style={styles.accountInfo}>
                  <div style={styles.accountName}>
                    {acc.name}
                    {acc.id === activeAccountId && <span style={styles.activeBadge}>active</span>}
                  </div>
                  <div style={styles.accountMeta}>
                    {acc.identifier} &middot; saved{' '}
                    {new Date(acc.savedAt).toLocaleDateString()}
                  </div>
                  {acc.exhausted && (
                    <div style={styles.exhausted}>
                      {acc.exhaustedUntil
                        ? `Usage limit reached — available again at ${new Date(acc.exhaustedUntil).toLocaleString()}`
                        : 'Usage limit reached — reset time unknown; load it by hand to use it again'}
                    </div>
                  )}
                </div>
                <div style={styles.accountActions}>
                  <button style={styles.smallBtn} disabled={index === 0} onClick={() => handleMove(acc.id, -1)} title="Move up (switching order)">
                    &uarr;
                  </button>
                  <button style={styles.smallBtn} disabled={index === accounts.length - 1} onClick={() => handleMove(acc.id, 1)} title="Move down (switching order)">
                    &darr;
                  </button>
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
        <PoolHint accounts={accounts} activeAccountId={activeAccountId} />
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

/** What the checked accounts mean for pipelines, and the one setup that cannot switch anywhere. */
function PoolHint({ accounts, activeAccountId }: { accounts: CliAccountInfo[]; activeAccountId: string | null }): React.ReactElement | null {
  if (accounts.length === 0) return null
  const checked = accounts.filter((acc) => acc.inPool)
  let text = 'Check accounts to switch to them automatically, top to bottom, when a pipeline step hits a usage limit.'
  let color = '#888'
  if (checked.length === 1 && checked[0].id === activeAccountId) {
    text = 'The only checked account is the active one — check another account to switch to when a pipeline step hits a usage limit.'
    color = '#dcdcaa'
  } else if (checked.length > 0) {
    text = 'When a pipeline step hits a usage limit, AIDE switches to the next checked account, top to bottom, restarts this CLI\'s tabs and resumes the run.'
  }
  return <div style={{ ...styles.hint, color }}>{text}</div>
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
  poolCheck: {
    marginRight: 10,
    cursor: 'pointer',
    flexShrink: 0
  },
  activeBadge: {
    marginLeft: 8,
    fontSize: 10,
    color: '#4ec9b0',
    border: '1px solid #4ec9b0',
    borderRadius: 3,
    padding: '0 4px',
    fontWeight: 400
  },
  exhausted: {
    fontSize: 11,
    color: '#dcdcaa',
    marginTop: 2
  },
  hint: {
    fontSize: 11,
    marginTop: 8,
    lineHeight: 1.4
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
