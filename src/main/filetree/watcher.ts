import * as fs from 'fs'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { runGitStatus, GitStatusResult } from './gitStatus'
import { logEvent } from '../diagnostics'

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
    const startedAt = Date.now()
    try {
      const status = await runGitStatus(projectPath)
      // On a very large repository this call is slow and its result is large;
      // both feed main-process memory pressure, so record the shape of it.
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > 1000) {
        logEvent(
          'git-status-slow',
          {
          projectPath,
          elapsedMs,
          changed: status.changed.length,
          deleted: status.deleted.length,
          untracked: status.untracked.length
        },
          'warn'
        )
      }
      send(status)
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
  stopRateReport?: () => void
}

const watchers = new Map<string, WatchEntry>()
const fsChangeObservers = new Set<(projectPath: string, fullPath: string) => void>()
const gitStatusObservers = new Set<(projectPath: string, status: GitStatusResult) => void>()

const DEBOUNCE_MS = 300
/** Coalescing window for `filetree:fs-changed` before it crosses to the renderer. */
const FS_BATCH_FLUSH_MS = 50
/** How often the watcher reports its event rate to diagnostics. */
const FS_RATE_REPORT_MS = 10_000
/** Above this many events per report window the rate is logged as a warning. */
const FS_RATE_WARN_PER_WINDOW = 500

export function addFsChangeObserver(observer: (projectPath: string, fullPath: string) => void): () => void {
  fsChangeObservers.add(observer)
  return () => fsChangeObservers.delete(observer)
}

export function addGitStatusObserver(observer: (projectPath: string, status: GitStatusResult) => void): () => void {
  gitStatusObservers.add(observer)
  return () => gitStatusObservers.delete(observer)
}

export function startProjectWatcher(projectPath: string, win: BrowserWindow): void {
  if (watchers.has(projectPath)) return

  const queue = new GitRefreshQueue()
  const entry: WatchEntry = { watcher: null!, gitIndexWatcher: null, queue, timer: null }

  const sendGit = (status: GitStatusResult): void => {
    if (!win.isDestroyed()) win.webContents.send('filetree:git-status-updated', status)
    for (const observer of gitStatusObservers) observer(projectPath, status)
  }

  const scheduleGitRefresh = (): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      queue.request(projectPath, sendGit)
    }, DEBOUNCE_MS)
  }

  // Every accepted event sends one IPC message to the renderer. On a large or
  // busy tree that rate can outpace the renderer, and undelivered messages are
  // held in main-process memory — a rate worth being able to see after a death.
  let eventsSinceReport = 0
  let skippedSinceReport = 0
  let reportTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (eventsSinceReport === 0 && skippedSinceReport === 0) return
    logEvent(
      'fs-event-rate',
      {
        projectPath,
        sent: eventsSinceReport,
        skipped: skippedSinceReport,
        perSec: Math.round(eventsSinceReport / (FS_RATE_REPORT_MS / 1000)),
        windowMs: FS_RATE_REPORT_MS
      },
      eventsSinceReport > FS_RATE_WARN_PER_WINDOW ? 'warn' : 'info'
    )
    eventsSinceReport = 0
    skippedSinceReport = 0
  }, FS_RATE_REPORT_MS)
  reportTimer.unref?.()

  // Raw events are coalesced before crossing the IPC boundary. One message per
  // event means one serialisation and one queue entry per event, and a build
  // touching thousands of files outruns the renderer — the backlog then sits in
  // main-process memory. A short fixed window collapses repeats on the same
  // path and turns a storm into one message.
  //
  // The window is a fixed delay, not a debounce: continuous activity must still
  // deliver, and a debounce under sustained load would never fire at all.
  let pendingPaths = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flushFsChanges = (): void => {
    flushTimer = null
    if (pendingPaths.size === 0) return
    const paths = [...pendingPaths]
    pendingPaths.clear()

    if (!win.isDestroyed()) win.webContents.send('filetree:fs-changed', { paths })
    // Observers keep their per-path contract; only the IPC hop is batched.
    for (const fullPath of paths) {
      for (const observer of fsChangeObservers) observer(projectPath, fullPath)
    }
  }

  const onFsEvent = (_event: string, rawFilename: string | Buffer | null): void => {
    if (!rawFilename) return
    const filename = rawFilename.toString()

    // Skip dot-prefixed path segments (e.g. .git, .aide)
    if (filename.split(/[/\\]/).some((p) => p.startsWith('.'))) {
      skippedSinceReport += 1
      return
    }

    eventsSinceReport += 1
    pendingPaths.add(path.join(projectPath, filename))
    if (!flushTimer) flushTimer = setTimeout(flushFsChanges, FS_BATCH_FLUSH_MS)

    scheduleGitRefresh()
  }

  entry.stopRateReport = (): void => {
    if (reportTimer) clearInterval(reportTimer)
    reportTimer = null
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    pendingPaths = new Set()
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
  entry.stopRateReport?.()
  entry.watcher.close()
  entry.gitIndexWatcher?.close()
  watchers.delete(projectPath)
}
