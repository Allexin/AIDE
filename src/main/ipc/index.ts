import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { ensureAideDirectory } from '../config/projectConfig'
import { checkAndAcquireLock, releaseLock } from '../lock'
import { ensureGitignoreEntry } from '../gitignore'
import { addRecentProject, getAppConfig } from '../config/appConfig'
import { createEditorWindow } from '../windows/editor'

export function setupIpcHandlers(openProjects: Map<string, BrowserWindow>): void {
  // ── Picker: open native folder dialog ──────────────────────────────────────
  ipcMain.handle('pick:select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Picker: open a project path ─────────────────────────────────────────────
  ipcMain.handle('project:open', async (event, projectPath: string) => {
    if (!existsSync(projectPath)) {
      return { success: false, error: `Path does not exist: ${projectPath}` }
    }

    // Already open in this instance — just focus the window
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
    addRecentProject(projectPath)

    const editorWin = createEditorWindow(projectPath)
    openProjects.set(projectPath, editorWin)

    editorWin.on('closed', () => {
      releaseLock(projectPath)
      openProjects.delete(projectPath)
    })

    // Close the picker that triggered this
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    senderWin?.close()

    return { success: true }
  })

  // ── Editor: get project path for this window ────────────────────────────────
  ipcMain.handle('editor:get-project-path', event => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return null

    for (const [path, win] of openProjects) {
      if (win === senderWin) return path
    }
    return null
  })

  // ── App config: get ─────────────────────────────────────────────────────────
  ipcMain.handle('config:get', () => getAppConfig())
}
