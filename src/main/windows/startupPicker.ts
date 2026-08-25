import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { rendererDevUrl } from '../devEnv'
import type { SavedSessionEntry } from '../config/appState'

export interface StartupPickerCandidate extends SavedSessionEntry {
  key: string
  firstMessage: string
  mtime: number
  toolName: string
  available: boolean
  unavailableReason?: string
}

export interface StartupPickerContext {
  editorWin: BrowserWindow
  projectPath: string
  candidates: StartupPickerCandidate[]
  tools: Array<{ id: string; name: string }>
  defaultToolId: string
  initialSessionKey: string | null
}

export interface StartupPickerSelection {
  sessions: SavedSessionEntry[]
  newToolId: string
}

interface PendingStartupPicker {
  context: StartupPickerContext
  resolve: (selection: StartupPickerSelection) => void
  resolved: boolean
}

const pendingPickers = new Map<BrowserWindow, PendingStartupPicker>()

export function getStartupPickerContext(win: BrowserWindow): StartupPickerContext | null {
  return pendingPickers.get(win)?.context ?? null
}

export function resolveStartupPicker(
  win: BrowserWindow,
  selectedKeys: string[],
  requestedToolId: string
): void {
  const pending = pendingPickers.get(win)
  if (!pending || pending.resolved) return

  const selected = new Set(selectedKeys)
  const sessions = pending.context.candidates
    .filter((candidate) => candidate.available && selected.has(candidate.key) && candidate.sessionId)
    .map(({ sessionId, title, toolId }) => ({ sessionId, title, toolId }))
  const newToolId = pending.context.tools.some((tool) => tool.id === requestedToolId)
    ? requestedToolId
    : pending.context.defaultToolId

  pending.resolved = true
  pending.resolve({ sessions, newToolId })
  if (!win.isDestroyed()) win.close()
}

export function createStartupPickerWindow(context: StartupPickerContext): Promise<StartupPickerSelection> {
  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 760,
    minHeight: 480,
    resizable: true,
    title: 'Start AIDE Session',
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    parent: context.editorWin,
    modal: true,
    webPreferences: {
      preload: join(__dirname, '../preload/startupPicker.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const result = new Promise<StartupPickerSelection>((resolve) => {
    pendingPickers.set(win, { context, resolve, resolved: false })
  })

  win.on('closed', () => {
    const pending = pendingPickers.get(win)
    if (pending && !pending.resolved) {
      pending.resolved = true
      pending.resolve({ sessions: [], newToolId: context.defaultToolId })
    }
    pendingPickers.delete(win)
  })

  if (is.dev && rendererDevUrl) {
    void win.loadURL(rendererDevUrl + '/?window=startup-picker')
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'startup-picker' }
    })
  }

  return result
}
