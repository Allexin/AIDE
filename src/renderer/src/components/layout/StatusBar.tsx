import React, { useEffect, useState } from 'react'
import { useFileTreeStore } from '../../store/useFileTreeStore'
import { useEditorStore } from '../../store/useEditorStore'
import { useSessionStore } from '../../store/useSessionStore'
import UpdateDialog from './UpdateDialog'
import { AccountLabel, UsageLabel, useAccountUsage } from '../cli/AccountUsage'

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

  // ── CLI account and usage limits sensors (left) ─────────────────────────────
  const activeToolId = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId)
    return tab?.toolId ?? null
  })
  const accountUsage = useAccountUsage(activeToolId)

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
        <AccountLabel info={accountUsage} style={sensorStyle} />
        <UsageLabel info={accountUsage} style={sensorStyle} />
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
