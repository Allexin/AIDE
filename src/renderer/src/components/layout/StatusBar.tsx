import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useEditorStore } from '../../store/useEditorStore'

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

  const refreshAccount = React.useCallback(() => {
    const toolId = 'claude-code'
    window.editorApi.getAccountCurrentInfo(toolId).then((info) => {
      if (info) {
        setAccountLabel(info.label)
        setAccountSaved(info.saved)
      } else {
        setAccountLabel(null)
      }
    })
  }, [])

  useEffect(() => {
    refreshAccount()
    const unsubs = [
      window.editorApi.onAccountsChanged(refreshAccount),
      window.editorApi.onTerminalSwitchTab(refreshAccount),
      window.editorApi.onTerminalNewTab(refreshAccount)
    ]
    return () => unsubs.forEach((u) => u())
  }, [refreshAccount])

  // ── Usage limits sensor (left, next to account) ────────────────────────────
  const [usageInfo, setUsageInfo] = useState<{ summary: string; tooltip: string; level: 'normal' | 'warn' | 'critical'; fetchedAt: number } | null>(null)
  const lastUsageFetch = useRef(0)
  const [usageAge, setUsageAge] = useState('')

  const fetchUsage = useCallback(() => {
    lastUsageFetch.current = Date.now()
    window.editorApi.getUsageInfo('claude-code').then((info) => {
      setUsageInfo(info)
    })
  }, [])

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
    fetchUsage()

    // Adaptive polling: 5 min focused, 20 min unfocused
    let timerId: ReturnType<typeof setInterval>

    const startInterval = (): void => {
      clearInterval(timerId)
      const ms = document.hasFocus() ? 300_000 : 1_200_000
      timerId = setInterval(fetchUsage, ms)
    }

    startInterval()

    const onFocus = (): void => {
      // If >5 min since last fetch, refresh immediately
      if (Date.now() - lastUsageFetch.current > 300_000) fetchUsage()
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
  }, [fetchUsage])

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
              color: usageInfo.level === 'critical' ? '#f44747'
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
        <span style={{ ...sensorStyle, opacity: 0.7 }} title="App version">
          v{__APP_VERSION__}
        </span>
      </div>
    </div>
  )
}
