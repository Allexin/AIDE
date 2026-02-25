import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface GitStatusResult {
  available: boolean
  changed: string[] // relative paths, forward slashes
  deleted: string[] // relative paths, forward slashes
}

function parsePorcelain(output: string): Pick<GitStatusResult, 'changed' | 'deleted'> {
  const changed: string[] = []
  const deleted: string[] = []

  for (const line of output.split('\n')) {
    if (line.length < 4) continue
    const xy = line.substring(0, 2)
    let filePath = line.substring(3)

    // Handle renames in porcelain v1: "old path -> new path"
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ')[1]
    }
    filePath = filePath.trim()
    if (!filePath) continue

    // git always uses forward slashes; check for delete status
    const isDeleted = xy[0] === 'D' || xy[1] === 'D'
    if (isDeleted) {
      deleted.push(filePath)
    } else {
      changed.push(filePath)
    }
  }

  return { changed, deleted }
}

export async function runGitStatus(projectPath: string): Promise<GitStatusResult> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: projectPath,
      timeout: 15000,
      windowsHide: true
    })
    return { available: true, ...parsePorcelain(stdout) }
  } catch {
    return { available: false, changed: [], deleted: [] }
  }
}
