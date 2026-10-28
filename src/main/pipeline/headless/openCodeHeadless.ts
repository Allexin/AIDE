import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { delimiter, dirname, join } from 'path'
import { homedir } from 'os'
import { runProcess } from '../processRunner'
import { classifyFailure, isClassifiedFailure, failedRun, parseFinalJson, parseJsonLine, processError, promptWithRoleAndSchema, resolveExecutable } from './common'
import { openCodePartBlocks } from '../../pty/cliTools/openCodeParts'
import { readOpenCodeRetry, readOpenCodeRunCost, readOpenCodeRunModels, type OpenCodeRetry } from '../../pty/cliTools/openCodeScanner'
import type { HeadlessCapability, HeadlessResult, HeadlessRunOptions, HeadlessRun, ResultTool } from './types'

/**
 * OpenCode 2 headless adapter (`opencode run --format json`). Verified against
 * opencode 2.1.4; see docs/headless-cli-matrix.md.
 *
 * - `--standalone`: without it the run attaches to the shared background
 *   service, which has its own config and environment, so the per-run config
 *   below would not apply.
 * - Per-run config through OPENCODE_CONFIG_CONTENT (merged over the user's and
 *   the project's): a read-only agent whose shell is limited to git inspection,
 *   and every MCP server the user or project configures switched off — step
 *   agents start without MCP servers, like Claude Code and Codex steps.
 * - The prompt goes on stdin. Role instructions are prepended (there is no flag
 *   to append to the system prompt). OpenCode has no structured-output mode:
 *   with a result tool (`options.resultTool`, AIDE's MCP endpoint added to the
 *   per-run config) the agent submits its answer as a tool call, which the tool
 *   checks against the schema, so a malformed answer is corrected in the same
 *   turn. Without one, the schema is appended as an instruction and the final
 *   message is parsed; the engine validates either answer.
 * - Effort is the model variant: `--model provider/model#variant`.
 * - Every event carries `sessionID`; resume is `--session <id>`.
 * - The stream ends before the last step's cost; the run's cost is read from
 *   the database afterwards.
 * - An error after the result tool accepted the answer (a connection lost while
 *   the turn ends) is a warning: the answer stands. Without a result tool the
 *   stream cannot tell a finished turn from a cut one, so the error fails.
 */

export const READ_ONLY_AGENT = 'aide-read-only'

const READ_ONLY_AGENT_CONFIG = {
  mode: 'primary',
  description: 'AIDE pipeline step without write access',
  permission: {
    edit: 'deny',
    webfetch: 'deny',
    bash: { '*': 'deny', 'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow', 'git show*': 'allow' }
  }
}

// ── Executable and version ────────────────────────────────────────────────────

/**
 * The native opencode executable. npm installs put only a `.cmd` shim on PATH
 * (which needs a shell); the shim names the real binary, which is used instead.
 */
export function resolveOpenCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = resolveExecutable('opencode', env)
  if (direct || process.platform !== 'win32') return direct
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    const shim = join(dir, 'opencode.cmd')
    if (!existsSync(shim)) continue
    try {
      const target = /"%dp0%\\([^"]+\.exe)"/i.exec(readFileSync(shim, 'utf8'))?.[1]
      if (target && existsSync(join(dirname(shim), target))) return join(dirname(shim), target)
    } catch { /* unreadable shim */ }
  }
  return null
}

/** `opencode --version` → major version, or null when it cannot be run or read. */
export function openCodeMajorVersion(executable: string): Promise<{ version: string; major: number } | null> {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout ?? ''))
      resolve(err || !match ? null : { version: match[0], major: Number(match[1]) })
    })
  })
}

// ── Configuration ─────────────────────────────────────────────────────────────

export function readJsonc(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const text = readFileSync(path, 'utf8')
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, quoted: string | undefined) => quoted ?? '')
      .replace(/,(\s*[}\]])/g, '$1')
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The user's, the custom (OPENCODE_CONFIG) and the project's config files, in that order. */
function configFiles(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const configDir = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(homedir(), '.config', 'opencode')
  const names = ['opencode.json', 'opencode.jsonc', 'config.json']
  return [
    ...names.map((name) => join(configDir, name)),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...names.map((name) => join(cwd, name)),
    ...names.map((name) => join(cwd, '.opencode', name))
  ]
}

export interface OpenCodeConfigSummary {
  /** The configured default model (`provider/model`), the last file that sets it wins. */
  model?: string
  mcpServers: string[]
}

export function readOpenCodeConfig(cwd: string, env: NodeJS.ProcessEnv): OpenCodeConfigSummary {
  const summary: OpenCodeConfigSummary = { mcpServers: [] }
  for (const file of configFiles(cwd, env)) {
    const config = readJsonc(file)
    if (!config) continue
    if (typeof config.model === 'string' && config.model) summary.model = config.model
    const mcp = config.mcp
    if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
      for (const name of Object.keys(mcp)) if (!summary.mcpServers.includes(name)) summary.mcpServers.push(name)
    }
  }
  return summary
}

/** OPENCODE_CONFIG_CONTENT for a run. A disabled server needs a complete entry, or OpenCode ignores the override. */
export function buildOpenCodeConfigContent(mcpServers: string[], resultTool?: ResultTool): string {
  const mcp: Record<string, unknown> = {}
  for (const name of mcpServers) mcp[name] = { type: 'local', command: ['node'], enabled: false }
  if (resultTool) mcp[resultTool.serverName] = { type: 'remote', url: resultTool.url, headers: resultTool.headers, oauth: false, enabled: true }
  return JSON.stringify({ agent: { [READ_ONLY_AGENT]: READ_ONLY_AGENT_CONFIG }, mcp })
}

/** The prompt when the answer goes through the result tool: role instructions, the task, how to submit. */
export function promptWithResultTool(options: Pick<HeadlessRunOptions, 'prompt' | 'systemAppend'>, resultTool: ResultTool): string {
  const prompt = options.systemAppend ? `${options.systemAppend}\n\n---\n\n${options.prompt}` : options.prompt
  return prompt + '\n\n---\n\n'
    + `When you are done, submit your final answer by calling the tool \`submit_result\` of the MCP server \`${resultTool.serverName}\`: its parameters are the required answer format. `
    + 'If it reports problems, correct the answer and call it again. Once it accepts the answer, end your turn. Do not write the answer as JSON in a message.'
}

// ── Invocation ────────────────────────────────────────────────────────────────

/** `--model` value: the step's model (else the configured default) with effort as its variant. */
export function openCodeModel(model: string | undefined, effort: string | undefined, defaultModel: string | undefined): string | undefined {
  const base = model ?? (effort ? defaultModel : undefined)
  if (!base) return undefined
  return effort && !base.includes('#') ? `${base}#${effort}` : base
}

export function buildOpenCodeArgs(options: HeadlessRunOptions, model: string | undefined): string[] {
  const args = ['run', '--standalone', '--format', 'json', '--thinking', '--auto']
  if (options.permissions === 'read-only') args.push('--agent', READ_ONLY_AGENT)
  if (model) args.push('--model', model)
  if (options.resumeSessionId) args.push('--session', options.resumeSessionId)
  return args
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Provider errors that mean the account (key) is out of quota or rate-limited. */
const LIMIT_ERROR_TYPES = new Set(['provider.quota', 'provider.rate-limit'])

/** Empty attempts in a row after which a retry OpenCode is in is treated as a usage limit (it would retry forever). */
export const RETRIES_BEFORE_LIMIT = 3

/** The limit message for a retry, with its retry time in a form the engine reads ("try again in N minutes"). */
export function retryLimitMessage(retry: OpenCodeRetry): string {
  const minutes = retry.retryAfterMs !== null ? Math.max(1, Math.ceil(retry.retryAfterMs / 60_000)) : null
  return `${retry.message || retry.errorType} (OpenCode retried ${retry.attempt} times${minutes !== null ? `; try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : ''})`
}

/** "provider/model" without the variant, to compare with what answered. */
function baseModel(model: string): string {
  return model.split('#')[0]
}

export const openCodeHeadless: HeadlessCapability = {
  resultTool: true,

  run(options: HeadlessRunOptions): HeadlessRun {
    const resolved = options.executable ? null : resolveOpenCodeExecutable(options.env)
    const executable = options.executable ?? (resolved ? { command: resolved } : null)
    if (!executable) return failedRun('not_installed', 'OpenCode 2 executable was not found')

    const warnings: string[] = []
    const config = readOpenCodeConfig(options.cwd, options.env)
    const model = openCodeModel(options.model, options.effort, config.model)
    if (options.effort && !model) warnings.push(`effort "${options.effort}" ignored: no model is set for the step or in the OpenCode config`)

    let sessionId: string | null = options.resumeSessionId ?? null
    if (sessionId) options.onSessionId?.(sessionId)
    let finalMessageId: string | null = null
    let finalText = ''
    let streamedCost: number | null = null
    let fatal: string | null = null
    let limit: string | null = null
    let emptySteps = 0
    const startedAt = Date.now()
    const resultTool = options.outputSchema ? options.resultTool : undefined

    const handle = runProcess({
      command: executable.command,
      args: [...(executable.args ?? []), ...buildOpenCodeArgs(options, model)],
      cwd: options.cwd,
      // OpenCode takes its working directory from PWD when set, over the real cwd.
      env: { ...options.env, PWD: options.cwd, OPENCODE_CONFIG_CONTENT: buildOpenCodeConfigContent(config.mcpServers, resultTool) },
      stdin: resultTool ? promptWithResultTool(options, resultTool) : promptWithRoleAndSchema(options),
      timeoutMs: options.timeoutMs,
      label: options.label,
      onStdoutLine: (line) => {
        const event = parseJsonLine(line)
        if (!event) return
        if (typeof event.sessionID === 'string' && event.sessionID !== sessionId) {
          sessionId = event.sessionID
          options.onSessionId?.(sessionId)
        }
        if (event.type === 'error') {
          const error = (event.error ?? {}) as Record<string, unknown>
          fatal = str(error.message) || str(error.type) || 'error'
          if (LIMIT_ERROR_TYPES.has(str(error.type))) limit = fatal
          return
        }
        // Each retry of a failing provider call is a new step_start with nothing after it.
        if (event.type === 'step_start') {
          emptySteps++
          if (emptySteps >= RETRIES_BEFORE_LIMIT && sessionId && !limit) {
            const retry = readOpenCodeRetry(sessionId)
            if (retry && LIMIT_ERROR_TYPES.has(retry.errorType)) {
              limit = retryLimitMessage(retry)
              void handle.cancel()
            }
          }
          return
        }
        emptySteps = 0
        const part = (event.part ?? {}) as Record<string, unknown>
        if (event.type === 'step_finish' && typeof part.cost === 'number') streamedCost = (streamedCost ?? 0) + part.cost
        if (event.type === 'text') {
          const messageId = str(part.messageID)
          if (messageId !== finalMessageId) { finalMessageId = messageId; finalText = '' }
          finalText += str(part.text)
        }
        const blocks = openCodePartBlocks(part)
        if (blocks.length > 0) options.onEntry?.({ role: 'assistant', blocks })
      }
    })

    const result = handle.done.then((exit): HeadlessResult => {
      const costUsd = (sessionId ? readOpenCodeRunCost(sessionId, startedAt) : null) ?? streamedCost
      const base: HeadlessResult = { ok: false, sessionId, structured: null, finalText: finalText || null, costUsd, warnings, error: null }
      if (limit) return { ...base, error: { code: 'limit', message: limit } }
      const exitError = processError(exit, 'OpenCode')
      if (exitError && !isClassifiedFailure(exitError)) return { ...base, error: exitError }
      const failure = fatal ? { code: classifyFailure(fatal), message: fatal } : exitError
      const submitted = resultTool?.submitted()
      if (failure) {
        // An answer the result tool accepted is the step's answer: an error after it (a connection
        // lost while OpenCode ends its turn) does not undo it. A usage limit still stops the step.
        if (submitted === undefined || failure.code === 'limit') return { ...base, error: failure }
        warnings.push(`after the answer was submitted: ${failure.message}`)
      }
      // OpenCode silently answers with another model (its free one) when the requested one is unavailable.
      const expected = model ?? config.model
      const answered = sessionId && expected ? readOpenCodeRunModels(sessionId, startedAt) : []
      const other = answered.filter((m) => m !== baseModel(expected ?? ''))
      if (other.length > 0) return { ...base, error: { code: 'failed', message: `OpenCode answered with ${other.join(', ')} instead of ${baseModel(expected ?? '')}; is the model available to the configured provider?` } }
      if (submitted !== undefined) return { ...base, ok: true, structured: submitted }
      if (!finalText) return { ...base, error: { code: 'no_output', message: resultTool ? 'OpenCode neither submitted an answer nor wrote a final message' : 'OpenCode returned no final message' } }
      if (options.outputSchema) {
        // Without a result tool, or when the agent wrote the answer instead of submitting it.
        try {
          base.structured = parseFinalJson(finalText)
        } catch (err) {
          return { ...base, error: { code: 'no_output', message: `OpenCode final message is not valid JSON (${err instanceof Error ? err.message : String(err)})` } }
        }
      }
      return { ...base, ok: true }
    })

    return { result, cancel: () => handle.cancel() }
  }
}
