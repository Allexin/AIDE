import { statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runProcess } from '../processRunner'
import { antigravityToolView } from '../../pty/cliTools/toolViews'
import type { HistoryBlock } from '../../pty/cliTools/types'
import { classifyFailure, failedRun, isClassifiedFailure, parseFinalJson, parseJsonLine, processError, resolveExecutable } from './common'
import type { HeadlessCapability, HeadlessResult, HeadlessRun, HeadlessRunOptions, PermissionProfile } from './types'

/**
 * Google Antigravity CLI headless adapter (`agy --input-format stream-json --output-format stream-json`).
 * Verified live against agy 1.5.14 — see docs/headless-cli-matrix.md.
 *
 * - Sends the prompt as one NDJSON `user` message on stdin so large multi-line
 *   prompts never hit Windows command-line length limits.
 * - Uses `--settings <file>` (session-only, never saved) to enforce permission
 *   profiles and block user MCP servers (`deny: ["mcp(*)"]`).
 * - Native structured output via `--json-schema <file>` → `result.structured_output`
 *   (only read when `outputSchema` was requested, because resumed turns still
 *   carry an earlier turn's `structured_output` on the conversation object).
 * - Session id is `conversation_id` from the `init` event; resume uses
 *   `--conversation <id>` and works across permission profiles.
 */

export function resolveAntigravityExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const candidate = join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
  }
  return resolveExecutable('agy', env)
}

export function buildAntigravitySettings(permissions: PermissionProfile): Record<string, unknown> {
  if (permissions === 'read-only') {
    return {
      agentMode: '',
      toolPermission: 'request-review',
      enableTerminalSandbox: false,
      permissions: {
        allow: [
          'read_file(*)',
          'command(git status)',
          'command(git diff)',
          'command(git log)',
          'command(git show)'
        ],
        deny: [
          'write_file(*)',
          'read_url(*)',
          'execute_url(*)',
          'mcp(*)'
        ]
      }
    }
  }
  // Write mode pairs with `--dangerously-skip-permissions`; deny rules still apply
  // in every mode so user MCP servers stay blocked in pipeline steps.
  return {
    permissions: {
      deny: ['mcp(*)']
    }
  }
}

export function buildAntigravityArgs(
  options: HeadlessRunOptions,
  files: { settings: string; schema: string | null }
): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--add-dir', options.runDir,
    '--settings', files.settings
  ]
  if (options.permissions === 'write') args.push('--dangerously-skip-permissions')
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.resumeSessionId) args.push('--conversation', options.resumeSessionId)
  if (files.schema) args.push('--json-schema', files.schema)
  return args
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function antigravityToolStepBlocks(step: Record<string, unknown>): HistoryBlock[] {
  const info = obj(step.tool_info)
  const name = str(info.name) || str(step.tool_name)
  if (!name) return []
  const id = `step-${typeof step.step_index === 'number' ? step.step_index : 0}`
  const input = info.parameters ?? {}
  const blocks: HistoryBlock[] = [
    { type: 'tool_use', id, name, input, view: antigravityToolView(name, input) }
  ]
  const err = obj(info.error)
  const errorText = str(err.message) || str(err.type)
  const output = typeof info.output === 'string' ? info.output : (errorText ? `Error: ${errorText}` : '')
  if (output) {
    blocks.push({ type: 'tool_result', tool_use_id: id, content: output })
  }
  return blocks
}

export const antigravityHeadless: HeadlessCapability = {
  run(options: HeadlessRunOptions): HeadlessRun {
    const resolved = options.executable ? null : resolveAntigravityExecutable(options.env)
    const executable = options.executable ?? (resolved ? { command: resolved } : null)
    if (!executable) return failedRun('not_installed', 'Google Antigravity executable was not found')

    const settingsFile = join(options.runDir, 'antigravity-settings.json')
    let schemaFile: string | null = null
    try {
      writeFileSync(settingsFile, JSON.stringify(buildAntigravitySettings(options.permissions), null, 2), 'utf8')
      if (options.outputSchema) {
        schemaFile = join(options.runDir, 'antigravity-schema.json')
        writeFileSync(schemaFile, JSON.stringify(options.outputSchema, null, 2), 'utf8')
      }
    } catch (err) {
      return failedRun('spawn_failed', `Google Antigravity run files could not be written: ${err instanceof Error ? err.message : String(err)}`)
    }

    const promptText = options.systemAppend
      ? `${options.systemAppend}\n\n---\n\n${options.prompt}`
      : options.prompt
    const stdinPayload = JSON.stringify({ event: 'user', message: { content: promptText } }) + '\n'

    let sessionId: string | null = options.resumeSessionId ?? null
    if (sessionId) options.onSessionId?.(sessionId)

    let resultEvent: Record<string, unknown> | null = null
    const textByStep = new Map<number, string>()

    const handle = runProcess({
      command: executable.command,
      args: [...(executable.args ?? []), ...buildAntigravityArgs(options, { settings: settingsFile, schema: schemaFile })],
      cwd: options.cwd,
      env: { ...(options.env ?? process.env), PWD: options.cwd },
      stdin: stdinPayload,
      timeoutMs: options.timeoutMs,
      label: options.label,
      onStdoutLine: (line) => {
        const event = parseJsonLine(line)
        if (!event) return

        const kind = str(event.event)
        if (kind === 'init') {
          const cid = str(event.conversation_id)
          if (cid && cid !== sessionId) {
            sessionId = cid
            options.onSessionId?.(sessionId)
          }
          return
        }

        if (kind === 'result') {
          const res = obj(event.result)
          resultEvent = res
          const cid = str(res.conversation_id)
          if (cid && cid !== sessionId) {
            sessionId = cid
            options.onSessionId?.(sessionId)
          }
          return
        }

        if (kind === 'step_update') {
          const step = obj(event.step_update)
          const cid = str(step.conversation_id)
          if (cid && cid !== sessionId) {
            sessionId = cid
            options.onSessionId?.(sessionId)
          }
          const stepType = str(step.step_type)
          const state = str(step.state)
          const stepIndex = typeof step.step_index === 'number' ? step.step_index : -1

          if (stepType === 'agent_response') {
            const delta = str(step.text_delta)
            if (delta) textByStep.set(stepIndex, (textByStep.get(stepIndex) ?? '') + delta)
            if (state === 'DONE') {
              const full = (textByStep.get(stepIndex) ?? '').trim()
              textByStep.delete(stepIndex)
              if (full) options.onEntry?.({ role: 'assistant', blocks: [{ type: 'text', text: full }] })
            }
          } else if (stepType === 'tool' && (state === 'DONE' || state === 'ERROR')) {
            const blocks = antigravityToolStepBlocks(step)
            if (blocks.length > 0) options.onEntry?.({ role: 'assistant', blocks })
          }
        }
      }
    })

    const result = handle.done.then((exit): HeadlessResult => {
      const base: HeadlessResult = {
        ok: false,
        sessionId,
        structured: null,
        finalText: null,
        costUsd: null,
        warnings: [],
        error: null
      }

      if (resultEvent) {
        base.finalText = typeof resultEvent.response === 'string' ? resultEvent.response : null
        if (options.outputSchema && resultEvent.structured_output !== undefined) {
          base.structured = resultEvent.structured_output
        }
        const cost = obj(resultEvent.cost)
        if (typeof cost.total_usd === 'number') base.costUsd = cost.total_usd
        const cid = str(resultEvent.conversation_id)
        if (cid) base.sessionId = cid
      }

      const spawnOrSignal = processError(exit, 'Google Antigravity')
      if (spawnOrSignal && !isClassifiedFailure(spawnOrSignal)) return { ...base, error: spawnOrSignal }
      if (!resultEvent) {
        return {
          ...base,
          error: spawnOrSignal ?? { code: 'no_output', message: 'Google Antigravity finished without a result event' }
        }
      }

      const status = str(resultEvent.status)
      if (status !== 'SUCCESS') {
        const detail = str(resultEvent.error) || base.finalText || exit.stderrTail.slice(-500) || status || 'error'
        return { ...base, error: { code: classifyFailure(detail), message: detail } }
      }

      if (options.outputSchema && base.structured === null) {
        if (base.finalText) {
          try {
            base.structured = parseFinalJson(base.finalText)
          } catch {
            return { ...base, error: { code: 'no_output', message: 'Google Antigravity returned no structured output' } }
          }
        } else {
          return { ...base, error: { code: 'no_output', message: 'Google Antigravity returned no structured output' } }
        }
      }

      return { ...base, ok: true }
    })

    return { result, cancel: () => handle.cancel() }
  }
}
