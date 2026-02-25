import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { runGitStatus, GitStatusResult } from './gitStatus'

// ── Git refresh queue ─────────────────────────────────────────────────────────
// Runs git status serially. If changes arrive while git is already running,
// one pending refresh is queued and starts immediately after the current finishes.

class GitRefreshQueue {
  private running = false
  private pending = false

  async request(projectPath: string, send: (s: GitStatusResult) => void): Promise<void> {
    if (this.running) {
      this.pending = true
      return
    }
    await this._run(projectPath, send)
  }

  private async _run(projectPath: string, send: (s: GitStatusResult) => void): Promise<void> {
    this.running = true
    this.pending = false
    try {
      send(await runGitStatus(projectPath))
    } finally {
      this.running = false
      if (this.pending) await this._run(projectPath, send)
    }
  }
}

// ── Active watchers registry ──────────────────────────────────────────────────

interface WatchEntry {
  watcher: fs.FSWatcher
  queue: GitRefreshQueue
  timer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, WatchEntry>()

const DEBOUNCE_MS = 300

export function startProjectWatcher(projectPath: string, win: BrowserWindow): void {
  if (watchers.has(projectPath)) return

  const queue = new GitRefreshQueue()
  const entry: WatchEntry = { watcher: null!, queue, timer: null }

  const sendGit = (status: GitStatusResult): void => {
    if (!win.isDestroyed()) win.webContents.send('filetree:git-status-updated', status)
  }

  const onFsEvent = (_event: string, rawFilename: string | Buffer | null): void => {
    if (!rawFilename) return
    const filename = rawFilename.toString()

    // Skip dot-prefixed path segments
    if (filename.split(/[/\\]/).some((p) => p.startsWith('.'))) return

    const fullPath = path.join(projectPath, filename)
    if (!win.isDestroyed()) win.webContents.send('filetree:fs-changed', { path: fullPath })

    // Debounce git refresh so rapid file changes result in a single git call
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      queue.request(projectPath, sendGit)
    }, DEBOUNCE_MS)
  }

  try {
    entry.watcher = fs.watch(projectPath, { recursive: true }, onFsEvent)
    entry.watcher.on('error', () => watchers.delete(projectPath))
    watchers.set(projectPath, entry)
  } catch {
    // fs.watch may fail due to permissions or path issues — ignore silently
  }
}

export function stopProjectWatcher(projectPath: string): void {
  const entry = watchers.get(projectPath)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.watcher.close()
  watchers.delete(projectPath)
}
