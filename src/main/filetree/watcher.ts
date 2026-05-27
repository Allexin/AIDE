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
  /** Timestamp of the last git status completion — used to suppress self-triggered .git/index events */
  lastRunEnd = 0

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
      this.lastRunEnd = Date.now()
      this.running = false
      if (this.pending) await this._run(projectPath, send)
    }
  }
}

// ── Active watchers registry ──────────────────────────────────────────────────

interface WatchEntry {
  watcher: fs.FSWatcher
  gitIndexWatcher: fs.FSWatcher | null
  queue: GitRefreshQueue
  timer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, WatchEntry>()
const fsChangeObservers = new Set<(projectPath: string, fullPath: string) => void>()

const DEBOUNCE_MS = 300

export function addFsChangeObserver(observer: (projectPath: string, fullPath: string) => void): () => void {
  fsChangeObservers.add(observer)
  return () => fsChangeObservers.delete(observer)
}

export function startProjectWatcher(projectPath: string, win: BrowserWindow): void {
  if (watchers.has(projectPath)) return

  const queue = new GitRefreshQueue()
  const entry: WatchEntry = { watcher: null!, gitIndexWatcher: null, queue, timer: null }

  const sendGit = (status: GitStatusResult): void => {
    if (!win.isDestroyed()) win.webContents.send('filetree:git-status-updated', status)
  }

  const scheduleGitRefresh = (): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      queue.request(projectPath, sendGit)
    }, DEBOUNCE_MS)
  }

  const onFsEvent = (_event: string, rawFilename: string | Buffer | null): void => {
    if (!rawFilename) return
    const filename = rawFilename.toString()

    // Skip dot-prefixed path segments (e.g. .git, .aide)
    if (filename.split(/[/\\]/).some((p) => p.startsWith('.'))) return

    const fullPath = path.join(projectPath, filename)
    if (!win.isDestroyed()) win.webContents.send('filetree:fs-changed', { path: fullPath })
    for (const observer of fsChangeObservers) observer(projectPath, fullPath)

    scheduleGitRefresh()
  }

  try {
    entry.watcher = fs.watch(projectPath, { recursive: true }, onFsEvent)
    entry.watcher.on('error', () => watchers.delete(projectPath))
    watchers.set(projectPath, entry)
  } catch {
    // fs.watch may fail due to permissions or path issues — ignore silently
  }

  // Watch .git/index to detect commits, staging, and other git operations.
  // No filetree:fs-changed sent — only a git status refresh.
  const gitDir = path.join(projectPath, '.git')
  // Suppress .git/index events that fire right after our own git commands finish.
  // git status refreshes the index file, which triggers fs.watch again — causing a loop.
  const GIT_SELF_TRIGGER_MS = 1500

  try {
    entry.gitIndexWatcher = fs.watch(gitDir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      // Only react to the 'index' file itself, ignore index.lock and other files
      if (name !== 'index') return
      // If our own git status just finished, this event is self-triggered — skip it
      if (Date.now() - queue.lastRunEnd < GIT_SELF_TRIGGER_MS) return
      // If git is currently running, this is likely caused by the in-flight command — skip
      if (queue['running']) return
      scheduleGitRefresh()
    })
    entry.gitIndexWatcher.on('error', () => {
      entry.gitIndexWatcher = null
    })
  } catch {
    // .git/index may not exist (no git repo) — ignore silently
  }
}

export function stopProjectWatcher(projectPath: string): void {
  const entry = watchers.get(projectPath)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.watcher.close()
  entry.gitIndexWatcher?.close()
  watchers.delete(projectPath)
}
