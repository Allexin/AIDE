import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { rendererDevUrl } from '../devEnv'

export function createPickerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 500,
    height: 400,
    minWidth: 400,
    minHeight: 300,
    resizable: true,
    title: 'AIDE — Open Project',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/picker.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && rendererDevUrl) {
    win.loadURL(rendererDevUrl + '/?window=picker')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'picker' }
    })
  }

  return win
}
