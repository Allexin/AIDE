import React from 'react'
import PickerApp from './windows/PickerApp'
import EditorApp from './windows/EditorApp'

function getWindowType(): 'picker' | 'editor' {
  const params = new URLSearchParams(window.location.search)
  return params.get('window') === 'editor' ? 'editor' : 'picker'
}

export default function App(): React.ReactElement {
  const windowType = getWindowType()
  return windowType === 'editor' ? <EditorApp /> : <PickerApp />
}
