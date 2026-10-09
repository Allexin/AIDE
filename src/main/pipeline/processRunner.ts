import { spawn, execFile, type ChildProcess } from 'child_process'
import { logEvent } from '../diagnostics'

/**
 * Runs a non-interactive child process (headless agent CLI, check command)
 * without a PTY: line-framed stdout, bounded stderr capture, wall-clock
 * timeout, and cancellation that kills the whole process tree of the spawned
 * PID — and only that PID's tree, never processes by name.
 */

export interface RunProcessOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Written to stdin, which is then closed. Stdin is closed immediately when omitted. */
  stdin?: string
  timeoutMs?: number
  onStdoutLine?: (line: string) => void
  onStderr?: (chunk: string) => void
  /** Short label for diagnostics, e.g. `claude-code:implement`. */
  label: string
}

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cancelled: boolean
  /** Set when the process could not be started at all. */
  spawnError: string | null
  /** Last part of stdout / stderr, for error messages. */
  stdoutTail: string
  stderrTail: string
}

export interface ProcessHandle {
  readonly pid: number | undefined
  readonly done: Promise<ProcessResult>
  cancel(): Promise<void>
}

const TAIL_CHARS = 64 * 1024

function appendTail(tail: string, chunk: string): string {
  const next = tail + chunk
  return next.length > TAIL_CHARS ? next.slice(next.length - TAIL_CHARS) : next
}

/** Kill the process tree rooted at `pid`. Resolves when the kill command finished. */
export function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve())
    })
  }
  try {
    // Spawned detached, so the child leads its own process group.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  return Promise.resolve()
}

export function runProcess(options: RunProcessOptions): ProcessHandle {
  const { command, args, cwd, env, stdin, timeoutMs, onStdoutLine, onStderr, label } = options
  let stdoutTail = ''
  let stderrTail = ''
  let lineBuffer = ''
  let timedOut = false
  let cancelled = false
  let timer: NodeJS.Timeout | null = null

  let child: ChildProcess
  try {
    child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent('process-spawn-failed', { label, command, message }, 'warn')
    return {
      pid: undefined,
      done: Promise.resolve({ exitCode: null, signal: null, timedOut: false, cancelled: false, spawnError: message, stdoutTail: '', stderrTail: '' }),
      cancel: () => Promise.resolve()
    }
  }

  const emitLine = (line: string): void => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed && onStdoutLine) {
      try { onStdoutLine(trimmed) } catch (err) {
        logEvent('process-line-handler-error', { label, message: err instanceof Error ? err.message : String(err) }, 'warn')
      }
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutTail = appendTail(stdoutTail, chunk)
    lineBuffer += chunk
    let newline = lineBuffer.indexOf('\n')
    while (newline >= 0) {
      emitLine(lineBuffer.slice(0, newline))
      lineBuffer = lineBuffer.slice(newline + 1)
      newline = lineBuffer.indexOf('\n')
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = appendTail(stderrTail, chunk)
    onStderr?.(chunk)
  })
  // A closed pipe on the child's side must not surface as an unhandled 'error'.
  child.stdin?.on('error', () => {})
  if (stdin !== undefined) child.stdin?.end(stdin, 'utf8')
  else child.stdin?.end()

  const done = new Promise<ProcessResult>((resolve) => {
    let spawnError: string | null = null
    let settled = false
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (lineBuffer) { emitLine(lineBuffer); lineBuffer = '' }
      if (timedOut || cancelled || exitCode !== 0) {
        logEvent('process-exit', { label, pid: child.pid ?? null, exitCode, signal, timedOut, cancelled }, exitCode === 0 ? 'info' : 'warn')
      }
      resolve({ exitCode, signal, timedOut, cancelled, spawnError, stdoutTail, stderrTail })
    }
    child.on('error', (err) => {
      spawnError = err.message
      logEvent('process-error', { label, command, message: err.message }, 'warn')
      // A process that never started (e.g. ENOENT) may not emit 'close'.
      if (child.pid === undefined) settle(null, null)
    })
    child.on('close', (exitCode, signal) => settle(exitCode, signal))
  })

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      logEvent('process-timeout', { label, pid: child.pid ?? null, timeoutMs }, 'warn')
      void killProcessTree(child)
    }, timeoutMs)
  }

  return {
    pid: child.pid,
    done,
    cancel: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      cancelled = true
      await killProcessTree(child)
      await done
    }
  }
}
