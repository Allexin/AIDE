import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { removeRecentProject, getAppState } from '../config/appState'
import { getAppConfig } from '../config/appConfig'
import { readProjectSettings } from '../config/projectConfig'
import { openProjectAndTrack } from '../windows/editor'
import { runGitStatus } from '../filetree/gitStatus'
import { ptyRegistry, pickerEditorMap } from '../pty/registry'
import { scanSessions } from '../pty/sessionScanner'
import { createSessionPickerWindow } from '../windows/sessionPicker'

export function setupIpcHandlers(openProjects: Map<string, BrowserWindow>): void {
  // ── Picker: open native folder dialog ──────────────────────────────────────
  ipcMain.handle('pick:select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Picker: open a project path ─────────────────────────────────────────────
  ipcMain.handle('project:open', async (event, projectPath: string) => {
    const result = openProjectAndTrack(projectPath, openProjects)

    if (result.success) {
      // Close the picker that triggered this
      const senderWin = BrowserWindow.fromWebContents(event.sender)
      senderWin?.close()
    }

    return result
  })

  // ── Picker: validate path exists (no side effects) ──────────────────────────
  ipcMain.handle('path:validate', (_event, projectPath: string): boolean => {
    return existsSync(projectPath)
  })

  // ── Picker: remove a stale project from recent list ─────────────────────────
  ipcMain.handle('state:remove-recent', (_event, projectPath: string): void => {
    removeRecentProject(projectPath)
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

  // ── App state: get ──────────────────────────────────────────────────────────
  ipcMain.handle('state:get', () => getAppState())

  // ── Editor: get project panel settings (activePanelRatio, collapsedWidthPx) ─
  ipcMain.handle('editor:get-project-settings', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return { activePanelRatio: 0.75, collapsedWidthPx: 20 }

    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const s = readProjectSettings(projectPath)
        return { activePanelRatio: s.activePanelRatio, collapsedWidthPx: s.collapsedWidthPx }
      }
    }
    return { activePanelRatio: 0.75, collapsedWidthPx: 20 }
  })

  // ── File tree: read a single directory level ─────────────────────────────────
  // Returns sorted TreeNode[]: directories first, then files, alphabetical within each group.
  // Dot-prefixed entries are excluded. relativePath uses forward slashes for git comparison.
  ipcMain.handle('filetree:read-dir', (event, dirPath: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    let projectPath = ''
    for (const [p, win] of openProjects) {
      if (win === senderWin) {
        projectPath = p
        break
      }
    }

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      const filtered = entries.filter((e) => !e.name.startsWith('.'))

      const dirs = filtered
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
      const files = filtered
        .filter((e) => !e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))

      return [...dirs, ...files].map((entry) => {
        const fullPath = join(dirPath, entry.name)
        const relativePath = projectPath
          ? fullPath.slice(projectPath.length + 1).replace(/\\/g, '/')
          : entry.name
        return {
          name: entry.name,
          path: fullPath,
          relativePath,
          type: entry.isDirectory() ? 'directory' : 'file'
        }
      })
    } catch {
      return []
    }
  })

  // ── File tree: git status for the current window's project ──────────────────
  ipcMain.handle('filetree:git-status', async (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        return runGitStatus(projectPath)
      }
    }
    return { available: false, changed: [], deleted: [] }
  })

  // ── Terminal: create initial tab on project open ─────────────────────────────
  ipcMain.handle('terminal:create-initial', async (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return null
    const ptyMgr = ptyRegistry.get(senderWin)
    if (!ptyMgr) return null
    return ptyMgr.createInitialTab()
  })

  // ── Terminal: create new session tab ─────────────────────────────────────────
  ipcMain.handle('terminal:create-new', async (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return null
    const ptyMgr = ptyRegistry.get(senderWin)
    if (!ptyMgr) return null
    return ptyMgr.createNewSessionTab()
  })

  // ── Terminal: resume a session by ID ─────────────────────────────────────────
  ipcMain.handle('terminal:resume-session', async (event, sessionId: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return null
    const ptyMgr = ptyRegistry.get(senderWin)
    if (!ptyMgr) return null
    return ptyMgr.resumeSessionTab(sessionId)
  })

  // ── Terminal: write data to PTY (fire-and-forget) ─────────────────────────────
  ipcMain.on('terminal:write', (event, tabId: string, data: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return
    ptyRegistry.get(senderWin)?.write(tabId, data)
  })

  // ── Terminal: resize PTY (fire-and-forget) ────────────────────────────────────
  ipcMain.on('terminal:resize', (event, tabId: string, cols: number, rows: number) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return
    ptyRegistry.get(senderWin)?.resize(tabId, cols, rows)
  })

  // ── Terminal: get current tabs ────────────────────────────────────────────────
  ipcMain.handle('terminal:get-tabs', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return []
    return ptyRegistry.get(senderWin)?.getTabs() ?? []
  })

  // ── Terminal: open session picker window ──────────────────────────────────────
  ipcMain.on('terminal:open-session-picker', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return
    createSessionPickerWindow(senderWin)
  })

  // ── Session picker: get sessions (disk sessions + open tabs) ──────────────────
  ipcMain.handle('session-picker:get-sessions', async (event) => {
    const pickerWin = BrowserWindow.fromWebContents(event.sender)
    if (!pickerWin) return { diskSessions: [], openTabs: [] }

    const editorWin = pickerEditorMap.get(pickerWin)
    if (!editorWin) return { diskSessions: [], openTabs: [] }

    const ptyMgr = ptyRegistry.get(editorWin)
    const openTabs = ptyMgr?.getTabs() ?? []

    // Find project path for this editor window
    let projectPath: string | undefined
    for (const [p, w] of openProjects) {
      if (w === editorWin) {
        projectPath = p
        break
      }
    }

    const diskSessions = projectPath ? await scanSessions(projectPath) : []
    const maxSessions = getAppConfig().sessions.maxSessionsInPicker

    return { diskSessions: diskSessions.slice(0, maxSessions), openTabs }
  })

  // ── Session picker: switch to already-open tab ────────────────────────────────
  ipcMain.on('session-picker:switch-tab', (event, tabId: string) => {
    const pickerWin = BrowserWindow.fromWebContents(event.sender)
    if (!pickerWin) return
    const editorWin = pickerEditorMap.get(pickerWin)
    if (editorWin && !editorWin.isDestroyed()) {
      editorWin.webContents.send('terminal:switch-tab', { tabId })
    }
    pickerWin.close()
  })

  // ── Session picker: resume session (create new tab) ───────────────────────────
  ipcMain.handle('session-picker:resume-session', async (event, sessionId: string) => {
    const pickerWin = BrowserWindow.fromWebContents(event.sender)
    if (!pickerWin) return
    const editorWin = pickerEditorMap.get(pickerWin)
    if (!editorWin || editorWin.isDestroyed()) return

    const ptyMgr = ptyRegistry.get(editorWin)
    if (!ptyMgr) return

    const tabInfo = await ptyMgr.resumeSessionTab(sessionId)
    editorWin.webContents.send('terminal:new-tab', tabInfo)
    pickerWin.close()
  })

  // ── Session picker: new session ───────────────────────────────────────────────
  ipcMain.handle('session-picker:new-session', async (event) => {
    const pickerWin = BrowserWindow.fromWebContents(event.sender)
    if (!pickerWin) return
    const editorWin = pickerEditorMap.get(pickerWin)
    if (!editorWin || editorWin.isDestroyed()) return

    const ptyMgr = ptyRegistry.get(editorWin)
    if (!ptyMgr) return

    const tabInfo = await ptyMgr.createNewSessionTab()
    editorWin.webContents.send('terminal:new-tab', tabInfo)
    pickerWin.close()
  })
}
