import { BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { addFsChangeObserver } from './watcher'

interface IndexedFile {
  name: string
  path: string
  relativePath: string
  type: 'file'
}

interface ProjectIndex {
  win: BrowserWindow
  files: IndexedFile[]
  ready: boolean
  worker: Worker | null
  startTimer: ReturnType<typeof setTimeout> | null
  rebuildTimer: ReturnType<typeof setTimeout> | null
  generation: number
}

const indexes = new Map<string, ProjectIndex>()
const INITIAL_DELAY_MS = 1000
const REBUILD_DEBOUNCE_MS = 500

function buildIndex(projectPath: string): void {
  const index = indexes.get(projectPath)
  if (!index) return

  index.worker?.terminate()
  const generation = ++index.generation
  const worker = new Worker(join(__dirname, 'fileIndexWorker.js'), {
    workerData: { projectPath }
  })
  index.worker = worker

  worker.once('message', (files: IndexedFile[]) => {
    const current = indexes.get(projectPath)
    if (!current || current.generation !== generation) return

    current.files = files
    current.ready = true
    current.worker = null
    if (!current.win.isDestroyed()) {
      current.win.webContents.send('filetree:index-updated')
    }
  })

  const handleFailure = (): void => {
    const current = indexes.get(projectPath)
    if (!current || current.generation !== generation) return
    current.worker = null
  }
  worker.once('error', handleFailure)
  worker.once('exit', (code) => {
    if (code !== 0) handleFailure()
  })
}

export function startProjectFileIndex(projectPath: string, win: BrowserWindow): void {
  stopProjectFileIndex(projectPath)

  const index: ProjectIndex = {
    win,
    files: [],
    ready: false,
    worker: null,
    startTimer: null,
    rebuildTimer: null,
    generation: 0
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

  return {
    ready: true,
    files: index.files.filter((file) => file.name.toLocaleLowerCase().includes(query))
  }
}

addFsChangeObserver((projectPath) => {
  const index = indexes.get(projectPath)
  if (!index) return

  if (index.rebuildTimer) clearTimeout(index.rebuildTimer)
  index.rebuildTimer = setTimeout(() => {
    index.rebuildTimer = null
    buildIndex(projectPath)
  }, REBUILD_DEBOUNCE_MS)
})
