import { app, BrowserWindow } from 'electron'
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
import { startHookServer } from './hooks/hookServer'
import { getCommandLineArgumentsHelp, hasCommandLineHelpArg, resolveStartupArgs } from './startupArgs'

// Map of projectPath → editor BrowserWindow
const openProjects = new Map<string, BrowserWindow>()

function getUserArgs(): string[] {
  // Packaged apps receive user args after the executable; dev/defaultApp
  // launches also include the app path as argv[1].
  return process.argv.slice(app.isPackaged ? 1 : 2)
}

const userArgs = getUserArgs()
if (hasCommandLineHelpArg(userArgs)) {
  process.stdout.write(`${getCommandLineArgumentsHelp()}\n`)
  process.exit(0)
} else app.whenReady().then(async () => {
  initAppConfig()
  initAppState()
  initAccountStorage()

  // Start the hook server before any tab spawns so port/token are available when
  // a Claude Code session launches (deterministic tab -> transcript binding).
  await startHookServer().catch(() => {
    // If it fails to bind, tabs launch without hooks and fall back to file-watch
    // session assignment; nothing else breaks.
  })

  const remoteServer = new RemoteServer(ptyRegistry, openProjects)
  remoteServer.start()
  setRemoteServer(remoteServer)

  setupIpcHandlers(openProjects, remoteServer)
  initUpdater()
  setupMenu(openProjects, (path) => openProjectAndTrack(path, openProjects, () => remoteServer.refreshProjects()))

  const startupArgs = resolveStartupArgs(userArgs, process.cwd())

  if (startupArgs.projectPath) {
    const result = openProjectAndTrack(startupArgs.projectPath, openProjects, () => remoteServer.refreshProjects(), {
      terminal: startupArgs.terminal,
      noGlobalState: startupArgs.noGlobalState
    })
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
