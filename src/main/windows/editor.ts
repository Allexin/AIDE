import { BrowserWindow, shell } from 'electron'
import { join, basename } from 'path'
import { existsSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { checkAndAcquireLock, releaseLock } from '../lock'
import { ensureAideDirectory } from '../config/projectConfig'
import { ensureGitignoreEntry } from '../gitignore'
import { addRecentProject } from '../config/appState'
import { getAppConfig } from '../config/appConfig'

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

  const lockResult = checkAndAcquireLock(projectPath)
  if (!lockResult.acquired) {
    return {
      success: false,
      error: `This project is already open in another AIDE instance (PID ${lockResult.pid}).`
    }
  }

  ensureGitignoreEntry(projectPath, '.aide')
  addRecentProject(projectPath, getAppConfig().sessions.maxRecentProjects)

  const editorWin = createEditorWindow(projectPath)
  openProjects.set(projectPath, editorWin)

  editorWin.on('closed', () => {
    releaseLock(projectPath)
    openProjects.delete(projectPath)
  })

  return { success: true }
}
