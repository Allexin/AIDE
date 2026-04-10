import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useEditorStore } from '../../store/useEditorStore'
import { useSessionStore } from '../../store/useSessionStore'
import UpdateDialog from './UpdateDialog'

// Maps Monaco language IDs to display names for the language sensor.
const LANG_DISPLAY: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  xml: 'XML',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  cpp: 'C++',
  c: 'C',
  csharp: 'C#',
  shell: 'Shell Script',
  yaml: 'YAML',
  ini: 'TOML',
  sql: 'SQL',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  r: 'R',
  dockerfile: 'Dockerfile',
  graphql: 'GraphQL',
  plaintext: 'Plain Text'
}

const sensorStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.9)',
  whiteSpace: 'nowrap',
  userSelect: 'none'
}

export default function StatusBar(): React.ReactElement {
  const { gitStatus } = useFileTreeStore()
  const { openRelativePath, cursorPosition, currentLanguage } = useEditorStore()

  // ── Update checker sensor ────────────────────────────────────────────────────
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [showUpdateDialog, setShowUpdateDialog] = useState(false)

  useEffect(() => {
    window.editorApi.updaterGetStatus().then((s) => {
      setUpdateStatus(s)
      if (s.shouldNotify) setShowUpdateDialog(true)
    })
    return window.editorApi.onUpdaterStatusChanged((s) => {
      setUpdateStatus(s)
      if (s.shouldNotify) setShowUpdateDialog(true)
    })
  }, [])

  // ── Git branch sensor (left) ─────────────────────────────────────────────────
  const branch = gitStatus?.available ? gitStatus.branch : null

  // ── File git status sensor (left) ───────────────────────────────────────────
  let fileStatus: '●' | '?' | '' = ''
  if (openRelativePath && gitStatus?.available) {
    if (gitStatus.untracked.includes(openRelativePath)) {
      fileStatus = '?'
    } else if (gitStatus.changed.includes(openRelativePath)) {
      fileStatus = '●'
    }
  }

  // ── CLI account sensor (left) ───────────────────────────────────────────────
  const [accountLabel, setAccountLabel] = useState<string | null>(null)
  const [accountSaved, setAccountSaved] = useState(true)
  const activeToolIdRef = useRef<string | null>(null)

  // ── Usage limits sensor (left, next to account) ────────────────────────────
  const [usageInfo, setUsageInfo] = useState<{ summary: string; tooltip: string; level: 'normal' | 'warn' | 'critical'; fetchedAt: number; hasLimit?: boolean } | null>(null)
  const lastUsageFetch = useRef(0)
  const [usageAge, setUsageAge] = useState('')

  // Reactive toolId from the active tab
  const activeToolId = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId)
    return tab?.toolId ?? null
  })

  const fetchAccountAndUsage = useCallback((toolId: string | null) => {
    activeToolIdRef.current = toolId
    if (!toolId) {
      // No integration — clear display
      setAccountLabel(null)
      setAccountSaved(true)
      setUsageInfo(null)
      return
    }

    // Fetch account info
    window.editorApi.getAccountCurrentInfo(toolId).then((info) => {
      if (info) {
        setAccountLabel(info.label)
        setAccountSaved(info.saved)
      } else {
        setAccountLabel(null)
      }
    })

    // Fetch usage
    lastUsageFetch.current = Date.now()
    window.editorApi.getUsageInfo(toolId).then((info) => {
      setUsageInfo(info)
    })
  }, [])

  // Load default tool ID on mount
  useEffect(() => {
    window.editorApi.getDefaultToolId().then(async (id) => {
      if (!id) {
        const activated = await window.editorApi.getActivatedTools()
        id = activated[0] ?? null
      }
      // Don't set activeToolIdRef here — it will be set reactively from the store
      fetchAccountAndUsage(id)
    })
  }, [fetchAccountAndUsage])

  // React to active tab changes — update account/usage when tab switches
  useEffect(() => {
    fetchAccountAndUsage(activeToolId)
  }, [activeToolId, fetchAccountAndUsage])

  // Listen to account changes and tab events (refresh data)
  useEffect(() => {
    const unsubs = [
      window.editorApi.onAccountsChanged(() => {
        if (activeToolIdRef.current) fetchAccountAndUsage(activeToolIdRef.current)
      }),
      window.editorApi.onTerminalSwitchTab(() => {
        // Tab switch is already handled reactively via activeToolId
        // This ensures refresh on push events from main process
        if (activeToolIdRef.current) fetchAccountAndUsage(activeToolIdRef.current)
      }),
      window.editorApi.onTerminalNewTab(() => {
        if (activeToolIdRef.current) fetchAccountAndUsage(activeToolIdRef.current)
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [fetchAccountAndUsage])

  // Update age label every second based on fetchedAt from the data itself
  useEffect(() => {
    const id = setInterval(() => {
      if (!usageInfo?.fetchedAt) return
      const sec = Math.floor((Date.now() - usageInfo.fetchedAt) / 1000)
      if (sec < 5) { setUsageAge(''); return }
      if (sec < 60) { setUsageAge(`${sec}s ago`); return }
      const min = Math.floor(sec / 60)
      if (min < 60) { setUsageAge(`${min}m ago`); return }
      const hr = Math.floor(min / 60)
      setUsageAge(`${hr}h${min % 60}m ago`)
    }, 1000)
    return () => clearInterval(id)
  }, [usageInfo?.fetchedAt])

  useEffect(() => {
    // Adaptive polling: 5 min focused, 20 min unfocused
    let timerId: ReturnType<typeof setInterval>

    const startInterval = (): void => {
      clearInterval(timerId)
      const ms = document.hasFocus() ? 300_000 : 1_200_000
      timerId = setInterval(() => {
        if (activeToolIdRef.current) {
          lastUsageFetch.current = Date.now()
          window.editorApi.getUsageInfo(activeToolIdRef.current).then((info) => {
            setUsageInfo(info)
          })
        }
      }, ms)
    }

    startInterval()

    const onFocus = (): void => {
      if (Date.now() - lastUsageFetch.current > 300_000 && activeToolIdRef.current) {
        lastUsageFetch.current = Date.now()
        window.editorApi.getUsageInfo(activeToolIdRef.current).then((info) => {
          setUsageInfo(info)
        })
      }
      startInterval()
    }
    const onBlur = (): void => startInterval()

    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    return () => {
      clearInterval(timerId)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // ── File language sensor (right) ────────────────────────────────────────────
  const langDisplay = currentLanguage ? (LANG_DISPLAY[currentLanguage] ?? currentLanguage) : null

  return (
    <div
      style={{
        height: 22,
        flexShrink: 0,
        background: '#007acc',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 10,
        paddingRight: 10,
        overflow: 'hidden'
      }}
    >
      {/* Left sensors */}
      <div style={{ display: 'flex', gap: 12, flex: 1, overflow: 'hidden', alignItems: 'center' }}>
        {branch && (
          <span style={sensorStyle} title="Git branch">
            ⎇ {branch}
          </span>
        )}
        {openRelativePath && fileStatus !== '' && (
          <span
            style={sensorStyle}
            title={fileStatus === '?' ? 'Untracked file' : 'File has uncommitted changes'}
          >
            {fileStatus}
          </span>
        )}
        {accountLabel && (
          <span
            style={{
              ...sensorStyle,
              color: accountSaved ? 'rgba(255,255,255,0.9)' : '#cca700'
            }}
            title={accountSaved ? 'CLI account' : 'CLI account not saved in AIDE'}
          >
            {accountLabel}
          </span>
        )}
        {usageInfo && (
          <span
            style={{
              ...sensorStyle,
              color: usageInfo.hasLimit === false
                ? 'rgba(255,255,255,0.9)'
                : usageInfo.level === 'critical' ? '#f44747'
                  : usageInfo.level === 'warn' ? '#cca700'
                  : 'rgba(255,255,255,0.9)'
            }}
            title={usageInfo.tooltip}
          >
            {usageInfo.summary}{usageAge && <span style={{ opacity: 0.6, marginLeft: 4 }}>({usageAge})</span>}
          </span>
        )}
      </div>

      {/* Right sensors */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0, alignItems: 'center' }}>
        {cursorPosition && (
          <span style={sensorStyle} title="Cursor position">
            Ln {cursorPosition.line}, Col {cursorPosition.column}
          </span>
        )}
        {langDisplay && (
          <span style={sensorStyle} title="File language">
            {langDisplay}
          </span>
        )}
        {openRelativePath && (
          <span style={sensorStyle} title="File encoding">
            UTF-8
          </span>
        )}
        {updateStatus?.hasUpdate ? (
          <span
            title={`Version v${updateStatus.latestVersion} is available. Click to view updates.`}
            onClick={() => setShowUpdateDialog(true)}
            style={{ cursor: 'pointer', display: 'flex', gap: 4, alignItems: 'center' }}
          >
            <span style={{ ...sensorStyle, color: '#f44747' }}>v{__APP_VERSION__}</span>
            <span style={{ ...sensorStyle, opacity: 0.6 }}>→</span>
            <span style={{ ...sensorStyle, color: '#4ec9b0' }}>v{updateStatus.latestVersion}</span>
          </span>
        ) : (
          <span style={{ ...sensorStyle, opacity: 0.7 }} title="App version">
            v{__APP_VERSION__}
          </span>
        )}
      </div>

      {showUpdateDialog && updateStatus?.hasUpdate && (
        <UpdateDialog
          status={updateStatus}
          onClose={() => setShowUpdateDialog(false)}
        />
      )}
    </div>
  )
}
