import { Menu, MenuItem, BrowserWindow, dialog, app } from 'electron'
import { basename } from 'path'
import { existsSync } from 'fs'
import { getAppState } from '../config/appState'
import { getAppConfig } from '../config/appConfig'
import { createPickerWindow } from '../windows/picker'
import { createAccountManagerWindow } from '../windows/accountManager'
import { createSettingsWindow } from '../windows/settings'
import { openCliToolsWindow } from '../windows/cliTools'
import { getRunningCount, killAllProcesses } from '../toolbar/processManager'
import { registerCommand } from './commandRegistry'
import { getRegisteredTools, getToolById } from '../pty/cliTools/registry'
import { listAccounts, updateAccount as updateStoredAccount, getActiveAccount, setActiveAccount } from '../config/accountStorage'
import { restartToolSessions } from '../pty/registry'

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

async function askWhereToOpen(parentWin: BrowserWindow): Promise<'current' | 'new' | null> {
  const { response } = await dialog.showMessageBox(parentWin, {
    type: 'question',
    title: 'AIDE',
    message: 'Where to open the project?',
    buttons: ['This Window', 'New Window', 'Cancel'],
    defaultId: 0,
    cancelId: 2
  })
  if (response === 0) return 'current'
  if (response === 1) return 'new'
  return null
}

function openInNewWindow(projectPath: string): void {
  if (!openProjectFn) return
  const result = openProjectFn(projectPath)
  if (!result.success) createPickerWindow()
}

async function handleOpenFolder(): Promise<void> {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return

  // Find focused editor window (not just the first one in the map)
  const focusedEditorWin = openProjectsRef
    ? [...openProjectsRef.values()].find((w) => w.id === focused.id) ?? null
    : null

  if (focusedEditorWin) {
    const result = await dialog.showOpenDialog(focusedEditorWin, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    const newPath = result.filePaths[0]
    // Already open → just focus
    if (openProjectsRef?.has(newPath)) {
      openProjectsRef.get(newPath)!.focus()
      return
    }
    const choice = await askWhereToOpen(focusedEditorWin)
    if (!choice) return
    if (choice === 'new') {
      openInNewWindow(newPath)
    } else {
      await checkRunningAndProceed(focusedEditorWin, async () => {
        switchProject(newPath, focusedEditorWin)
      })
    }
  } else {
    const result = await dialog.showOpenDialog(focused, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return
    const newPath = result.filePaths[0]
    if (openProjectsRef?.has(newPath)) {
      openProjectsRef.get(newPath)!.focus()
      return
    }
    focused.close()
    openInNewWindow(newPath)
  }
}

async function handleOpenRecent(projectPath: string): Promise<void> {
  if (!existsSync(projectPath)) {
    dialog.showErrorBox('AIDE', `Path no longer exists:\n${projectPath}`)
    return
  }

  // Already open → just focus
  if (openProjectsRef?.has(projectPath)) {
    openProjectsRef.get(projectPath)!.focus()
    return
  }

  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return

  // Find focused editor window (not just the first one in the map)
  const focusedEditorWin = openProjectsRef
    ? [...openProjectsRef.values()].find((w) => w.id === focused.id) ?? null
    : null

  if (focusedEditorWin) {
    const choice = await askWhereToOpen(focusedEditorWin)
    if (!choice) return
    if (choice === 'new') {
      openInNewWindow(projectPath)
    } else {
      await checkRunningAndProceed(focusedEditorWin, async () => {
        switchProject(projectPath, focusedEditorWin)
      })
    }
  } else {
    focused.close()
    openInNewWindow(projectPath)
  }
}

/**
 * Auto-save current credentials into the tracked active account before switching.
 * Returns false if the user cancelled due to an identifier mismatch.
 */
async function autoSaveCurrentCredentials(toolId: string): Promise<boolean> {
  const activeId = getActiveAccount(toolId)
  if (!activeId) return true

  const t = getToolById(toolId)
  if (!t?.exportCredentials || !t?.getLoginIdentifier) return true

  const [creds, currentIdentifier] = await Promise.all([
    t.exportCredentials(),
    t.getLoginIdentifier()
  ])
  if (!creds || !currentIdentifier) return true

  const saved = listAccounts(toolId).find((a) => a.id === activeId)
  if (!saved) return true

  if (saved.identifier !== currentIdentifier) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Account mismatch',
      message: `Account "${saved.name}" was saved as ${saved.identifier}, but currently logged in as ${currentIdentifier}.\n\nOverwrite "${saved.name}" credentials with the current login?`,
      buttons: ['Overwrite', 'Skip', 'Cancel'],
      defaultId: 0,
      cancelId: 2
    })
    if (response === 2) return false // Cancel — abort the switch entirely
    if (response === 1) return true  // Skip — proceed without saving
  }

  updateStoredAccount(toolId, activeId, currentIdentifier, creds)
  return true
}

function broadcastAccountsChanged(): void {
  if (!openProjectsRef) return
  for (const win of openProjectsRef.values()) {
    if (!win.isDestroyed()) win.webContents.send('accounts:changed')
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

  // Build "Load Account" submenu per tool
  const loadAccountSubmenu: Electron.MenuItemConstructorOptions[] = []
  for (const tool of getRegisteredTools()) {
    const cliTool = getToolById(tool.id)
    if (cliTool && !cliTool.hasAccountSystem()) continue

    const accs = listAccounts(tool.id)
    const toolSubmenu: Electron.MenuItemConstructorOptions[] = []

    // Logout item — clears credentials locally without revoking tokens
    if (cliTool?.clearCredentials) {
      toolSubmenu.push({
        label: 'Logout',
        click: async (): Promise<void> => {
          await cliTool.clearCredentials!()
          restartToolSessions(tool.id)
          broadcastAccountsChanged()
        }
      })
      toolSubmenu.push({ type: 'separator' })
    }

    if (accs.length === 0) {
      toolSubmenu.push({ label: 'No saved accounts', enabled: false })
    } else {
      for (const acc of accs) {
        toolSubmenu.push({
          label: acc.name,
          click: async (): Promise<void> => {
            const t = getToolById(tool.id)
            if (!t?.importCredentials) return
            const stored = listAccounts(tool.id).find((a) => a.id === acc.id)
            if (!stored) return
            const proceed = await autoSaveCurrentCredentials(tool.id)
            if (!proceed) return
            await t.importCredentials(stored.credentials)
            setActiveAccount(tool.id, acc.id)
            restartToolSessions(tool.id)
            broadcastAccountsChanged()
          }
        })
      }
    }

    loadAccountSubmenu.push({ label: tool.name, submenu: toolSubmenu })
  }

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
    },
    {
      label: 'CLI',
      submenu: [
        {
          label: 'Manage CLI Tools...',
          click: (): void => {
            const parent = getEditorWindow()
            if (parent) openCliToolsWindow(parent)
          }
        },
        { type: 'separator' },
        {
          label: 'Manage Accounts...',
          click: (): void => {
            const parent = getEditorWindow() ?? undefined
            createAccountManagerWindow(parent)
          }
        },
        { type: 'separator' },
        { label: 'Load Account', submenu: loadAccountSubmenu },
        { type: 'separator' },
        {
          label: 'Settings...',
          click: (): void => {
            const parent = getEditorWindow() ?? undefined
            createSettingsWindow(parent)
          }
        }
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
