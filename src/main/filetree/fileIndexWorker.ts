import { parentPort, workerData } from 'worker_threads'
import { readdirSync } from 'fs'
import { join } from 'path'

interface WorkerInput {
  projectPath: string
}

/**
 * Emits relative paths only.
 *
 * Everything the index used to carry per file — the absolute path, the base
 * name, a constant `type` field — is derivable from the relative path, and
 * storing it cost roughly four times the memory of the paths alone (measured on
 * a 135k-file project: 52 MB of objects against 13 MB of path text). The whole
 * array is structured-cloned into the main process on every rebuild, so the
 * saving applies to the transfer as much as to the resting index.
 *
 * The derived fields are reconstructed in `searchProjectFileIndex`, for the
 * handful of entries a query actually matches.
 */
const { projectPath } = workerData as WorkerInput
const relativePaths: string[] = []
const prefixLength = projectPath.length + 1

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
      relativePaths.push(fullPath.slice(prefixLength).replace(/\\/g, '/'))
    }
  }
}

visit(projectPath)
relativePaths.sort((a, b) => a.localeCompare(b))
parentPort?.postMessage(relativePaths)
