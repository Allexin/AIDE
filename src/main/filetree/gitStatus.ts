import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface GitStatusResult {
  available: boolean
  changed: string[]   // tracked changed files (modified, staged, etc. — not deleted, not untracked)
  deleted: string[]   // deleted tracked files
  untracked: string[] // files git does not know about (??)
  branch: string | null // current branch name; null if unavailable or detached HEAD
}

function parsePorcelain(output: string): Pick<GitStatusResult, 'changed' | 'deleted' | 'untracked'> {
  const changed: string[] = []
  const deleted: string[] = []
  const untracked: string[] = []

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

    if (xy === '??') {
      untracked.push(filePath)
    } else if (xy[0] === 'D' || xy[1] === 'D') {
      deleted.push(filePath)
    } else {
      changed.push(filePath)
    }
  }

  return { changed, deleted, untracked }
}

export async function runGitStatus(projectPath: string): Promise<GitStatusResult> {
  const [statusResult, branchResult] = await Promise.allSettled([
    execFileAsync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd: projectPath,
      timeout: 15000,
      windowsHide: true
    }),
    execFileAsync('git', ['--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      timeout: 5000,
      windowsHide: true
    })
  ])

  if (statusResult.status === 'rejected') {
    return { available: false, changed: [], deleted: [], untracked: [], branch: null }
  }

  const branch =
    branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() || null : null

  return { available: true, ...parsePorcelain(statusResult.value.stdout), branch }
}
