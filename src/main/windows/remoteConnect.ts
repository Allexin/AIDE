import { BrowserWindow, shell } from 'electron'
import { join } from 'path'

let win: BrowserWindow | null = null

export function openRemoteConnectWindow(port: number): void {
  if (win && !win.isDestroyed()) {
    win.reload()
    win.focus()
    return
  }

  win = new BrowserWindow({
    width: 360,
    height: 480,
    resizable: false,
    title: 'Remote Connect',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/remoteConnect.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  win.setMenuBarVisibility(false)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.loadURL(`http://127.0.0.1:${port}/connect`)

  win.on('closed', () => { win = null })
}
