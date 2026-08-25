import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { rendererDevUrl } from '../devEnv'

export function openCliToolsWindow(parentWin: BrowserWindow): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    title: 'CLI Tools',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    parent: parentWin,
    modal: true,
    webPreferences: {
      preload: join(__dirname, '../preload/cliTools.js'),
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
    win.loadURL(rendererDevUrl + '/?window=cli-tools')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'cli-tools' }
    })
  }

  return win
}
