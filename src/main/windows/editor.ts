import { BrowserWindow, shell, dialog } from 'electron'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { checkAndAcquireLock, releaseLock } from '../lock'
import { ensureAideDirectory } from '../config/projectConfig'
import { ensureDefaultToolbar } from '../config/toolbarConfig'
import { ensureGitignoreEntry } from '../gitignore'
import { addRecentProject } from '../config/appState'
import { getAppConfig } from '../config/appConfig'
import { startProjectWatcher, stopProjectWatcher } from '../filetree/watcher'
import { PtyManager } from '../pty/ptyManager'
import { ptyRegistry } from '../pty/registry'
import { getRunningCount, killAllProcesses, disposeProcessManager } from '../toolbar/processManager'
import { rebuildMenu, removeEditorWindow } from '../menu'

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

export function openProjectAndTrack(
  projectPath: string,
  openProjects: Map<string, BrowserWindow>
): { success: boolean; error?: string } {
  if (!existsSync(projectPath)) {
    return { success: false, error: `Path does not exist: ${projectPath}` }
  }

  if (openProjects.has(projectPath)) {
    openProjects.get(projectPath)!.focus()
    return { success: false, error: 'Project is already open in this AIDE instance.' }
  }

  ensureAideDirectory(projectPath)
  ensureDefaultToolbar(projectPath)

  const lockResult = checkAndAcquireLock(projectPath)
  if (!lockResult.acquired) {
    return {
      success: false,
      error: `This project is already open in another AIDE instance (PID ${lockResult.pid}).`
    }
  }

  ensureGitignoreEntry(projectPath, '.aide')
  addRecentProject(projectPath, getAppConfig().sessions.maxRecentProjects)
  // Rebuild menu so Open Recent submenu reflects the newly added project
  rebuildMenu()

  const editorWin = createEditorWindow(projectPath)
  openProjects.set(projectPath, editorWin)

  // Create PTY manager for this window
  const ptyMgr = new PtyManager(editorWin, projectPath)
  ptyRegistry.set(editorWin, ptyMgr)

  // Start filesystem watcher after the window is ready to receive IPC events
  editorWin.webContents.once('did-finish-load', () => {
    startProjectWatcher(projectPath, editorWin)
  })


  // Intercept close to check for running toolbar processes
  editorWin.on('close', (event) => {
    const count = getRunningCount(editorWin)
    if (count > 0) {
      event.preventDefault()
      dialog
        .showMessageBox(editorWin, {
          type: 'question',
          title: 'AIDE',
          message: `${count} process${count !== 1 ? 'es are' : ' is'} still running.`,
          detail: 'Close AIDE anyway?',
          buttons: ['Yes', 'No'],
          defaultId: 1,
          cancelId: 1
        })
        .then(({ response }) => {
          if (response === 0) {
            killAllProcesses(editorWin)
            editorWin.destroy()
          }
        })
    }
  })

  editorWin.on('closed', () => {
    disposeProcessManager(editorWin)
    ptyMgr.disposeAll()
    ptyRegistry.delete(editorWin)
    stopProjectWatcher(projectPath)
    releaseLock(projectPath)
    openProjects.delete(projectPath)
    removeEditorWindow(editorWin)
  })

  return { success: true }
}
