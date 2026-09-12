import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { processStartTimeMs } from './platform'
import { getProjectHostLockPath } from './config/projectUserData'

interface LockData {
  pid: number
  lockedAt: number // ms since epoch — when the project was opened
  instanceId: string
}

type LockResult = { acquired: true } | { acquired: false; pid: number }

export function checkAndAcquireLock(projectDir: string): LockResult {
  const lockPath = getProjectHostLockPath(projectDir)
  mkdirSync(dirname(lockPath), { recursive: true })
  const lockData: LockData = { pid: process.pid, lockedAt: Date.now(), instanceId: randomUUID() }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify(lockData), { encoding: 'utf8', flag: 'wx' })
      ownedLocks.set(lockPath, lockData.instanceId)
      return { acquired: true }
    } catch {
      // Usually EEXIST. Inspect the owner before deciding whether to retry.
    }

    let observed = ''
    try {
      observed = readFileSync(lockPath, 'utf8')
      const data = JSON.parse(observed) as LockData
      if (Number.isInteger(data.pid) && data.pid > 0 && isLockValid(data)) {
        return { acquired: false, pid: data.pid }
      }
    } catch {
      // Missing, unreadable or malformed locks are stale candidates.
    }

    try {
      // Do not delete a fresh lock that replaced the stale one after we read it.
      if (readFileSync(lockPath, 'utf8') === observed) unlinkSync(lockPath)
    } catch {
      // The next exclusive-create attempt will resolve the race.
    }
  }

  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8')) as LockData
    return { acquired: false, pid: Number.isFinite(data.pid) ? data.pid : 0 }
  } catch {
    return { acquired: false, pid: 0 }
  }
}

const ownedLocks = new Map<string, string>()

export function releaseLock(projectDir: string): void {
  const lockPath = getProjectHostLockPath(projectDir)
  const instanceId = ownedLocks.get(lockPath)
  if (!instanceId) return

  if (existsSync(lockPath)) {
    try {
      const data = JSON.parse(readFileSync(lockPath, 'utf8')) as LockData
      if (data.instanceId === instanceId) unlinkSync(lockPath)
    } catch {
      // Ignore errors on cleanup
    }
  }
  ownedLocks.delete(lockPath)
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
