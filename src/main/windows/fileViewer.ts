import { BrowserWindow, screen, shell } from 'electron'
import { basename, join } from 'path'
import { is } from '@electron-toolkit/utils'
import { rendererDevUrl } from '../devEnv'
import { readProjectSettings, writeProjectSettings, type ViewerBounds } from '../config/projectConfig'
import { getAppConfig } from '../config/appConfig'

/**
 * The file viewer window (docs/file-viewer-spec.md, "Window"): owned by its editor window,
 * so it stays above that window only and minimizes and closes with it. Closing it hides it;
 * it is destroyed with its editor window.
 */

function defaultBounds(parent: BrowserWindow): ViewerBounds {
  const area = screen.getDisplayMatching(parent.getBounds()).workArea
  const width = Math.min(1100, Math.floor(area.width / 2))
  const height = Math.min(900, area.height - 40)
  return { x: area.x + area.width - width - 20, y: area.y + 20, width, height }
}

/** Saved bounds when they are still on a display, else the default. */
function initialBounds(parent: BrowserWindow, projectPath: string): ViewerBounds {
  const saved = readProjectSettings(projectPath).viewerBounds
  if (saved) {
    const area = screen.getDisplayMatching(saved).workArea
    const visible = saved.x < area.x + area.width - 50 && saved.x + saved.width > area.x + 50 && saved.y >= area.y - 10 && saved.y < area.y + area.height - 50
    if (visible) return saved
  }
  return defaultBounds(parent)
}

export function createFileViewerWindow(parent: BrowserWindow, projectPath: string): BrowserWindow {
  const win = new BrowserWindow({
    ...initialBounds(parent, projectPath),
    minWidth: 480,
    minHeight: 320,
    parent,
    modal: false,
    show: false,
    title: `Viewer — ${basename(projectPath)}`,
    icon: join(__dirname, '../../app_icon.ico'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/fileViewer.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.setMenuBarVisibility(false)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A click on a link must never navigate the viewer away from itself.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  // Pages in the viewer (docs/file-viewer-spec.md, "The page"). The page frame itself stays
  // on the page: a link to a website opens in the browser, like links in Markdown. Frames
  // inside the page (maps, videos) go anywhere unless the setting keeps pages inside the
  // project (the CSP limits what a page loads, not where its frames go).
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || /^(aide-preview|about|data|blob):/i.test(event.url)) return
    const parent = event.frame?.parent
    if (!parent || parent.frameTreeNodeId === win.webContents.mainFrame.frameTreeNodeId) {
      event.preventDefault()
      if (/^(https?|mailto):/i.test(event.url)) void shell.openExternal(event.url)
      return
    }
    if (getAppConfig().privacy.viewerPagesStayInProject) event.preventDefault()
  })

  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return
    try {
      writeProjectSettings(projectPath, { ...readProjectSettings(projectPath), viewerBounds: win.getBounds() })
    } catch { /* bounds are a convenience */ }
  }
  // Windows emits these once, at the end of a drag.
  win.on('moved', saveBounds)
  win.on('resized', saveBounds)

  // Closing hides: the next show is instant and unsent comments survive.
  win.on('close', (event) => {
    if (parent.isDestroyed()) return
    event.preventDefault()
    saveBounds()
    win.hide()
  })

  if (is.dev && rendererDevUrl) {
    void win.loadURL(rendererDevUrl + '/?window=file-viewer')
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'file-viewer' } })
  }
  return win
}
