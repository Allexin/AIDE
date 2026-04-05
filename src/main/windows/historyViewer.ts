import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { HistoryEntry } from '../pty/cliTools/types'

export interface HistoryViewerContext {
  projectPath: string
  sessionId: string
  toolId: string
  title: string
  entries: HistoryEntry[]
}

export const historyViewerDataMap = new Map<BrowserWindow, HistoryViewerContext>()

export function createHistoryViewerWindow(context: HistoryViewerContext): BrowserWindow {
  const win = new BrowserWindow({
    width: 780,
    height: 640,
    minWidth: 480,
    minHeight: 400,
    resizable: true,
    title: context.title || 'Session History',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/historyViewer.js'),
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

  historyViewerDataMap.set(win, context)
  win.on('closed', () => historyViewerDataMap.delete(win))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=history-viewer')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'history-viewer' }
    })
  }

  return win
}
