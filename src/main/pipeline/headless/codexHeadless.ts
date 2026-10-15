import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { runProcess } from '../processRunner'
import { classifyFailure, failedRun, parseJsonLine, processError, resolveExecutable } from './common'
import type { HistoryEntry } from '../../pty/cliTools/types'
import type { HeadlessCapability, HeadlessResult, HeadlessRunOptions, HeadlessRun } from './types'

/**
 * Codex headless adapter (`codex exec --json`). Invocation follows the recipe
 * proven in production by the rutracker metadata pipeline; event mapping
 * follows the `exec --json` event stream (thread.started / item.completed /
 * turn.completed / turn.failed / error). See docs/headless-cli-matrix.md.
 *
 * - The session id is the `thread_id` of `thread.started`; resume uses
 *   `codex exec resume <id>`.
 * - Structured output: `--output-schema <file>` + `-o <file>`; Codex validates
 *   the final message against the (strict) schema and writes it to the file.
 * - Codex rejects stdin above ~1 MiB; larger context must go through files.
 * - Role instructions are prepended to the prompt: `model_instructions_file`
 *   replaces Codex's own base instructions rather than appending to them.
 * - `--ignore-user-config` keeps the user's MCP servers and profiles out of
 *   pipeline steps, but it also drops their model and reasoning effort —
 *   without them a step silently runs on the model's default effort (as low as
 *   "low"). Both are passed explicitly: the step's own values, else the user's
 *   config. (Reasoning summaries cannot be restored: `codex exec` reports
 *   `summary: "none"` whatever the config says, as of 0.162.)
 */

export interface CodexDefaults {
  model?: string
  effort?: string
}

/** Top-level `model` and `model_reasoning_effort` of a Codex config.toml. */
export function parseCodexDefaults(toml: string): CodexDefaults {
  const top = toml.split(/^\s*\[/m)[0]
  const value = (key: string): string | undefined => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm').exec(top)
    return match?.[1] || undefined
  }
  return { model: value('model'), effort: value('model_reasoning_effort') }
}

export function readCodexDefaults(env: NodeJS.ProcessEnv): CodexDefaults {
  const path = join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
  try { return existsSync(path) ? parseCodexDefaults(readFileSync(path, 'utf8')) : {} } catch { return {} }
}



export const MAX_PROMPT_CHARS = 900_000

export function buildCodexArgs(options: HeadlessRunOptions, files: { schema: string | null; lastMessage: string }, defaults: CodexDefaults = {}): string[] {
  const args = ['exec']
  if (options.resumeSessionId) args.push('resume')
  args.push('--json', '--skip-git-repo-check', '--ignore-user-config')
  if (!options.resumeSessionId) args.push('--color', 'never', '--cd', options.cwd)
  const model = options.model ?? defaults.model
  if (model) args.push('--model', model)
  const effort = options.effort ?? defaults.effort
  if (effort) args.push('-c', `model_reasoning_effort='${effort}'`)
  if (options.permissions === 'write') args.push('--dangerously-bypass-approvals-and-sandbox')
  else {
    if (options.resumeSessionId) args.push('-c', "sandbox_mode='read-only'") // `exec resume` has no --sandbox flag
    else args.push('--sandbox', 'read-only')
    // With --ignore-user-config the default Windows sandbox blocks every command,
    // reads included; the elevated sandbox allows reads and denies writes.
    if (process.platform === 'win32') args.push('-c', "windows.sandbox='elevated'")
  }
  if (files.schema) args.push('--output-schema', files.schema)
  args.push('-o', files.lastMessage)
  if (options.resumeSessionId) args.push(options.resumeSessionId)
  args.push('-')
  return args
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `"C:\…\pwsh.exe" -Command 'Get-Content x'` → `Get-Content x`; anything else unchanged. */
export function unwrapShellCommand(command: string): string {
  const match = /^"?[^"]*?\b(?:pwsh|powershell)(?:\.exe)?"?\s+-Command\s+(['"])([\s\S]*)\1\s*$/i.exec(command.trim())
  return match ? match[2] : command
}

const FILE_CHANGE_WORDS: Record<string, string> = { add: 'Add', delete: 'Delete', update: 'Update' }

/** Map one completed Codex item to transcript entries. Errors and unknown items map to nothing. */
export function codexItemEntries(item: Record<string, unknown>): HistoryEntry[] {
  const id = str(item.id)
  switch (item.type) {
    case 'agent_message':
      return str(item.text) ? [{ role: 'assistant', blocks: [{ type: 'text', text: str(item.text) }] }] : []
    case 'reasoning':
      return str(item.text) ? [{ role: 'assistant', blocks: [{ type: 'thinking', thinking: str(item.text) }] }] : []
    case 'command_execution': {
      const command = unwrapShellCommand(str(item.command))
      const exitCode = typeof item.exit_code === 'number' ? `\n(exit code ${item.exit_code})` : ''
      return [
        { role: 'assistant', blocks: [{ type: 'tool_use', id, name: 'shell', input: { command }, view: { kind: 'shell', command } }] },
        { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content: str(item.aggregated_output) + exitCode }] }
      ]
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : []
      const paths = changes.map((change) => str(change.path))
      const patch = changes.map((change) => `*** ${FILE_CHANGE_WORDS[str(change.kind)] ?? 'Update'} File: ${str(change.path)}`).join('\n')
      return [
        { role: 'assistant', blocks: [{ type: 'tool_use', id, name: 'apply_patch', input: { changes }, view: { kind: 'patch', paths, patch } }] },
        { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content: str(item.status) }] }
      ]
    }
    case 'mcp_tool_call': {
      const name = [str(item.server), str(item.tool)].filter(Boolean).join('.') || 'mcp'
      const output = item.error ?? item.result ?? ''
      return [
        { role: 'assistant', blocks: [{ type: 'tool_use', id, name, input: item.arguments ?? {} }] },
        { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: id, content: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }] }
      ]
    }
    case 'web_search':
      return [{ role: 'assistant', blocks: [{ type: 'tool_use', id, name: 'web_search', input: { query: str(item.query) } }] }]
    default:
      return []
  }
}

export const codexHeadless: HeadlessCapability = {
  run(options: HeadlessRunOptions): HeadlessRun {
    const resolved = options.executable ? null : resolveExecutable('codex', options.env)
    const executable = options.executable ?? (resolved ? { command: resolved } : null)
    if (!executable) return failedRun('not_installed', 'Codex executable was not found')

    const prompt = options.systemAppend ? `${options.systemAppend}\n\n---\n\n${options.prompt}` : options.prompt
    if (prompt.length > MAX_PROMPT_CHARS) {
      return failedRun('prompt_too_large', `Prompt is ${prompt.length} characters; Codex accepts at most ~1 MiB on stdin. Pass large context through files.`)
    }

    const files = { schema: null as string | null, lastMessage: join(options.runDir, 'last-message.txt') }
    if (options.outputSchema) {
      files.schema = join(options.runDir, 'output-schema.json')
      writeFileSync(files.schema, JSON.stringify(options.outputSchema, null, 2), 'utf8')
    }

    let sessionId: string | null = options.resumeSessionId ?? null
    if (sessionId) options.onSessionId?.(sessionId)
    let lastAgentMessage: string | null = null
    let fatal: string | null = null
    const warnings: string[] = []

    const handle = runProcess({
      command: executable.command,
      args: [...(executable.args ?? []), ...buildCodexArgs(options, files, readCodexDefaults(options.env))],
      cwd: options.cwd,
      env: options.env,
      stdin: prompt,
      timeoutMs: options.timeoutMs,
      label: options.label,
      onStdoutLine: (line) => {
        const event = parseJsonLine(line)
        if (!event) return
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          if (sessionId !== event.thread_id) { sessionId = event.thread_id; options.onSessionId?.(sessionId) }
        } else if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
          const item = event.item as Record<string, unknown>
          if (item.type === 'error') warnings.push(str(item.message))
          if (item.type === 'agent_message') lastAgentMessage = str(item.text)
          for (const entry of codexItemEntries(item)) options.onEntry?.(entry)
        } else if (event.type === 'turn.failed') {
          const error = event.error as Record<string, unknown> | undefined
          fatal = str(error?.message) || 'turn failed'
        } else if (event.type === 'error') {
          fatal = str(event.message) || 'error'
        }
      }
    })

    const result = handle.done.then((exit): HeadlessResult => {
      const lastMessage = existsSync(files.lastMessage) ? readFileSync(files.lastMessage, 'utf8') : lastAgentMessage
      const base: HeadlessResult = { ok: false, sessionId, structured: null, finalText: lastMessage, costUsd: null, warnings, error: null }
      const exitError = processError(exit, 'Codex')
      if (exitError && exitError.code !== 'failed' && exitError.code !== 'limit') return { ...base, error: exitError }
      if (fatal) return { ...base, error: { code: classifyFailure(fatal), message: fatal } }
      if (exitError) return { ...base, error: exitError }
      if (options.outputSchema) {
        try {
          base.structured = JSON.parse(lastMessage ?? '')
        } catch {
          return { ...base, error: { code: 'no_output', message: 'Codex final message is not valid JSON' } }
        }
      }
      return { ...base, ok: true }
    })

    return { result, cancel: () => handle.cancel() }
  }
}
