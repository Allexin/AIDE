import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

/**
 * Append-only diagnostics recorder for the main process.
 *
 * Everything is written synchronously: a crash gives no chance to flush an async
 * queue, and a lost tail is exactly the part that explains the death. Volume is
 * low (lifecycle events, not per-keystroke), so the cost is irrelevant.
 *
 * Layout under `userData/diagnostics/`:
 *   events.jsonl       — current log, one JSON object per line
 *   events.prev.jsonl  — previous log, kept across one rotation
 *   session.json       — liveness marker for the running session
 *
 * `session.json` is the hard-crash detector. It is written at startup with
 * `cleanExit: false` and refreshed by a heartbeat. A clean shutdown flips the
 * flag. If the next startup finds `cleanExit: false`, the previous session died
 * without running its exit path — that is a crash, even when Windows recorded
 * nothing, and the heartbeat timestamp brackets when it happened.
 */

const MAX_LOG_BYTES = 8 * 1024 * 1024
const HEARTBEAT_MS = 5000

export type EventLevel = 'info' | 'warn' | 'fatal'

export interface DiagEvent {
  ts: string
  sid: string
  pid: number
  level: EventLevel
  kind: string
  data?: Record<string, unknown>
}

interface SessionMarker {
  sid: string
  pid: number
  startedAt: string
  lastHeartbeat: string
  appVersion: string
  electron: string
  cleanExit: boolean
  exitReason?: string
  exitCode?: number
}

const sessionId = randomBytes(6).toString('hex')

let dir = ''
let logPath = ''
let markerPath = ''
let marker: SessionMarker | null = null
let heartbeat: NodeJS.Timeout | null = null
let ready = false

function ensureDir(): string {
  if (!dir) {
    dir = join(app.getPath('userData'), 'diagnostics')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'events.jsonl')
    markerPath = join(dir, 'session.json')
  }
  return dir
}

/** Rotate once the current log outgrows the cap, keeping a single backup. */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(logPath)) return
    if (statSync(logPath).size < MAX_LOG_BYTES) return
    renameSync(logPath, join(dir, 'events.prev.jsonl'))
  } catch {
    // Rotation is best-effort; never let it stop us from recording.
  }
}

/**
 * Record one diagnostic event. Safe to call before `initDiagnostics` (the event
 * is dropped rather than throwing) and safe to call from a crash handler.
 */
export function logEvent(kind: string, data?: Record<string, unknown>, level: EventLevel = 'info'): void {
  if (!ready) return
  const event: DiagEvent = {
    ts: new Date().toISOString(),
    sid: sessionId,
    pid: process.pid,
    level,
    kind,
    ...(data && Object.keys(data).length > 0 ? { data } : {})
  }
  try {
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8')
  } catch {
    // A failed write must never become the thing that kills the process.
  }
}

function writeMarker(): void {
  if (!marker) return
  try {
    writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8')
  } catch {
    // Best-effort.
  }
}

/**
 * Identify the exact main bundle this session is running.
 *
 * Under `electron-vite dev`, replacing the source tree — copying a fresh build
 * over the running one, for instance — makes the dev server terminate the main
 * process and start a new one. From inside, that is indistinguishable from a
 * crash: the process is killed without reaching its exit path, so the liveness
 * marker is never flipped. Comparing this fingerprint across consecutive
 * sessions tells the two apart, because a restart carries a new bundle and a
 * crash carries the same one.
 */
function buildFingerprint(): { file: string; mtime: string; size: number } | null {
  try {
    const stats = statSync(__filename)
    return { file: __filename, mtime: stats.mtime.toISOString(), size: stats.size }
  } catch {
    return null
  }
}

/**
 * Read the marker left by the previous run and report whether it died hard.
 * Returns null when there was no previous run (or its marker is unreadable).
 */
function readPreviousMarker(): SessionMarker | null {
  try {
    if (!existsSync(markerPath)) return null
    return JSON.parse(readFileSync(markerPath, 'utf8')) as SessionMarker
  } catch {
    return null
  }
}

/**
 * Set up the recorder: detect a hard death of the previous session, open the
 * current session, and start the liveness heartbeat. Call once, early.
 */
export function startRecorder(): void {
  ensureDir()
  const previous = readPreviousMarker()
  rotateIfNeeded()
  ready = true

  marker = {
    sid: sessionId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    cleanExit: false
  }
  writeMarker()

  if (previous && !previous.cleanExit) {
    // The previous run never reached its exit path. `lastHeartbeat` is the last
    // moment we know it was alive, so death falls within HEARTBEAT_MS after it.
    const startedMs = Date.parse(previous.startedAt)
    const lastMs = Date.parse(previous.lastHeartbeat)
    logEvent(
      'previous-session-died-hard',
      {
        previousSid: previous.sid,
        previousPid: previous.pid,
        startedAt: previous.startedAt,
        lastAliveAt: previous.lastHeartbeat,
        uptimeSec: Number.isFinite(startedMs) && Number.isFinite(lastMs) ? Math.round((lastMs - startedMs) / 1000) : null,
        appVersion: previous.appVersion
      },
      'fatal'
    )
  } else if (previous) {
    logEvent('previous-session-exited-clean', {
      previousSid: previous.sid,
      reason: previous.exitReason ?? null,
      exitCode: previous.exitCode ?? null
    })
  }

  logEvent('session-start', {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    build: buildFingerprint()
  })

  heartbeat = setInterval(() => {
    if (!marker) return
    marker.lastHeartbeat = new Date().toISOString()
    writeMarker()
  }, HEARTBEAT_MS)
  // Never hold the event loop open just to tick the heartbeat.
  heartbeat.unref?.()
}

/** Flip the marker to a clean exit so the next start does not report a crash. */
export function markCleanExit(reason: string, exitCode?: number): void {
  if (!marker) return
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  marker.cleanExit = true
  marker.exitReason = reason
  marker.lastHeartbeat = new Date().toISOString()
  if (typeof exitCode === 'number') marker.exitCode = exitCode
  writeMarker()
  logEvent('session-exit', { reason, exitCode: exitCode ?? null })
}

/**
 * Throughput counters, drained by the memory sampler so that each sample says
 * how much data flowed since the previous one. Correlating a heap line with the
 * traffic that produced it is what separates "memory grew" from "this grew it".
 */
const counters = { ptyChunks: 0, ptyBytes: 0, ipcSends: 0 }

/** Called from the pty data path for every chunk received from a terminal. */
export function countPtyData(byteLength: number): void {
  counters.ptyChunks += 1
  counters.ptyBytes += byteLength
}

/** Called wherever main pushes a message at a renderer on a hot path. */
export function countIpcSend(): void {
  counters.ipcSends += 1
}

/** Read and reset the counters. */
export function drainCounters(): { ptyChunks: number; ptyBytes: number; ipcSends: number } {
  const snapshot = { ...counters }
  counters.ptyChunks = 0
  counters.ptyBytes = 0
  counters.ipcSends = 0
  return snapshot
}

export function getDiagnosticsDir(): string {
  return ensureDir()
}

export function getSessionId(): string {
  return sessionId
}
