import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { watch, openSync, fstatSync, readSync, closeSync, existsSync } from 'fs'
import type { FSWatcher } from 'fs'
import { is } from '@electron-toolkit/utils'
import type { HistoryEntry } from '../pty/cliTools/types'
import { parseHistoryLine } from '../pty/cliTools/claudeCodeScanner'

export interface HistoryViewerContext {
  projectPath: string
  sessionId: string
  toolId: string
  title: string
  entries: HistoryEntry[]
}

export const historyViewerDataMap = new Map<BrowserWindow, HistoryViewerContext>()

interface HistoryWatchState {
  filePath: string
  offset: number
  watcher: FSWatcher | null
}

const historyWatchMap = new Map<BrowserWindow, HistoryWatchState>()

export function watchHistoryFile(win: BrowserWindow, filePath: string | null): void {
  if (!filePath) return

  let initialOffset = 0
  if (existsSync(filePath)) {
    try {
      const fd = openSync(filePath, 'r')
      initialOffset = fstatSync(fd).size
      closeSync(fd)
    } catch { /* ignore */ }
  }

  const state: HistoryWatchState = { filePath, offset: initialOffset, watcher: null }
  historyWatchMap.set(win, state)

  if (existsSync(filePath)) {
    attachHistoryWatcher(win, state)
  }
}

function attachHistoryWatcher(win: BrowserWindow, state: HistoryWatchState): void {
  try {
    state.watcher = watch(state.filePath, () => readNewHistoryEntries(win, state))
  } catch { /* ignore */ }
}

function readNewHistoryEntries(win: BrowserWindow, state: HistoryWatchState): void {
  if (!existsSync(state.filePath)) return

  let fd: number
  try {
    fd = openSync(state.filePath, 'r')
  } catch {
    return
  }

  try {
    const fileSize = fstatSync(fd).size
    if (fileSize <= state.offset) return

    const len = fileSize - state.offset
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, state.offset)
    state.offset = fileSize

    const text = buf.toString('utf-8')
    const newEntries: HistoryEntry[] = []

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const entry = parseHistoryLine(trimmed)
      if (entry) newEntries.push(entry)
    }

    if (newEntries.length > 0 && !win.isDestroyed()) {
      win.webContents.send('history-viewer:new-entries', newEntries)
    }
  } finally {
    closeSync(fd)
  }
}

function stopWatchingHistory(win: BrowserWindow): void {
  const state = historyWatchMap.get(win)
  if (!state) return
  state.watcher?.close()
  historyWatchMap.delete(win)
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
    stopWatchingHistory(win)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/?window=history-viewer')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'history-viewer' }
    })
  }

  return win
}
