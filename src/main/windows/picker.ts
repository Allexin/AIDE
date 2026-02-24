import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export function createPickerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 500,
    height: 400,
    minWidth: 400,
    minHeight: 300,
    resizable: true,
    title: 'AIDE — Open Project',
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=picker')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'picker' }
    })
  }

  return win
}
