import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { rendererDevUrl } from '../devEnv'

let settingsWin: BrowserWindow | null = null

export function createSettingsWindow(parentWin?: BrowserWindow): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return settingsWin
  }

  const win = new BrowserWindow({
    width: 620,
    height: 560,
    minWidth: 480,
    minHeight: 400,
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

  if (is.dev && rendererDevUrl) {
    win.loadURL(rendererDevUrl + '/?window=settings')
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
