import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { initAppConfig } from './config/appConfig'
import { initAppState } from './config/appState'
import { initAccountStorage } from './config/accountStorage'
import { initUpdater } from './updater/updater'
import { releaseLock } from './lock'
import { createPickerWindow } from './windows/picker'
import { openProjectAndTrack } from './windows/editor'
import { setupIpcHandlers } from './ipc'
import { setupMenu, isSwitchingProject, setRemoteServer } from './menu'
import { RemoteServer } from './remote'
import { ptyRegistry } from './pty/registry'

// Map of projectPath → editor BrowserWindow
const openProjects = new Map<string, BrowserWindow>()

function resolveStartupProject(): string | null {
  // Skip argv[0] (electron binary) and argv[1] (app path).
  // Ignore entries starting with '--' (electron/vite flags).
  // The first remaining entry is the user-supplied project path.
  const userArgs = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const cliArg = userArgs[0]

  if (cliArg) {
    const resolved = join(process.cwd(), cliArg) // resolves relative paths including '.'
    const candidate = existsSync(resolved) ? resolved : cliArg // try absolute if resolve fails
    if (existsSync(candidate)) return candidate
  }

  // Priority 2: cwd has .aide/ — recognized as a previously-opened AIDE project
  const aideDirInCwd = join(process.cwd(), '.aide')
  if (existsSync(aideDirInCwd)) return process.cwd()

  return null
}

app.whenReady().then(() => {
  initAppConfig()
  initAppState()
  initAccountStorage()

  const remoteServer = new RemoteServer(ptyRegistry, openProjects)
  remoteServer.start()
  setRemoteServer(remoteServer)

  setupIpcHandlers(openProjects, remoteServer)
  initUpdater()
  setupMenu(openProjects, (path) => openProjectAndTrack(path, openProjects))

  const startupPath = resolveStartupProject()

  if (startupPath) {
    const result = openProjectAndTrack(startupPath, openProjects)
    if (!result.success) {
      // Path exists but couldn't be opened (locked, etc.) — fall back to Picker
      createPickerWindow()
    }
  } else {
    createPickerWindow()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPickerWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isSwitchingProject()) {
    app.quit()
  }
})

app.on('before-quit', () => {
  for (const [projectPath] of openProjects) {
    releaseLock(projectPath)
  }
})
