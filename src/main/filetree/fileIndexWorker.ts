import { parentPort, workerData } from 'worker_threads'
import { readdirSync } from 'fs'
import { join } from 'path'

interface WorkerInput {
  projectPath: string
}

interface IndexedFile {
  name: string
  path: string
  relativePath: string
  type: 'file'
}

const { projectPath } = workerData as WorkerInput
const files: IndexedFile[] = []

function visit(dirPath: string): void {
  let entries
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      visit(fullPath)
    } else {
      files.push({
        name: entry.name,
        path: fullPath,
        relativePath: fullPath.slice(projectPath.length + 1).replace(/\\/g, '/'),
        type: 'file'
      })
    }
  }
}

visit(projectPath)
files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
parentPort?.postMessage(files)
