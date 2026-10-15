import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { runProcess } from '../processRunner'
import { parseHistoryLine } from '../../pty/cliTools/claudeCodeScanner'
import { classifyFailure, failedRun, parseJsonLine, processError, resolveExecutable } from './common'
import type { HeadlessCapability, HeadlessResult, HeadlessRunOptions, HeadlessRun } from './types'

/**
 * Claude Code headless adapter (`claude -p --output-format stream-json`).
 * Verified against Claude Code 2.1.295 — see docs/headless-cli-matrix.md.
 *
 * - The session id is pre-assigned with `--session-id`, so it is known before
 *   the first event; resume uses `--resume <id>`.
 * - Structured output: `--json-schema`; the final `result` event carries it in
 *   `structured_output`.
 * - Stream lines of type `assistant` / `user` have the same shape as the
 *   session JSONL, so the history parser normalizes them.
 */

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)']
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit']

export function buildClaudeArgs(options: HeadlessRunOptions, sessionId: string, systemAppendFile: string | null): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  else args.push('--session-id', sessionId)
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (systemAppendFile) args.push('--append-system-prompt-file', systemAppendFile)
  if (options.outputSchema) args.push('--json-schema', JSON.stringify(options.outputSchema))
  if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd))
  if (options.permissions === 'read-only') {
    args.push('--permission-mode', 'dontAsk', '--allowedTools', ...READ_ONLY_TOOLS, '--disallowedTools', ...WRITE_TOOLS)
  } else {
    args.push('--permission-mode', 'bypassPermissions')
  }
  return args
}

export const claudeHeadless: HeadlessCapability = {
  run(options: HeadlessRunOptions): HeadlessRun {
    const resolved = options.executable ? null : resolveExecutable('claude', options.env)
    const executable = options.executable ?? (resolved ? { command: resolved } : null)
    if (!executable) return failedRun('not_installed', 'Claude Code executable was not found')

    const sessionId = options.resumeSessionId ?? randomUUID()
    let systemAppendFile: string | null = null
    if (options.systemAppend) {
      systemAppendFile = join(options.runDir, 'system-append.md')
      writeFileSync(systemAppendFile, options.systemAppend, 'utf8')
    }
    options.onSessionId?.(sessionId)

    let resultEvent: Record<string, unknown> | null = null
    const handle = runProcess({
      command: executable.command,
      args: [...(executable.args ?? []), ...buildClaudeArgs(options, sessionId, systemAppendFile)],
      cwd: options.cwd,
      env: options.env,
      stdin: options.prompt,
      timeoutMs: options.timeoutMs,
      label: options.label,
      onStdoutLine: (line) => {
        const event = parseJsonLine(line)
        if (!event) return
        if (event.type === 'result') { resultEvent = event; return }
        if (event.type === 'assistant' || event.type === 'user') {
          const entry = parseHistoryLine(line)
          if (entry) options.onEntry?.(entry)
        }
      }
    })

    const result = handle.done.then((exit): HeadlessResult => {
      const base: HeadlessResult = { ok: false, sessionId, structured: null, finalText: null, costUsd: null, warnings: [], error: null }
      const event = resultEvent as Record<string, unknown> | null
      if (event) {
        base.finalText = typeof event.result === 'string' ? event.result : null
        base.structured = event.structured_output ?? null
        base.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
        if (typeof event.session_id === 'string') base.sessionId = event.session_id
      }
      const spawnOrSignal = processError(exit, 'Claude Code')
      if (spawnOrSignal && (spawnOrSignal.code !== 'failed' && spawnOrSignal.code !== 'limit')) return { ...base, error: spawnOrSignal }
      if (!event) return { ...base, error: spawnOrSignal ?? { code: 'no_output', message: 'Claude Code finished without a result event' } }
      if (event.is_error === true || event.subtype !== 'success') {
        const message = `${String(event.subtype ?? 'error')}: ${base.finalText ?? exit.stderrTail.slice(-500)}`
        return { ...base, error: { code: classifyFailure(message), message } }
      }
      if (options.outputSchema && base.structured === null) {
        return { ...base, error: { code: 'no_output', message: 'Claude Code returned no structured output' } }
      }
      return { ...base, ok: true }
    })

    return { result, cancel: () => handle.cancel() }
  }
}
