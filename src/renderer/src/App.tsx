import React, { Suspense } from 'react'

const PickerApp = React.lazy(() => import('./windows/PickerApp'))
const EditorApp = React.lazy(() => import('./windows/EditorApp'))
const SessionPickerApp = React.lazy(() => import('./windows/SessionPickerApp'))
const StartupPickerApp = React.lazy(() => import('./windows/StartupPickerApp'))
const AccountManagerApp = React.lazy(() => import('./windows/AccountManagerApp'))
const SettingsApp = React.lazy(() => import('./windows/SettingsApp'))
const CliToolsApp = React.lazy(() => import('./windows/CliToolsApp'))
const HistoryViewerApp = React.lazy(() => import('./windows/HistoryViewerApp'))
const FileViewerApp = React.lazy(() => import('./windows/FileViewerApp'))

function getWindowType(): 'picker' | 'editor' | 'session-picker' | 'startup-picker' | 'account-manager' | 'settings' | 'cli-tools' | 'history-viewer' | 'file-viewer' {
  const params = new URLSearchParams(window.location.search)
  const w = params.get('window')
  if (w === 'editor') return 'editor'
  if (w === 'session-picker') return 'session-picker'
  if (w === 'startup-picker') return 'startup-picker'
  if (w === 'account-manager') return 'account-manager'
  if (w === 'settings') return 'settings'
  if (w === 'cli-tools') return 'cli-tools'
  if (w === 'history-viewer') return 'history-viewer'
  if (w === 'file-viewer') return 'file-viewer'
  return 'picker'
}

export default function App(): React.ReactElement {
  const windowType = getWindowType()
  return (
    <Suspense fallback={null}>
      {windowType === 'editor' && <EditorApp />}
      {windowType === 'session-picker' && <SessionPickerApp />}
      {windowType === 'startup-picker' && <StartupPickerApp />}
      {windowType === 'account-manager' && <AccountManagerApp />}
      {windowType === 'settings' && <SettingsApp />}
      {windowType === 'cli-tools' && <CliToolsApp />}
      {windowType === 'history-viewer' && <HistoryViewerApp />}
      {windowType === 'file-viewer' && <FileViewerApp />}
      {windowType === 'picker' && <PickerApp />}
    </Suspense>
  )
}
