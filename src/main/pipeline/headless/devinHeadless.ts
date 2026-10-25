import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { runProcess } from '../processRunner'
import { failedRun, parseFinalJson, processError, promptWithRoleAndSchema, resolveExecutable } from './common'
import { devinToolView } from '../../pty/cliTools/toolViews'
import type { HistoryBlock, HistoryEntry } from '../../pty/cliTools/types'
import type { HeadlessCapability, HeadlessResult, HeadlessRunOptions, HeadlessRun } from './types'

/**
 * Devin CLI headless adapter (`devin -p --prompt-file`). Verified against
 * Devin 3000.11.92; see docs/headless-cli-matrix.md.
 *
 * - stdout is the final message only. `--export <file>` writes the session as
 *   ATIF (`session_id` — a name such as "thoughtful-papyrus" — and every step);
 *   the transcript of the visit comes from it when the run ends, filtered to the
 *   steps of this run (the export of a resumed session holds all of them).
 * - `--config <file>` replaces the user config for the run: the user's settings
 *   with no MCP servers of its own and `read_config_from` switching off what
 *   Devin otherwise imports from Claude Code and Cursor (their MCP servers,
 *   CLAUDE.md and rules). Step agents start without MCP servers.
 * - read-only: `--permission-mode auto` — Devin auto-approves the tools and
 *   shell commands it classifies as read-only and rejects the rest, since print
 *   mode cannot ask. write: `--permission-mode dangerous` (`accept-edits` would
 *   reject running tests).
 * - Role instructions are prepended and the output schema is appended as an
 *   instruction — Devin has no structured output. Resume is `-r <session id>`.
 */

// ── User config ───────────────────────────────────────────────────────────────

/** Devin's config.json: %APPDATA%\devin on Windows, ~/.config/devin elsewhere. */
function userConfigPath(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'devin', 'config.json')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'devin', 'config.json')
}

export function buildDevinConfig(user: Record<string, unknown>): Record<string, unknown> {
  return { ...user, mcpServers: {}, read_config_from: { claude: false, cursor: false } }
}

function readUserConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = userConfigPath(env)
  try {
    const value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// ── Invocation ────────────────────────────────────────────────────────────────

export function buildDevinArgs(options: HeadlessRunOptions, files: { prompt: string; config: string; export: string }): string[] {
  const args = ['-p', '--prompt-file', files.prompt, '--config', files.config, '--respect-workspace-trust', 'false',
    '--permission-mode', options.permissions === 'write' ? 'dangerous' : 'auto', '--export', files.export]
  if (options.model) args.push('--model', options.model)
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  return args
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** ATIF fields arrive either as JSON values or as JSON encoded in a string. */
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

export interface DevinExport {
  sessionId: string | null
  entries: HistoryEntry[]
}

/** Session id and transcript of an ATIF export, keeping the steps at or after `sinceMs`. */
export function readDevinExport(text: string, sinceMs: number): DevinExport {
  const root = obj(decoded(text))
  const entries: HistoryEntry[] = []
  for (const value of Array.isArray(root.steps) ? root.steps : []) {
    const step = obj(value)
    const at = Date.parse(str(step.timestamp))
    if (Number.isFinite(at) && at < sinceMs) continue
    if (step.source === 'user') {
      if (str(step.message).trim()) entries.push({ role: 'user', blocks: [{ type: 'text', text: str(step.message) }] })
      continue
    }
    if (step.source !== 'agent') continue
    const blocks: HistoryBlock[] = []
    if (str(step.reasoning_content).trim()) blocks.push({ type: 'thinking', thinking: str(step.reasoning_content) })
    if (str(step.message).trim()) blocks.push({ type: 'text', text: str(step.message) })
    const calls = decoded(step.tool_calls)
    for (const call of Array.isArray(calls) ? calls : []) {
      const c = obj(call)
      const name = str(c.function_name)
      blocks.push({ type: 'tool_use', id: str(c.tool_call_id), name, input: c.arguments ?? {}, view: devinToolView(name, c.arguments) })
    }
    const results = obj(decoded(step.observation)).results
    for (const result of Array.isArray(results) ? results : []) {
      const r = obj(result)
      blocks.push({ type: 'tool_result', tool_use_id: str(r.source_call_id), content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '') })
    }
    if (blocks.length > 0) entries.push({ role: 'assistant', blocks })
  }
  return { sessionId: str(root.session_id) || null, entries }
}

export const devinHeadless: HeadlessCapability = {
  run(options: HeadlessRunOptions): HeadlessRun {
    const resolved = options.executable ? null : resolveExecutable('devin', options.env)
    const executable = options.executable ?? (resolved ? { command: resolved } : null)
    if (!executable) return failedRun('not_installed', 'Devin executable was not found')

    const files = {
      prompt: join(options.runDir, 'devin-prompt.md'),
      config: join(options.runDir, 'devin-config.json'),
      export: join(options.runDir, 'devin-export.json')
    }
    try {
      rmSync(files.export, { force: true }) // never read an export left by an earlier attempt
      writeFileSync(files.prompt, promptWithRoleAndSchema(options), 'utf8')
      writeFileSync(files.config, JSON.stringify(buildDevinConfig(readUserConfig(options.env)), null, 2), 'utf8')
    } catch (err) {
      return failedRun('spawn_failed', `Devin run files could not be written: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (options.resumeSessionId) options.onSessionId?.(options.resumeSessionId)
    let stdout = ''
    const startedAt = Date.now()

    const handle = runProcess({
      command: executable.command,
      args: [...(executable.args ?? []), ...buildDevinArgs(options, files)],
      cwd: options.cwd,
      env: { ...options.env, PWD: options.cwd },
      timeoutMs: options.timeoutMs,
      label: options.label,
      onStdoutLine: (line) => { stdout += (stdout ? '\n' : '') + line }
    })

    const result = handle.done.then((exit): HeadlessResult => {
      let exported: DevinExport = { sessionId: null, entries: [] }
      try {
        if (existsSync(files.export)) exported = readDevinExport(readFileSync(files.export, 'utf8'), startedAt)
      } catch { /* a broken export loses the transcript, not the result */ }
      const sessionId = exported.sessionId ?? options.resumeSessionId ?? null
      if (sessionId && sessionId !== options.resumeSessionId) options.onSessionId?.(sessionId)
      for (const entry of exported.entries) options.onEntry?.(entry)

      const finalText = stdout.trim()
      const base: HeadlessResult = { ok: false, sessionId, structured: null, finalText: finalText || null, costUsd: null, warnings: [], error: null }
      const exitError = processError(exit, 'Devin')
      if (exitError) return { ...base, error: exitError }
      if (!finalText) return { ...base, error: { code: 'no_output', message: 'Devin returned no final message' } }
      if (options.outputSchema) {
        try {
          base.structured = parseFinalJson(finalText)
        } catch {
          return { ...base, error: { code: 'no_output', message: 'Devin final message is not valid JSON' } }
        }
      }
      return { ...base, ok: true }
    })

    return { result, cancel: () => handle.cancel() }
  }
}
