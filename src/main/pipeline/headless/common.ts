import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { homedir } from 'os'
import type { HeadlessErrorCode, HeadlessResult, HeadlessRun } from './types'
import type { ProcessResult } from '../processRunner'

/**
 * Resolve an executable to an absolute path by searching PATH (with PATHEXT on
 * Windows) and a few per-user install directories that are not always on the
 * PATH AIDE inherited (e.g. Claude Code's native installer uses ~/.local/bin).
 * Headless runs spawn without a shell, so a bare name is not enough.
 */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isWindows = process.platform === 'win32'
  const extensions = isWindows ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  // Only real executables: .cmd/.bat shims would need a shell to start.
  const allowed = isWindows ? extensions.filter((ext) => /^\.(exe|com)$/i.test(ext)) : extensions
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter), join(homedir(), '.local', 'bin')]
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of allowed) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const LIMIT_MARKERS = /usage limit|rate limit|rate_limit|limit reached|quota|too many requests|\b429\b|insufficient credit|credit balance/i

export function classifyFailure(text: string): HeadlessErrorCode {
  return LIMIT_MARKERS.test(text) ? 'limit' : 'failed'
}

/** Map a finished process to an error, or null when it exited cleanly. */
export function processError(result: ProcessResult, cliName: string): HeadlessResult['error'] {
  if (result.spawnError) return { code: 'spawn_failed', message: `${cliName} could not be started: ${result.spawnError}` }
  if (result.cancelled) return { code: 'cancelled', message: `${cliName} run was cancelled` }
  if (result.timedOut) return { code: 'timeout', message: `${cliName} run timed out` }
  if (result.exitCode !== 0) {
    const detail = (result.stderrTail.trim() || result.stdoutTail.trim()).slice(-1000)
    return { code: classifyFailure(detail), message: `${cliName} exited with code ${result.exitCode}: ${detail}` }
  }
  return null
}

export function failedRun(code: HeadlessErrorCode, message: string): HeadlessRun {
  return {
    result: Promise.resolve({ ok: false, sessionId: null, structured: null, finalText: null, costUsd: null, warnings: [], error: { code, message } }),
    cancel: () => Promise.resolve()
  }
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}
