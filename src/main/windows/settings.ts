import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let settingsWin: BrowserWindow | null = null

export function createSettingsWindow(parentWin?: BrowserWindow): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return settingsWin
  }

  const win = new BrowserWindow({
    width: 500,
    height: 350,
    resizable: true,
    title: 'AIDE Settings',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    parent: parentWin,
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/settings.js'),
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
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=settings')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }

  settingsWin = win
  win.on('closed', () => {
    settingsWin = null
  })

  return win
}
