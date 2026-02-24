import { BrowserWindow, shell } from 'electron'
import { join, basename } from 'path'
import { is } from '@electron-toolkit/utils'

export function createEditorWindow(projectPath: string): BrowserWindow {
  const folderName = basename(projectPath)

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    title: `AIDE — ${folderName}`,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/editor.js'),
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
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=editor')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'editor' }
    })
  }

  return win
}
