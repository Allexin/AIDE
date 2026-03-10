import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, promises as fsAsync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { removeRecentProject, getAppState, saveOpenSessions, loadOpenSessions } from '../config/appState'
import { getAppConfig, updateAppConfig } from '../config/appConfig'
import type { ProxyConfig } from '../config/appConfig'
import { readProjectSettings, writeProjectSettings } from '../config/projectConfig'
import {
  readToolbarButtons,
  readLocalToolbarConfig,
  writeLocalToolbarConfig,
  detectProjectType,
  PRESET_GROUPS,
  type ToolbarButton,
  type ToolbarItem
} from '../config/toolbarConfig'
import { openProjectAndTrack } from '../windows/editor'
import { runGitStatus } from '../filetree/gitStatus'
import { ptyRegistry, pickerEditorMap } from '../pty/registry'
import { getRegisteredTools, getToolById } from '../pty/cliTools/registry'
import {
  listAccounts,
  listAccountInfos,
  saveAccount,
  deleteAccount as deleteStoredAccount,
  updateAccount as updateStoredAccount
} from '../config/accountStorage'
import { scanSessions, readSessionPreview, getSessionsDir } from '../pty/sessionScanner'
import { initCliLogger } from '../pty/cliTools/cliLogger'
import { createSessionPickerWindow } from '../windows/sessionPicker'
import {
  spawnButtonProcess,
  killButtonProcess
} from '../toolbar/processManager'
import { setEditorFileOpen, rebuildMenu } from '../menu'

// Helper: spawn one git subcommand, stream stdout/stderr lines, return success/error.
function runGitSubcommand(
  projectPath: string,
  args: string[],
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd: projectPath })
    const stderrChunks: Buffer[] = []

    proc.stdout.on('data', (d: Buffer) => {
      d.toString()
        .split('\n')
        .filter((l: string) => l.length > 0)
        .forEach((l: string) => onLine(l, 'stdout'))
    })

    proc.stderr.on('data', (d: Buffer) => {
      stderrChunks.push(d)
      d.toString()
        .split('\n')
        .filter((l: string) => l.length > 0)
        .forEach((l: string) => onLine(l, 'stderr'))
    })

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        const errMsg = Buffer.concat(stderrChunks).toString().trim()
        resolve({ success: false, error: errMsg || `git exited with code ${code}` })
      }
    })

    proc.on('error', (err: Error) => resolve({ success: false, error: err.message }))
  })
}

export function setupIpcHandlers(openProjects: Map<string, BrowserWindow>): void {
  // Wire up CLI logger so any cliLog() call broadcasts to all renderer windows
  initCliLogger(() => openProjects.values())

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
        return { activePanelRatio: s.activePanelRatio, collapsedWidthPx: s.collapsedWidthPx, fileTreeWidth: s.fileTreeWidth }
      }
    }
    return { activePanelRatio: 0.75, collapsedWidthPx: 20, fileTreeWidth: 250 }
  })

  // ── Editor: save file tree width to project settings ──────────────────────────
  ipcMain.handle('editor:save-file-tree-width', (event, width: number) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return

    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const s = readProjectSettings(projectPath)
        s.fileTreeWidth = width
        writeProjectSettings(projectPath, s)
        return
      }
    }
  })

  // ── Editor: save log panel height to app config ────────────────────────────────
  ipcMain.handle('editor:save-log-panel-height', (_event, height: number) => {
    const cfg = getAppConfig()
    updateAppConfig({ ui: { ...cfg.ui, logPanelExpandedHeightPx: height } })
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

  // ── Terminal: create initial tabs on project open (restore saved sessions) ──
  ipcMain.handle('terminal:create-initial', async (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return null
    const ptyMgr = ptyRegistry.get(senderWin)
    if (!ptyMgr) return null
    let projectPath = ''
    for (const [p, win] of openProjects) {
      if (win === senderWin) { projectPath = p; break }
    }
    const saved = projectPath ? loadOpenSessions(projectPath) : null
    return ptyMgr.createInitialTabs(saved?.tabs ?? undefined)
  })

  // ── State: save open sessions for a project ────────────────────────────────
  ipcMain.on('state:save-open-sessions', (_event, data: { projectPath: string; tabs: Array<{ sessionId: string; title: string }>; activeSessionId: string | null }) => {
    saveOpenSessions(data.projectPath, { tabs: data.tabs, activeSessionId: data.activeSessionId })
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

  // ── Terminal: close a single tab (kill PTY) ──────────────────────────────────
  ipcMain.on('terminal:close-tab', (event, tabId: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return
    ptyRegistry.get(senderWin)?.closeTab(tabId)
  })

  // ── Terminal: get current tabs ────────────────────────────────────────────────
  ipcMain.handle('terminal:get-tabs', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return []
    return ptyRegistry.get(senderWin)?.getTabs() ?? []
  })

  // ── Terminal: create new session with prompt ──────────────────────────────────
  ipcMain.handle('terminal:create-with-prompt', async (event, _toolId: string, prompt: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return null
    const ptyMgr = ptyRegistry.get(senderWin)
    if (!ptyMgr) return null
    const tabInfo = await ptyMgr.createNewSessionWithPrompt(prompt)
    senderWin.webContents.send('terminal:new-tab', tabInfo)
    return tabInfo
  })

  // ── CLI tools: list registered tools ──────────────────────────────────────────
  ipcMain.handle('cli-tools:list', () => getRegisteredTools())

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

  // ── Session picker: get session preview messages ──────────────────────────────
  ipcMain.handle('session-picker:get-preview', async (event, sessionId: string) => {
    const pickerWin = BrowserWindow.fromWebContents(event.sender)
    if (!pickerWin) return []

    const editorWin = pickerEditorMap.get(pickerWin)
    if (!editorWin) return []

    let projectPath: string | undefined
    for (const [p, w] of openProjects) {
      if (w === editorWin) {
        projectPath = p
        break
      }
    }
    if (!projectPath) return []

    return readSessionPreview(getSessionsDir(projectPath), sessionId)
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

  // ── Editor: read file sync (content + mtime + size) ────────────────────────────
  ipcMain.on('editor:read-file-sync', (event, filePath: string) => {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const stat = statSync(filePath)
      event.returnValue = { content, mtime: stat.mtimeMs, size: stat.size }
    } catch (err) {
      event.returnValue = { error: (err as Error).message }
    }
  })

  // ── Editor: write file sync (returns new mtime) ────────────────────────────────
  ipcMain.on('editor:write-file-sync', (event, filePath: string, content: string) => {
    try {
      writeFileSync(filePath, content, 'utf-8')
      const stat = statSync(filePath)
      event.returnValue = { mtime: stat.mtimeMs }
    } catch (err) {
      event.returnValue = { error: (err as Error).message }
    }
  })

  // ── Editor: git show HEAD:<relPath> ───────────────────────────────────────────
  // Returns { content } on success, or { error: 'untracked' | 'other' } on failure.
  ipcMain.handle('editor:git-show-head', async (event, relPath: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    let projectPath = ''
    for (const [p, win] of openProjects) {
      if (win === senderWin) {
        projectPath = p
        break
      }
    }
    if (!projectPath) return { error: 'other' as const }

    return new Promise<{ content: string } | { error: 'untracked' | 'other' }>((resolve) => {
      const proc = spawn('git', ['show', `HEAD:${relPath}`], { cwd: projectPath })
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      proc.stdout.on('data', (d: Buffer) => chunks.push(d))
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d))
      proc.on('close', (code) => {
        if (code !== 0) {
          const errMsg = Buffer.concat(errChunks).toString()
          if (
            errMsg.includes('exists on disk') ||
            errMsg.includes('did not match any') ||
            errMsg.includes('does not exist')
          ) {
            resolve({ error: 'untracked' })
          } else {
            resolve({ error: 'other' })
          }
        } else {
          resolve({ content: Buffer.concat(chunks).toString('utf-8') })
        }
      })
      proc.on('error', () => resolve({ error: 'other' }))
    })
  })

  // ── Toolbar: get info (buttons + projectType + suggestedType) ────────────────
  ipcMain.handle('toolbar:get-info', (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return { buttons: [], projectType: '', suggestedType: null }
    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const localConfig = readLocalToolbarConfig(projectPath)
        const projectType = localConfig.projectType ?? ''
        const buttons = readToolbarButtons(projectPath)
        const suggestedType = projectType === '' ? detectProjectType(projectPath) : null
        return { buttons, projectType, suggestedType }
      }
    }
    return { buttons: [], projectType: '', suggestedType: null }
  })

  // ── Toolbar: get all preset groups ───────────────────────────────────────────
  ipcMain.handle('toolbar:get-presets', () => PRESET_GROUPS)

  // ── Toolbar: save local buttons (replaces .aide/toolbar.json buttons array) ──
  ipcMain.handle('toolbar:save-buttons', (event, buttons: ToolbarItem[]) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return []
    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const localConfig = readLocalToolbarConfig(projectPath)
        localConfig.buttons = buttons
        writeLocalToolbarConfig(projectPath, localConfig)
        return readToolbarButtons(projectPath)
      }
    }
    return []
  })

  // ── Toolbar: set project type (persists to .aide/toolbar.json) ───────────────
  ipcMain.handle('toolbar:set-project-type', (event, type: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return
    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const localConfig = readLocalToolbarConfig(projectPath)
        localConfig.projectType = type
        writeLocalToolbarConfig(projectPath, localConfig)
        return
      }
    }
  })

  // ── Toolbar: run a button process ─────────────────────────────────────────────
  ipcMain.handle('toolbar:run-button', (event, buttonId: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return { success: false, error: 'No window' }
    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const items = readToolbarButtons(projectPath)
        const button = items.find((b): b is ToolbarButton => !('type' in b) && b.id === buttonId)
        if (!button) return { success: false, error: 'Button not found' }
        spawnButtonProcess(senderWin, button, projectPath)
        return { success: true }
      }
    }
    return { success: false, error: 'Project not found' }
  })

  // ── Toolbar: kill a running button process ────────────────────────────────────
  ipcMain.handle('toolbar:kill-button', (event, buttonId: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (senderWin) killButtonProcess(senderWin, buttonId)
  })

  // ── Toolbar: kill and restart a button process ────────────────────────────────
  ipcMain.handle('toolbar:kill-restart-button', async (event, buttonId: string) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin) return

    killButtonProcess(senderWin, buttonId)

    // Brief delay so the OS has time to release resources (port, file handles)
    // before the new process spawns. 200ms is enough for most cases.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))

    for (const [projectPath, win] of openProjects) {
      if (win === senderWin) {
        const items = readToolbarButtons(projectPath)
        const button = items.find((b): b is ToolbarButton => !('type' in b) && b.id === buttonId)
        if (button) spawnButtonProcess(senderWin, button, projectPath)
        break
      }
    }
  })

  // ── Git: get individual files for commit dialog ──────────────────────────────
  // Uses --untracked-files=all to expand untracked directories into individual files.
  // Capped at 2000 entries to avoid freezing on non-gitignored node_modules etc.
  ipcMain.handle('git:get-commit-files', async (event) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (!senderWin)
      return { available: false, changed: [], deleted: [], untracked: [], truncated: false }

    let projectPath = ''
    for (const [p, win] of openProjects) {
      if (win === senderWin) {
        projectPath = p
        break
      }
    }
    if (!projectPath)
      return { available: false, changed: [], deleted: [], untracked: [], truncated: false }

    return new Promise<{
      available: boolean
      changed: string[]
      deleted: string[]
      untracked: string[]
      truncated: boolean
    }>((resolve) => {
      const proc = spawn('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: projectPath,
        windowsHide: true
      })
      const chunks: Buffer[] = []
      proc.stdout.on('data', (d: Buffer) => chunks.push(d))
      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          resolve({ available: false, changed: [], deleted: [], untracked: [], truncated: false })
          return
        }
        const output = Buffer.concat(chunks).toString()
        const changed: string[] = []
        const deleted: string[] = []
        const untracked: string[] = []
        const MAX = 2000
        const lines = output.split('\n').filter((l) => l.length >= 4)
        for (const line of lines) {
          if (changed.length + deleted.length + untracked.length >= MAX) break
          const xy = line.substring(0, 2)
          let filePath = line.substring(3)
          if (filePath.includes(' -> ')) filePath = filePath.split(' -> ')[1]
          filePath = filePath.trim()
          if (!filePath || filePath.endsWith('/')) continue
          if (xy === '??') untracked.push(filePath)
          else if (xy[0] === 'D' || xy[1] === 'D') deleted.push(filePath)
          else changed.push(filePath)
        }
        resolve({ available: true, changed, deleted, untracked, truncated: lines.length > MAX })
      })
      proc.on('error', () =>
        resolve({ available: false, changed: [], deleted: [], untracked: [], truncated: false })
      )
    })
  })

  // ── Git: run commit (git add batched + git commit, streams output) ────────────
  ipcMain.handle(
    'git:run-commit',
    async (event, { files, message, stageAll }: { files: string[]; message: string; stageAll?: boolean }) => {
      const senderWin = BrowserWindow.fromWebContents(event.sender)
      if (!senderWin) return { success: false, error: 'No window' }

      let projectPath = ''
      for (const [p, win] of openProjects) {
        if (win === senderWin) {
          projectPath = p
          break
        }
      }
      if (!projectPath) return { success: false, error: 'Project not found' }

      const sendLine = (line: string, stream: 'stdout' | 'stderr'): void => {
        if (!senderWin.isDestroyed()) {
          senderWin.webContents.send('git:commit-output', { line, stream })
        }
      }

      // Step 1: git add — either "add -A" (stage everything) or batched individual files
      if (stageAll) {
        sendLine('> git add -A', 'stdout')
        const addResult = await runGitSubcommand(projectPath, ['add', '-A'], sendLine)
        if (!addResult.success) return { success: false, error: addResult.error }
      } else {
        const batchSize = Math.max(1, getAppConfig().git.addBatchSize)
        const totalBatches = Math.ceil(files.length / batchSize)
        for (let i = 0; i < files.length; i += batchSize) {
          const batch = files.slice(i, i + batchSize)
          const batchNum = Math.floor(i / batchSize) + 1
          const label =
            totalBatches > 1
              ? `> git add [batch ${batchNum}/${totalBatches}: ${batch.length} files]`
              : `> git add [${batch.length} file${batch.length !== 1 ? 's' : ''}]`
          sendLine(label, 'stdout')
          const addResult = await runGitSubcommand(projectPath, ['add', '--', ...batch], sendLine)
          if (!addResult.success) return { success: false, error: addResult.error }
        }
      }

      // Step 2: git commit
      const msgPreview = message.includes('\n')
        ? message.split('\n')[0].trimEnd() + ' …'
        : message
      sendLine(`> git commit -m "${msgPreview}"`, 'stdout')
      const commitResult = await runGitSubcommand(
        projectPath,
        ['commit', '-m', message],
        sendLine
      )
      return { success: commitResult.success, error: commitResult.error }
    }
  )

  // ── Shell: reveal file in Explorer ────────────────────────────────────────────
  ipcMain.handle('shell:show-item-in-folder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // ── FS: delete file permanently ───────────────────────────────────────────────
  ipcMain.handle('fs:delete-file', async (_event, filePath: string) => {
    await fsAsync.unlink(filePath)
  })

  // ── FS: move file to trash ────────────────────────────────────────────────────
  ipcMain.handle('fs:trash-file', async (_event, filePath: string) => {
    await shell.trashItem(filePath)
  })

  // ── FS: rename file ───────────────────────────────────────────────────────────
  ipcMain.handle('fs:rename-file', async (_event, oldPath: string, newPath: string) => {
    await fsAsync.rename(oldPath, newPath)
  })

  // ── FS: copy file ─────────────────────────────────────────────────────────────
  ipcMain.handle('fs:copy-file', async (_event, src: string, dest: string) => {
    await fsAsync.copyFile(src, dest)
  })

  // ── Menu: editor file open state ──────────────────────────────────────────────
  // Renderer notifies when a file is opened/closed so Edit menu can be enabled/disabled
  ipcMain.on('menu:editor-file-changed', (event, hasFile: boolean) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender)
    if (senderWin) setEditorFileOpen(senderWin, hasFile)
  })

  // ── Accounts: get current account display info ──────────────────────────────
  ipcMain.handle('accounts:get-current-info', async (_event, toolId: string) => {
    const tool = getToolById(toolId)
    if (!tool?.getLoginIdentifier) return null
    const identifier = await tool.getLoginIdentifier()
    if (!identifier) return null

    // Check if current credentials match any saved account
    if (tool.credentialsMatch) {
      const saved = listAccounts(toolId)
      for (const acc of saved) {
        if (await tool.credentialsMatch(acc.credentials)) {
          return { label: `${acc.name} (${identifier})`, saved: true }
        }
      }
    }

    return { label: `account not saved (${identifier})`, saved: false }
  })

  // ── Usage info: get usage/limits for a CLI tool ────────────────────────────
  ipcMain.handle('usage:get-info', async (_event, toolId: string) => {
    const tool = getToolById(toolId)
    if (!tool?.getUsageInfo) return null
    return tool.getUsageInfo()
  })

  // ── Accounts: get tools list ─────────────────────────────────────────────────
  ipcMain.handle('accounts:get-tools', () => getRegisteredTools())

  // ── Accounts: check if logged in ───────────────────────────────────────────
  ipcMain.handle('accounts:is-logged-in', async (_event, toolId: string) => {
    const tool = getToolById(toolId)
    if (!tool?.isLoggedIn) return false
    return tool.isLoggedIn()
  })

  // ── Accounts: get current login identifier ──────────────────────────────────
  ipcMain.handle('accounts:get-login-identifier', async (_event, toolId: string) => {
    const tool = getToolById(toolId)
    if (!tool?.getLoginIdentifier) return null
    return tool.getLoginIdentifier()
  })

  /** Re-export current credentials into the matching saved account so tokens stay fresh. */
  async function autoSaveCurrentCredentials(toolId: string): Promise<void> {
    const tool = getToolById(toolId)
    if (!tool?.exportCredentials || !tool?.getLoginIdentifier || !tool?.credentialsMatch) return
    const [creds, identifier] = await Promise.all([
      tool.exportCredentials(),
      tool.getLoginIdentifier()
    ])
    if (!creds || !identifier) return
    const saved = listAccounts(toolId)
    for (const acc of saved) {
      if (await tool.credentialsMatch(acc.credentials)) {
        updateStoredAccount(toolId, acc.id, identifier, creds)
        break
      }
    }
  }

  /** Notify all editor windows that accounts changed so sensors refresh. */
  function broadcastAccountsChanged(): void {
    for (const win of openProjects.values()) {
      if (!win.isDestroyed()) win.webContents.send('accounts:changed')
    }
  }

  // ── Accounts: list saved accounts (no credentials exposed) ──────────────────
  ipcMain.handle('accounts:list', (_event, toolId: string) => {
    return listAccountInfos(toolId)
  })

  // ── Accounts: save current credentials ─────────────────────────────────────
  ipcMain.handle('accounts:save-current', async (_event, toolId: string, name: string) => {
    const tool = getToolById(toolId)
    if (!tool?.exportCredentials || !tool?.getLoginIdentifier) return null
    const [creds, identifier] = await Promise.all([
      tool.exportCredentials(),
      tool.getLoginIdentifier()
    ])
    if (!creds || !identifier) return null
    const result = saveAccount(toolId, name, identifier, creds)
    rebuildMenu()
    broadcastAccountsChanged()
    return result
  })

  // ── Accounts: delete saved account ─────────────────────────────────────────
  ipcMain.handle('accounts:delete', (_event, toolId: string, accountId: string) => {
    deleteStoredAccount(toolId, accountId)
    rebuildMenu()
    broadcastAccountsChanged()
  })

  // ── Accounts: update saved account with current credentials ────────────────
  ipcMain.handle('accounts:update', async (_event, toolId: string, accountId: string) => {
    const tool = getToolById(toolId)
    if (!tool?.exportCredentials || !tool?.getLoginIdentifier) return null
    const [creds, identifier] = await Promise.all([
      tool.exportCredentials(),
      tool.getLoginIdentifier()
    ])
    if (!creds || !identifier) return null
    const result = updateStoredAccount(toolId, accountId, identifier, creds)
    broadcastAccountsChanged()
    return result
  })

  // ── Accounts: load saved credentials into CLI tool ─────────────────────────
  ipcMain.handle('accounts:load', async (_event, toolId: string, accountId: string) => {
    const tool = getToolById(toolId)
    if (!tool?.importCredentials) return false
    const stored = listAccounts(toolId).find((a) => a.id === accountId)
    if (!stored) return false
    // Auto-save current account's latest tokens before switching away
    await autoSaveCurrentCredentials(toolId)
    await tool.importCredentials(stored.credentials)
    broadcastAccountsChanged()
    return true
  })

  // ── Settings: get proxy config ──────────────────────────────────────────────
  ipcMain.handle('settings:get-proxy', () => getAppConfig().proxy)

  // ── Settings: save proxy config ────────────────────────────────────────────
  ipcMain.handle('settings:save-proxy', (_event, proxy: ProxyConfig) => {
    updateAppConfig({ proxy })
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
