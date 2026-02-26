import { Menu, MenuItem, BrowserWindow, dialog, app } from 'electron'
import { basename } from 'path'
import { existsSync } from 'fs'
import { getAppState } from '../config/appState'
import { getAppConfig } from '../config/appConfig'
import { createPickerWindow } from '../windows/picker'
import { getRunningCount, killAllProcesses } from '../toolbar/processManager'
import { registerCommand } from './commandRegistry'

// Injected by setupMenu — avoids circular dep with windows/editor.ts
type OpenProjectFn = (path: string) => { success: boolean; error?: string }
let openProjectsRef: Map<string, BrowserWindow> | null = null
let openProjectFn: OpenProjectFn | null = null

// Per-window: does this editor have a file open?
const editorFileOpenMap = new Map<BrowserWindow, boolean>()

// True while switching projects — suppresses window-all-closed → app.quit()
let switchingProject = false
export function isSwitchingProject(): boolean { return switchingProject }

// Stored refs to Edit submenu items for direct .enabled updates (no full rebuild)
const editMenuItems: MenuItem[] = []

// ── Helpers ────────────────────────────────────────────────────────────────────

function getEditorWindow(): BrowserWindow | null {
  if (!openProjectsRef) return null
  return openProjectsRef.values().next().value ?? null
}

// Cheap update — just flips .enabled on stored refs, no rebuild
function updateEditEnabled(): void {
  const win = getEditorWindow()
  const enabled = win ? (editorFileOpenMap.get(win) ?? false) : false
  for (const item of editMenuItems) {
    item.enabled = enabled
  }
}

function sendEditCommand(command: string): void {
  const win = getEditorWindow()
  if (!win) return
  if (!(editorFileOpenMap.get(win) ?? false)) return
  win.webContents.send('menu:edit-command', command)
}

async function checkRunningAndProceed(
  win: BrowserWindow,
  action: () => Promise<void>
): Promise<void> {
  const count = getRunningCount(win)
  if (count === 0) {
    await action()
    return
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'AIDE',
    message: `${count} process${count !== 1 ? 'es are' : ' is'} still running.`,
    detail: 'Close AIDE anyway?',
    buttons: ['Yes', 'No'],
    defaultId: 1,
    cancelId: 1
  })
  if (response === 0) {
    killAllProcesses(win)
    await action()
  }
}

function switchProject(newPath: string, currentWin: BrowserWindow): void {
  if (!openProjectFn || !openProjectsRef) return
  switchingProject = true
  currentWin.once('closed', () => {
    setImmediate(() => {
      switchingProject = false
      if (!openProjectFn || !openProjectsRef) return
      const result = openProjectFn(newPath)
      if (!result.success) createPickerWindow()
    })
  })
  currentWin.destroy()
}

async function handleOpenFolder(): Promise<void> {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return

  const editorWin = getEditorWindow()
  if (editorWin) {
    await checkRunningAndProceed(editorWin, async () => {
      const result = await dialog.showOpenDialog(editorWin, { properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return
      const newPath = result.filePaths[0]
      // A1: already open → just focus, no switch
      if (openProjectsRef?.has(newPath)) {
        openProjectsRef.get(newPath)!.focus()
        return
      }
      switchProject(newPath, editorWin)
    })
  } else {
    const result = await dialog.showOpenDialog(focused, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    const newPath = result.filePaths[0]
    // A1: already open → just focus, no switch
    if (openProjectsRef?.has(newPath)) {
      openProjectsRef.get(newPath)!.focus()
      return
    }
    focused.close()
    if (openProjectFn && openProjectsRef) {
      const openResult = openProjectFn(newPath)
      if (!openResult.success) createPickerWindow()
    }
  }
}

async function handleOpenRecent(projectPath: string): Promise<void> {
  if (!existsSync(projectPath)) {
    dialog.showErrorBox('AIDE', `Path no longer exists:\n${projectPath}`)
    return
  }

  // A1: already open → just focus, no switch
  if (openProjectsRef?.has(projectPath)) {
    openProjectsRef.get(projectPath)!.focus()
    return
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return

  const editorWin = getEditorWindow()
  if (editorWin) {
    await checkRunningAndProceed(editorWin, async () => {
      switchProject(projectPath, editorWin)
    })
  } else {
    focused.close()
    if (openProjectFn && openProjectsRef) {
      const openResult = openProjectFn(projectPath)
      if (!openResult.success) createPickerWindow()
    }
  }
}

// ── Full rebuild — call only when menu content changes (Open Recent list) ──────

export function rebuildMenu(): void {
  editMenuItems.length = 0

  const state = getAppState()
  const config = getAppConfig()
  const recentProjects = state.recentProjects.slice(0, config.sessions.maxRecentProjects)

  const recentSubmenu: Electron.MenuItemConstructorOptions[] =
    recentProjects.length > 0
      ? recentProjects.map((p) => ({
          label: basename(p.path),
          click: (): void => { handleOpenRecent(p.path) }
        }))
      : [{ label: 'No recent projects', enabled: false }]

  const win = getEditorWindow()
  const editEnabled = win ? (editorFileOpenMap.get(win) ?? false) : false

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Window',    click: (): void => { createPickerWindow() } },
        { label: 'Open Folder...', click: (): void => { handleOpenFolder() } },
        { label: 'Open Recent',   submenu: recentSubmenu },
        { type: 'separator' },
        { label: 'Exit',          click: (): void => { app.quit() } }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo',  enabled: editEnabled, click: (): void => sendEditCommand('undo') },
        { label: 'Redo',  enabled: editEnabled, click: (): void => sendEditCommand('redo') },
        { type: 'separator' },
        { label: 'Cut',   enabled: editEnabled, click: (): void => sendEditCommand('cut') },
        { label: 'Copy',  enabled: editEnabled, click: (): void => sendEditCommand('copy') },
        { label: 'Paste', enabled: editEnabled, click: (): void => sendEditCommand('paste') }
      ]
    }
  ]

  const appMenu = Menu.buildFromTemplate(template)

  // Store Edit submenu item refs for future .enabled updates without rebuild
  const editMenu = appMenu.items.find((i) => i.label === 'Edit')
  if (editMenu?.submenu) {
    for (const item of editMenu.submenu.items) {
      if (item.type !== 'separator') editMenuItems.push(item)
    }
  }

  Menu.setApplicationMenu(appMenu)
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function setEditorFileOpen(win: BrowserWindow, hasFile: boolean): void {
  editorFileOpenMap.set(win, hasFile)
  updateEditEnabled()
}

export function removeEditorWindow(win: BrowserWindow): void {
  editorFileOpenMap.delete(win)
  updateEditEnabled()
}

export function setupMenu(
  openProjects: Map<string, BrowserWindow>,
  openProject: OpenProjectFn
): void {
  openProjectsRef = openProjects
  openProjectFn = openProject

  registerCommand('file.newWindow',  () => { createPickerWindow() })
  registerCommand('file.openFolder', () => handleOpenFolder())
  registerCommand('file.exit',       () => app.quit())
  registerCommand('edit.undo',       () => sendEditCommand('undo'))
  registerCommand('edit.redo',       () => sendEditCommand('redo'))
  registerCommand('edit.cut',        () => sendEditCommand('cut'))
  registerCommand('edit.copy',       () => sendEditCommand('copy'))
  registerCommand('edit.paste',      () => sendEditCommand('paste'))

  rebuildMenu()
}
