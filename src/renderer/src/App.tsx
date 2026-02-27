import React from 'react'
import PickerApp from './windows/PickerApp'
import EditorApp from './windows/EditorApp'
import SessionPickerApp from './windows/SessionPickerApp'
import AccountManagerApp from './windows/AccountManagerApp'

function getWindowType(): 'picker' | 'editor' | 'session-picker' | 'account-manager' {
  const params = new URLSearchParams(window.location.search)
  const w = params.get('window')
  if (w === 'editor') return 'editor'
  if (w === 'session-picker') return 'session-picker'
  if (w === 'account-manager') return 'account-manager'
  return 'picker'
}

export default function App(): React.ReactElement {
  const windowType = getWindowType()
  if (windowType === 'editor') return <EditorApp />
  if (windowType === 'session-picker') return <SessionPickerApp />
  if (windowType === 'account-manager') return <AccountManagerApp />
  return <PickerApp />
}
