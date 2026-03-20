import { BrowserWindow, shell, dialog } from 'electron'
import { join, basename } from 'path'
import { existsSync, appendFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { checkAndAcquireLock, releaseLock } from '../lock'
import { ensureAideDirectory } from '../config/projectConfig'
import { ensureDefaultToolbar, deployToolbarDocs } from '../config/toolbarConfig'
import { addRecentProject, saveOpenSessions } from '../config/appState'
import { getAppConfig } from '../config/appConfig'
import { startProjectWatcher, stopProjectWatcher } from '../filetree/watcher'
import { PtyManager } from '../pty/ptyManager'
import { ptyRegistry } from '../pty/registry'
import { ThinkingWatcher } from '../thinking/thinkingWatcher'
import { thinkingRegistry } from '../thinking/thinkingRegistry'
import { getRunningCount, killAllProcesses, disposeProcessManager } from '../toolbar/processManager'
import { startToolbarWatcher } from '../toolbar/toolbarWatcher'
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
    icon: join(__dirname, '../../app_icon.ico'),
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

  const windowTitle = `AIDE — ${folderName}(${projectPath})`
  win.webContents.on('did-finish-load', () => win.setTitle(windowTitle))

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
  deployToolbarDocs(projectPath)

  const lockResult = checkAndAcquireLock(projectPath)
  if (!lockResult.acquired) {
    return {
      success: false,
      error: `This project is already open in another AIDE instance (PID ${lockResult.pid}).`
    }
  }

  addRecentProject(projectPath, getAppConfig().sessions.maxRecentProjects)
  // Rebuild menu so Open Recent submenu reflects the newly added project
  rebuildMenu()

  const editorWin = createEditorWindow(projectPath)
  openProjects.set(projectPath, editorWin)

  // Create PTY manager for this window
  const ptyMgr = new PtyManager(editorWin, projectPath)
  ptyRegistry.set(editorWin, ptyMgr)

  // Create thinking watcher and wire it to PTY manager session lifecycle
  const thinkingWatcher = new ThinkingWatcher(editorWin, projectPath)
  thinkingRegistry.set(editorWin, thinkingWatcher)
  ptyMgr.onSessionAssigned = (tabId, sessionId) => thinkingWatcher.startWatching(tabId, sessionId)
  ptyMgr.onTabClosed = (tabId) => thinkingWatcher.stopWatching(tabId)

  // Start filesystem watcher after the window is ready to receive IPC events
  editorWin.webContents.once('did-finish-load', () => {
    startProjectWatcher(projectPath, editorWin)
  })

  // Watch toolbar config files for hot reload
  const stopToolbarWatcher = startToolbarWatcher(projectPath, (buttons) => {
    if (!editorWin.isDestroyed()) {
      editorWin.webContents.send('toolbar:config-updated', buttons)
    }
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
    // Save active sessions before disposing (must be before disposeAll clears tabs)
    const sessions = ptyMgr.getActiveSessions()
    const toSave = sessions
      .filter((s) => s.sessionId)
      .map((s) => ({ sessionId: s.sessionId!, title: s.title }))

    // DEBUG: log what we're saving
    const dbg = join(projectPath, '.aide', 'session-debug.log')
    try {
      appendFileSync(dbg, `\n=== SAVE ${new Date().toISOString()} ===\nall tabs: ${JSON.stringify(sessions, null, 2)}\ntoSave: ${JSON.stringify(toSave, null, 2)}\n`)
    } catch {}

    if (toSave.length > 0) {
      saveOpenSessions(projectPath, {
        tabs: toSave,
        activeSessionId: toSave[0]?.sessionId ?? null
      })
    }

    stopToolbarWatcher()
    disposeProcessManager(editorWin)
    ptyMgr.disposeAll()
    ptyRegistry.delete(editorWin)
    thinkingWatcher.disposeAll()
    thinkingRegistry.delete(editorWin)
    stopProjectWatcher(projectPath)
    releaseLock(projectPath)
    openProjects.delete(projectPath)
    removeEditorWindow(editorWin)
  })

  return { success: true }
}
