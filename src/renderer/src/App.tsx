import React, { Suspense } from 'react'

const PickerApp = React.lazy(() => import('./windows/PickerApp'))
const EditorApp = React.lazy(() => import('./windows/EditorApp'))
const SessionPickerApp = React.lazy(() => import('./windows/SessionPickerApp'))
const AccountManagerApp = React.lazy(() => import('./windows/AccountManagerApp'))
const SettingsApp = React.lazy(() => import('./windows/SettingsApp'))

function getWindowType(): 'picker' | 'editor' | 'session-picker' | 'account-manager' | 'settings' {
  const params = new URLSearchParams(window.location.search)
  const w = params.get('window')
  if (w === 'editor') return 'editor'
  if (w === 'session-picker') return 'session-picker'
  if (w === 'account-manager') return 'account-manager'
  if (w === 'settings') return 'settings'
  return 'picker'
}

export default function App(): React.ReactElement {
  const windowType = getWindowType()
  return (
    <Suspense fallback={null}>
      {windowType === 'editor' && <EditorApp />}
      {windowType === 'session-picker' && <SessionPickerApp />}
      {windowType === 'account-manager' && <AccountManagerApp />}
      {windowType === 'settings' && <SettingsApp />}
      {windowType === 'picker' && <PickerApp />}
    </Suspense>
  )
}
