import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'

type LockResult = { acquired: true } | { acquired: false; pid: number }

export function checkAndAcquireLock(projectDir: string): LockResult {
  const lockPath = join(projectDir, '.aide', 'lock')

  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, 'utf8').trim()
    const pid = parseInt(content, 10)

    if (!isNaN(pid) && isProcessRunning(pid)) {
      return { acquired: false, pid }
    }
    // Stale lock — process is dead, overwrite
  }

  writeFileSync(lockPath, String(process.pid), 'utf8')
  return { acquired: true }
}

export function releaseLock(projectDir: string): void {
  const lockPath = join(projectDir, '.aide', 'lock')
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath)
    } catch {
      // Ignore errors on cleanup
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
