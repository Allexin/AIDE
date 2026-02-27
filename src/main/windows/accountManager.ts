import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let accountManagerWin: BrowserWindow | null = null

export function createAccountManagerWindow(parentWin?: BrowserWindow): BrowserWindow {
  // If already open, just focus it
  if (accountManagerWin && !accountManagerWin.isDestroyed()) {
    accountManagerWin.focus()
    return accountManagerWin
  }

  const win = new BrowserWindow({
    width: 560,
    height: 460,
    resizable: true,
    title: 'Manage Accounts',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    parent: parentWin,
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/accountManager.js'),
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
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=account-manager')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'account-manager' }
    })
  }

  accountManagerWin = win
  win.on('closed', () => {
    accountManagerWin = null
  })

  return win
}
