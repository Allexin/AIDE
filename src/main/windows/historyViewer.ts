import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { rendererDevUrl } from '../devEnv'
import type { HistoryEntry } from '../pty/cliTools/types'
import { getToolById } from '../pty/cliTools/registry'

export interface HistoryViewerContext {
  projectPath: string
  sessionId: string
  toolId: string
  title: string
  entries: HistoryEntry[]
}

export const historyViewerDataMap = new Map<BrowserWindow, HistoryViewerContext>()

/** Active subscriptions: window → cleanup function */
const historySubscriptions = new Map<BrowserWindow, () => void>()

/** Start subscribing to live history updates for the given tool/session. */
export function subscribeToHistory(win: BrowserWindow, context: HistoryViewerContext): void {
  // Clean up any existing subscription
  stopSubscribing(win)

  const tool = getToolById(context.toolId)
  if (!tool?.subscribeToSessionHistory) return

  const cleanup = tool.subscribeToSessionHistory(
    context.projectPath,
    context.sessionId,
    (entry: HistoryEntry) => {
      if (!win.isDestroyed()) {
        win.webContents.send('history-viewer:new-entries', [entry])
      }
    }
  )

  historySubscriptions.set(win, cleanup)
}

/** Stop any active subscription for the given window. */
function stopSubscribing(win: BrowserWindow): void {
  const cleanup = historySubscriptions.get(win)
  if (cleanup) {
    cleanup()
    historySubscriptions.delete(win)
  }
}

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
  win.on('closed', () => {
    historyViewerDataMap.delete(win)
    stopSubscribing(win)
  })

  // Start live subscription only after the renderer has loaded its IPC listeners
  win.webContents.once('did-finish-load', () => subscribeToHistory(win, context))

  if (is.dev && rendererDevUrl) {
    win.loadURL(rendererDevUrl + '/?window=history-viewer')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'history-viewer' }
    })
  }

  return win
}
