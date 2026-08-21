import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { addFsChangeObserver } from './watcher'
import { logEvent } from '../diagnostics'

interface IndexedFile {
  name: string
  path: string
  relativePath: string
  type: 'file'
}

interface ProjectIndex {
  win: BrowserWindow
  /** Sorted relative paths. Derived fields are reconstructed only for matches. */
  paths: string[]
  ready: boolean
  worker: Worker | null
  startTimer: ReturnType<typeof setTimeout> | null
  rebuildTimer: ReturnType<typeof setTimeout> | null
  generation: number
  /** A rebuild is in flight; further requests coalesce into `dirty`. */
  building: boolean
  /** The tree changed while a rebuild was running — rebuild once it finishes. */
  dirty: boolean
  /** Duration of the last completed walk; the debounce floor adapts to it. */
  lastBuildMs: number
}

const indexes = new Map<string, ProjectIndex>()
const INITIAL_DELAY_MS = 1000
const REBUILD_DEBOUNCE_MS = 500

/**
 * How the rebuild schedule protects itself on large trees.
 *
 * A full walk of a big project takes far longer than the debounce that triggers
 * it (measured: 1359 ms against a 500 ms window on 135k files). With a plain
 * debounce, sustained file activity starts a fresh walk while the previous one
 * is still running, and every walk that does reach `postMessage` deserializes
 * its entire result into the main heap before the generation check can discard
 * it. That is a lot of garbage produced by work whose result is thrown away.
 *
 * Two rules remove it, and neither depends on knowing anything about the
 * project's contents:
 *
 *   1. Never run two rebuilds at once. A change arriving mid-build sets `dirty`,
 *      and exactly one rebuild follows the current one.
 *   2. Never schedule sooner than the last walk took. Small projects keep the
 *      500 ms responsiveness; large ones back off in proportion to their own
 *      measured cost, with no threshold to tune.
 */
function scheduleRebuild(projectPath: string): void {
  const index = indexes.get(projectPath)
  if (!index) return

  if (index.building) {
    index.dirty = true
    return
  }

  if (index.rebuildTimer) clearTimeout(index.rebuildTimer)
  const delay = Math.max(REBUILD_DEBOUNCE_MS, index.lastBuildMs)
  index.rebuildTimer = setTimeout(() => {
    index.rebuildTimer = null
    buildIndex(projectPath)
  }, delay)
}

function buildIndex(projectPath: string): void {
  const index = indexes.get(projectPath)
  if (!index) return
  // The guard in `scheduleRebuild` makes this unreachable in normal flow; it is
  // kept because `buildIndex` is also the entry point for the initial build.
  if (index.building) {
    index.dirty = true
    return
  }

  const generation = ++index.generation
  const startedAt = Date.now()
  index.building = true
  index.dirty = false

  let worker: Worker
  try {
    worker = new Worker(join(__dirname, 'fileIndexWorker.js'), { workerData: { projectPath } })
  } catch (err) {
    index.building = false
    logEvent('index-rebuild-failed', { projectPath, message: (err as Error)?.message ?? String(err) }, 'warn')
    return
  }
  index.worker = worker
  logEvent('index-rebuild-start', { projectPath, generation })

  /** Runs exactly once per build, whatever the outcome, to release the guard. */
  const settle = (): void => {
    const current = indexes.get(projectPath)
    if (!current || current.generation !== generation) return
    current.building = false
    current.worker = null
    if (current.dirty) {
      current.dirty = false
      scheduleRebuild(projectPath)
    }
  }

  worker.once('message', (paths: string[]) => {
    const elapsedMs = Date.now() - startedAt
    const current = indexes.get(projectPath)
    const stale = !current || current.generation !== generation
    logEvent(
      'index-rebuild-done',
      { projectPath, generation, files: paths.length, elapsedMs, discarded: stale },
      stale ? 'warn' : 'info'
    )
    if (stale) return

    current.paths = paths
    current.ready = true
    current.lastBuildMs = elapsedMs
    if (!current.win.isDestroyed()) {
      current.win.webContents.send('filetree:index-updated')
    }
    settle()
  })

  worker.once('error', (err) => {
    logEvent('index-rebuild-failed', { projectPath, generation, message: err?.message ?? String(err) }, 'warn')
    settle()
  })
  worker.once('exit', (code) => {
    // A clean exit follows the 'message' handler, which has already settled.
    if (code !== 0) settle()
  })
}

export function startProjectFileIndex(projectPath: string, win: BrowserWindow): void {
  stopProjectFileIndex(projectPath)

  const index: ProjectIndex = {
    win,
    paths: [],
    ready: false,
    worker: null,
    startTimer: null,
    rebuildTimer: null,
    generation: 0,
    building: false,
    dirty: false,
    lastBuildMs: 0
  }
  indexes.set(projectPath, index)
  index.startTimer = setTimeout(() => {
    index.startTimer = null
    buildIndex(projectPath)
  }, INITIAL_DELAY_MS)
}

export function stopProjectFileIndex(projectPath: string): void {
  const index = indexes.get(projectPath)
  if (!index) return
  if (index.startTimer) clearTimeout(index.startTimer)
  if (index.rebuildTimer) clearTimeout(index.rebuildTimer)
  index.worker?.terminate()
  indexes.delete(projectPath)
}

export function searchProjectFileIndex(
  projectPath: string,
  rawQuery: string
): { ready: boolean; files: IndexedFile[] } {
  const index = indexes.get(projectPath)
  if (!index?.ready) return { ready: false, files: [] }

  const query = rawQuery.trim().toLocaleLowerCase()
  if (query.length < 2) return { ready: true, files: [] }

  // Matching is on the base name, as before; the full record is materialised
  // only for the entries that survive the filter.
  const files: IndexedFile[] = []
  for (const relativePath of index.paths) {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    if (!name.toLocaleLowerCase().includes(query)) continue
    files.push({
      name,
      path: join(projectPath, relativePath),
      relativePath,
      type: 'file'
    })
  }
  return { ready: true, files }
}

addFsChangeObserver((projectPath) => {
  if (!indexes.has(projectPath)) return
  scheduleRebuild(projectPath)
})
