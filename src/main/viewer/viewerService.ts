import { BrowserWindow, ipcMain } from 'electron'
import { logEvent } from '../diagnostics'
import { addFsChangeObserver } from '../filetree/watcher'
import type { PtyManager } from '../pty/ptyManager'
import { createFileViewerWindow } from '../windows/fileViewer'
import { describeRange, sliceRange, type ViewRange } from '../../shared/viewer/range'
import { countChanges, prepareShow } from './showPrep'
import type { ViewerKind, ViewerLivePayload, ViewerPageChanged, ViewerReplyTab, ViewerSendResult, ViewerShowPayload } from '../../shared/viewer/types'
import { gitShowHead, readForView, resolveProjectFile, viewerKind } from './viewerFiles'
import type { Mark } from '../../shared/viewer/marks'
import { getProjectUserPath } from '../config/projectUserData'
import { getAppConfig } from '../config/appConfig'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, relative, sep } from 'path'
import { addPreviewServedObserver, previewUrl, registerPreviewRoot, revokePreviewRoot, type PreviewTokens } from './previewProtocol'

/**
 * The file viewer (docs/file-viewer-spec.md): snapshots per shown file, the window of each
 * open project, live updates of the displayed file, and Send to the agent's tab.
 */

export type BaseMode = 'shown' | 'head' | 'none'

export interface ShowArgs {
  path: string
  base?: BaseMode
  range?: ViewRange | null
  anchor?: string | number | null
  /** true or the agent's marks: the user may mark up the image (images only). */
  marks?: true | Mark[]
}

interface Displayed {
  relPath: string
  absolute: string
  kind: ViewerKind
  range: ViewRange | null
}

interface ProjectViewer {
  projectPath: string
  editorWin: BrowserWindow
  pty: PtyManager
  win: BrowserWindow | null
  /** Whole content (or data URL) of each path at its latest show: the next show's base. */
  shown: Map<string, { content: string; shownAt: number }>
  displayed: Displayed | null
  lastShow: ViewerShowPayload | null
  replyTabId: string | null
  pending: number
  tokens: PreviewTokens
  /** Files the displayed document loaded through aide-preview:// (folded paths): a change to one reloads them. */
  loadedFiles: Set<string>
  pageTimer: ReturnType<typeof setTimeout> | null
}

/** Coalesces a burst of writes (a build, an agent writing several files) into one page reload. */
const PAGE_RELOAD_DEBOUNCE_MS = 200

const fold = (p: string): string => (process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p)

class ViewerService {
  private readonly projects = new Map<string, ProjectViewer>()
  private seq = 0
  private installed = false
  /** Whether a remote client has taken a tab (src/main/remote); none until the remote server is up. */
  private remoteLocked: (tabId: string) => boolean = () => false

  /** A tab taken by a remote client gets no viewer: the user there cannot see the window. Temporary, until the remote page shows files. */
  setRemoteLockCheck(check: (tabId: string) => boolean): void {
    this.remoteLocked = check
  }

  /** IPC handlers and the FS observer; once, at startup. */
  install(): void {
    if (this.installed) return
    this.installed = true
    addFsChangeObserver((projectPath, fullPath) => this.onFsChange(projectPath, fullPath))
    addPreviewServedObserver((projectPath, absolute) => {
      const p = this.projects.get(fold(projectPath))
      if (p?.displayed) p.loadedFiles.add(fold(absolute))
    })

    const byWindow = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): ProjectViewer | undefined => {
      const win = BrowserWindow.fromWebContents(event.sender)
      for (const p of this.projects.values()) if (p.win && p.win === win) return p
      return undefined
    }
    ipcMain.handle('viewer:get-state', (event) => {
      const p = byWindow(event)
      return p?.lastShow ? { ...p.lastShow, reply: this.replyState(p) } : null
    })
    ipcMain.handle('viewer:send', async (event, text: unknown): Promise<ViewerSendResult> => {
      const p = byWindow(event)
      if (!p) return { ok: false, error: 'The project is closed.' }
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Nothing to send.' }
      const tabId = p.replyTabId
      if (!tabId || !p.pty.getTabs().some((t) => t.tabId === tabId)) return { ok: false, error: 'Agent tab closed' }
      const sent = await p.pty.submitText(tabId, text)
      return sent ? { ok: true } : { ok: false, error: 'Agent tab closed' }
    })
    // The image with the marks drawn on it, for an agent with vision (raster images).
    ipcMain.handle('viewer:save-marks-image', (event, dataUrl: unknown): string | null => {
      const p = byWindow(event)
      if (!p || typeof dataUrl !== 'string') return null
      const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
      if (!m) return null
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const file = getProjectUserPath(p.projectPath, 'viewer', `marks-${stamp}.png`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, Buffer.from(m[1], 'base64'))
        return relative(p.projectPath, file).split(sep).join('/')
      } catch (err) {
        logEvent('viewer-marks-image-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
        return null
      }
    })
    ipcMain.on('viewer:pending', (event, count: unknown) => {
      const p = byWindow(event)
      if (p) p.pending = typeof count === 'number' && count > 0 ? count : 0
    })
    ipcMain.on('viewer:open-in-editor', (event, relPath: unknown) => {
      const p = byWindow(event)
      if (!p || typeof relPath !== 'string' || p.editorWin.isDestroyed()) return
      try {
        const { absolute, relPath: rel } = resolveProjectFile(p.projectPath, relPath)
        p.editorWin.webContents.send('viewer:open-file', { absolute, relPath: rel })
        p.editorWin.focus()
      } catch { /* the file is gone */ }
    })
  }

  attachProject(projectPath: string, editorWin: BrowserWindow, pty: PtyManager): void {
    this.projects.set(fold(projectPath), {
      projectPath, editorWin, pty, win: null, shown: new Map(), displayed: null, lastShow: null, replyTabId: null, pending: 0,
      tokens: registerPreviewRoot(projectPath), loadedFiles: new Set(), pageTimer: null
    })
  }

  detachProject(projectPath: string): void {
    const p = this.projects.get(fold(projectPath))
    if (p?.win && !p.win.isDestroyed()) p.win.destroy()
    if (p) {
      revokePreviewRoot(p.tokens)
      if (p.pageTimer) clearTimeout(p.pageTimer)
    }
    this.projects.delete(fold(projectPath))
  }

  /** Unsent comments in the project's viewer: closing the project asks first. */
  pendingComments(projectPath: string): number {
    return this.projects.get(fold(projectPath))?.pending ?? 0
  }

  tabClosed(projectPath: string, tabId: string): void {
    const p = this.projects.get(fold(projectPath))
    if (!p || p.replyTabId !== tabId) return
    p.replyTabId = null
    this.send(p, 'viewer:reply', { available: false } satisfies ViewerReplyTab)
  }

  async show(projectPath: string, tabId: string | null, args: ShowArgs): Promise<string> {
    const p = this.projects.get(fold(projectPath))
    if (!p) throw new Error('The project is not open in this AIDE.')
    if (tabId && this.remoteLocked(tabId)) {
      throw new Error('view_show is not available in a remote session: the user works with this tab from the remote page and cannot see the viewer window. Show nothing; describe the file or its changes in your answer instead.')
    }
    const { absolute, relPath } = resolveProjectFile(p.projectPath, args.path)
    const kind = viewerKind(relPath)
    if (args.marks !== undefined && kind !== 'image') throw new Error('"marks" works on images only.')
    const current = readForView(absolute, kind)
    const mode: BaseMode = args.base ?? 'shown'
    let baseFull: string | null = null
    if (mode === 'shown') baseFull = p.shown.get(relPath)?.content ?? null
    else if (mode === 'head') {
      baseFull = await gitShowHead(p.projectPath, relPath, kind)
      if (baseFull === null) throw new Error('git show HEAD failed for this file.')
    }
    // A page is shown whole: a range would cut its source, not the page.
    if (args.range && kind === 'html') throw new Error('"range" does not work on HTML pages.')
    const range = kind === 'image' ? null : (args.range ?? null)
    const prepared = prepareShow(kind, current, baseFull, range)
    const shownAt = Date.now()
    p.shown.set(relPath, { content: current, shownAt })
    if (tabId && p.pty.getTabs().some((t) => t.tabId === tabId)) p.replyTabId = tabId
    else p.replyTabId = null
    p.displayed = { relPath, absolute, kind, range }
    p.loadedFiles = new Set([fold(absolute)])

    const payload: ViewerShowPayload = {
      seq: ++this.seq,
      relPath,
      kind,
      ...prepared,
      range,
      rangeLabel: describeRange(range),
      shownAt,
      anchor: args.anchor ?? null,
      reply: this.replyState(p),
      marks: args.marks === undefined ? null : args.marks === true ? [] : args.marks,
      page: kind === 'html' ? { offline: previewUrl(p.tokens.offline, relPath), network: previewUrl(p.tokens.network, relPath) } : null,
      pageNetwork: getAppConfig().privacy.viewerPagesNetwork,
      assetBase: previewUrl(p.tokens.offline, relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '')
    }
    delete (payload as { note?: string }).note
    p.lastShow = payload
    this.present(p, payload)

    const changes = countChanges(kind, prepared)
    const what = prepared.base === null
      ? (prepared.note ?? (mode === 'none' ? 'Shown without marks.' : 'First show, no base.'))
      : `${changes} change${changes === 1 ? '' : 's'} since ${mode === 'head' ? 'HEAD' : 'the previous show'}.`
    const where = payload.rangeLabel ? ` (${payload.rangeLabel})` : ''
    const marked = payload.marks ? ` Marks mode is on${payload.marks.length ? ` with your ${payload.marks.length} mark${payload.marks.length === 1 ? '' : 's'}` : ''}.` : ''
    const reply = p.replyTabId ? `${marked} The user's comments will arrive as a message.` : `${marked} This session is not an AIDE terminal tab: the user cannot send comments back.`
    return `Shown ${relPath}${where}: ${what}${reply}`
  }

  private replyState(p: ProjectViewer): ViewerReplyTab {
    const tab = p.replyTabId ? p.pty.getTabs().find((t) => t.tabId === p.replyTabId) : undefined
    return tab ? { available: true, title: tab.title } : { available: false }
  }

  private present(p: ProjectViewer, payload: ViewerShowPayload): void {
    if (!p.win || p.win.isDestroyed()) {
      p.win = createFileViewerWindow(p.editorWin, p.projectPath)
      const win = p.win
      p.editorWin.once('closed', () => { if (!win.isDestroyed()) win.destroy() })
      // The renderer asks for the state when it mounts (viewer:get-state), so nothing is lost
      // before it loads; showing waits for the first paint.
      win.once('ready-to-show', () => this.reveal(p))
      return
    }
    this.send(p, 'viewer:show', payload)
    this.reveal(p)
  }

  /** Show without taking focus; flash the editor's taskbar entry when AIDE is in the background. */
  private reveal(p: ProjectViewer): void {
    const win = p.win
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.showInactive()
    if (!BrowserWindow.getFocusedWindow() && !p.editorWin.isDestroyed()) p.editorWin.flashFrame(true)
  }

  private send(p: ProjectViewer, channel: string, payload: unknown): void {
    if (p.win && !p.win.isDestroyed()) p.win.webContents.send(channel, payload)
  }

  private schedulePageReload(p: ProjectViewer): void {
    if (p.pageTimer) clearTimeout(p.pageTimer)
    p.pageTimer = setTimeout(() => {
      p.pageTimer = null
      if (p.lastShow) this.send(p, 'viewer:page-changed', { seq: p.lastShow.seq } satisfies ViewerPageChanged)
    }, PAGE_RELOAD_DEBOUNCE_MS)
  }

  private onFsChange(projectPath: string, fullPath: string): void {
    const p = this.projects.get(fold(projectPath))
    const d = p?.displayed
    if (!p || !d || !p.win || p.win.isDestroyed() || !p.lastShow) return
    // A page reloads on any file it loaded, itself included; Markdown re-renders on its own
    // text through viewer:live and reloads only the images.
    const changed = fold(fullPath)
    if (p.loadedFiles.has(changed) && (d.kind === 'html' || changed !== fold(d.absolute))) this.schedulePageReload(p)
    if (fold(fullPath) !== fold(d.absolute)) return
    const seq = p.lastShow.seq
    let live: ViewerLivePayload
    try {
      const content = readForView(d.absolute, d.kind)
      if (d.kind === 'image') live = { seq, relPath: d.relPath, content, startLine: 1 }
      else {
        const slice = sliceRange(content, d.range)
        live = slice
          ? { seq, relPath: d.relPath, content: slice.text, startLine: slice.startLine }
          : { seq, relPath: d.relPath, content: null, startLine: 1, problem: `The range ${describeRange(d.range)} is not in the file any more.` }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/not found|ENOENT/.test(message)) logEvent('viewer-live-read-failed', { path: d.relPath, message }, 'warn')
      live = { seq, relPath: d.relPath, content: null, startLine: 1, problem: /ENOENT|no such file/i.test(message) ? 'The file was deleted.' : message }
    }
    this.send(p, 'viewer:live', live)
  }
}

export const viewerService = new ViewerService()
