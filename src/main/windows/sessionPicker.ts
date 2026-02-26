import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { pickerEditorMap } from '../pty/registry'

export function createSessionPickerWindow(editorWin: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 500,
    height: 400,
    resizable: true,
    title: 'Sessions',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    parent: editorWin,
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/sessionPicker.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setMenuBarVisibility(false)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=session-picker')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'session-picker' }
    })
  }

  pickerEditorMap.set(win, editorWin)
  win.on('closed', () => pickerEditorMap.delete(win))

  return win
}
