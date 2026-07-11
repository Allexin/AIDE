import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { processStartTimeMs } from './platform'

interface LockData {
  pid: number
  lockedAt: number // ms since epoch — when the project was opened
}

type LockResult = { acquired: true } | { acquired: false; pid: number }

export function checkAndAcquireLock(projectDir: string): LockResult {
  const lockPath = join(projectDir, '.aide', 'lock')

  if (existsSync(lockPath)) {
    try {
      const data: LockData = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (!isNaN(data.pid) && isLockValid(data)) {
        return { acquired: false, pid: data.pid }
      }
    } catch {
      // Malformed lock file — treat as stale
    }
  }

  const lockData: LockData = { pid: process.pid, lockedAt: Date.now() }
  writeFileSync(lockPath, JSON.stringify(lockData), 'utf8')
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

/**
 * Lock is valid if:
 *   1. The PID is still alive
 *   2. That process started at or before lockedAt
 *      (if it started after, the PID was reused — the original owner is dead)
 */
function isLockValid(lock: LockData): boolean {
  if (!isProcessRunning(lock.pid)) return false

  const startTime = processStartTimeMs(lock.pid)
  if (startTime === null) {
    // Can't determine start time — fall back to PID-only check (original behaviour)
    return true
  }

  return startTime <= lock.lockedAt
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
