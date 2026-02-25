import React from 'react'
import PickerApp from './windows/PickerApp'
import EditorApp from './windows/EditorApp'
import SessionPickerApp from './windows/SessionPickerApp'

function getWindowType(): 'picker' | 'editor' | 'session-picker' {
  const params = new URLSearchParams(window.location.search)
  const w = params.get('window')
  if (w === 'editor') return 'editor'
  if (w === 'session-picker') return 'session-picker'
  return 'picker'
}

export default function App(): React.ReactElement {
  const windowType = getWindowType()
  if (windowType === 'editor') return <EditorApp />
  if (windowType === 'session-picker') return <SessionPickerApp />
  return <PickerApp />
}
