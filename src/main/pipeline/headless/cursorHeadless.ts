import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'fs'
import { delimiter, join } from 'path'
import { homedir } from 'os'
import { runProcess } from '../processRunner'
import { classifyFailure, failedRun, parseFinalJson, parseJsonLine, processError, promptWithRoleAndSchema, resolveExecutable } from './common'
import { cursorToolView } from '../../pty/cliTools/toolViews'
import type { HistoryBlock } from '../../pty/cliTools/types'
import type { HeadlessCapability, HeadlessResult, HeadlessRunOptions, HeadlessRun, PermissionProfile } from './types'

/**
 * Cursor Agent headless adapter (`agent --print --output-format stream-json`).
 * Verified against Cursor Agent 2026.09.26; see docs/headless-cli-matrix.md.
 *
 * - Each permission profile runs with its own CURSOR_CONFIG_DIR under the
 *   adapter's state directory, whose cli-config.json carries the profile's
 *   permission rules and the user's default model. Their `chats` directories
 *   are junctions to one shared directory, so a step can continue a session of
 *   a step with the other profile. The user's ~/.cursor (MCP servers, rules,
 *   skills) stays out of pipeline steps.
 * - read-only: no --force; Read is allowed, Write is denied, and the shell only
 *   runs `git status/diff/log/show` — any other command (or a chain) is
 *   rejected, since print mode cannot ask. write: --force --sandbox disabled.
 * - The prompt goes on stdin; role instructions are prepended and the output
 *   schema is appended as an instruction — Cursor has no structured output.
 * - The session id is `session_id` of the `system/init` event; resume is
 *   `--resume <id>`. Effort is part of Cursor's model ids (`grok-4.7-high`).
 */

const READ_ONLY_PERMISSIONS = {
  allow: ['Read(**)', 'Shell(git status)', 'Shell(git diff)', 'Shell(git log)', 'Shell(git show)'],
  deny: ['Write(**)']
}
const WRITE_PERMISSIONS = { allow: [], deny: [] }

/** Fields of the user's cli-config.json that select the default model. */
const MODEL_FIELDS = ['model', 'selectedModel', 'modelParameters', 'hasChangedDefaultModel', 'maxMode']

// ── Executable ────────────────────────────────────────────────────────────────

const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/

/** Sort key of a version directory name: date, then the optional build time. */
function versionKey(name: string): string | null {
  const m = VERSION_DIR.exec(name)
  if (!m) return null
  const pad = (v: string | undefined): string => (v ?? '00').padStart(2, '0')
  return `${m[1]}${pad(m[2])}${pad(m[3])}${pad(m[4])}${pad(m[5])}${pad(m[6])}`
}

/** node.exe + index.js of the newest installed version under an install root, as cursor-agent.ps1 picks it. */
export function latestCursorVersion(root: string): { command: string; args: string[] } | null {
  if (existsSync(join(root, 'node.exe')) && existsSync(join(root, 'index.js'))) {
    return { command: join(root, 'node.exe'), args: [join(root, 'index.js')] }
  }
  let names: string[] = []
  try { names = readdirSync(join(root, 'versions')) } catch { return null }
  const versions = names.map((name) => ({ name, key: versionKey(name) })).filter((v): v is { name: string; key: string } => v.key !== null)
  versions.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  for (const { name } of versions) {
    const dir = join(root, 'versions', name)
    if (existsSync(join(dir, 'node.exe')) && existsSync(join(dir, 'index.js'))) return { command: join(dir, 'node.exe'), args: [join(dir, 'index.js')] }
  }
  return null
}

/**
 * The Cursor Agent entry point. On Windows only `.cmd`/`.ps1` launchers are on
 * PATH; they run the newest version's bundled node with its index.js, which is
 * what is spawned here.
 */
export function resolveCursorExecutable(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  if (process.platform !== 'win32') {
    const direct = resolveExecutable('cursor-agent', env) ?? resolveExecutable('agent', env)
    return direct ? { command: direct, args: [] } : null
  }
  const roots = (env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir && existsSync(join(dir, 'cursor-agent.ps1')))
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'cursor-agent'))
  for (const root of roots) {
    const found = latestCursorVersion(root)
    if (found) return found
  }
  return null
}

// ── Config homes ──────────────────────────────────────────────────────────────

/** The user's own Cursor config directory, resolved the way Cursor does. */
function userConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR
  if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME, 'cursor')
  return join(homedir(), '.cursor')
}

function readJson(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** cli-config.json for a profile: what Cursor keeps there itself, the user's model, the profile's permissions. */
export function buildCursorConfig(existing: Record<string, unknown>, user: Record<string, unknown>, permissions: PermissionProfile): Record<string, unknown> {
  const config: Record<string, unknown> = { ...existing, version: 1 }
  for (const field of MODEL_FIELDS) {
    if (user[field] !== undefined) config[field] = user[field]
    else delete config[field]
  }
  config.permissions = permissions === 'read-only' ? READ_ONLY_PERMISSIONS : WRITE_PERMISSIONS
  return config
}

/** Prepare <stateDir>/<profile> with its config and the shared chats junction; returns the config dir. */
export function prepareCursorHome(stateDir: string, permissions: PermissionProfile, env: NodeJS.ProcessEnv): string {
  const chats = join(stateDir, 'chats')
  const home = join(stateDir, permissions)
  mkdirSync(chats, { recursive: true })
  mkdirSync(home, { recursive: true })
  const link = join(home, 'chats')
  if (!existsSync(link)) symlinkSync(chats, link, 'junction')
  const configPath = join(home, 'cli-config.json')
  const config = buildCursorConfig(readJson(configPath), readJson(join(userConfigDir(env), 'cli-config.json')), permissions)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  return home
}

// ── Invocation ────────────────────────────────────────────────────────────────

export function buildCursorArgs(options: HeadlessRunOptions): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--trust', '--workspace', options.cwd]
  if (options.permissions === 'write') args.push('--force', '--sandbox', 'disabled')
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

/** Text of a finished tool call's result (`success`, `failure`, `rejected`, `permissionDenied`, …). */
function toolResultText(result: Record<string, unknown>): string {
  const [outcome] = Object.keys(result)
  if (!outcome) return ''
  const value = obj(result[outcome])
  if (outcome === 'success') {
    if (typeof value.content === 'string') return value.content
    if (typeof value.stdout === 'string' || typeof value.stderr === 'string') return [str(value.stdout), str(value.stderr)].filter(Boolean).join('\n')
    if (typeof value.diffString === 'string') return value.diffString
    if (Array.isArray(value.files)) return value.files.map(String).join('\n')
    return JSON.stringify(value)
  }
  if (outcome === 'failure') {
    const output = [str(value.stdout), str(value.stderr)].filter(Boolean).join('\n')
    return typeof value.exitCode === 'number' ? `${output}\n(exit code ${value.exitCode})` : output || JSON.stringify(value)
  }
  return `${outcome}${str(value.error) || str(value.reason) ? `: ${str(value.error) || str(value.reason)}` : ''}`
}

/** Transcript blocks of a completed `tool_call` event. */
export function cursorToolBlocks(event: Record<string, unknown>): HistoryBlock[] {
  const call = obj(event.tool_call)
  const kind = Object.keys(call).find((key) => key.endsWith('ToolCall'))
  if (!kind) return []
  const body = obj(call[kind])
  const id = str(event.call_id) || str(call.toolCallId)
  const name = kind.replace(/ToolCall$/, '')
  return [
    { type: 'tool_use', id, name, input: body.args ?? {}, view: cursorToolView(kind, body.args) },
    { type: 'tool_result', tool_use_id: id, content: toolResultText(obj(body.result)) }
  ]
}

export const cursorHeadless: HeadlessCapability = {
  run(options: HeadlessRunOptions): HeadlessRun {
    const executable = options.executable ?? resolveCursorExecutable(options.env)
    if (!executable) return failedRun('not_installed', 'Cursor Agent executable was not found')
    if (!options.stateDir) return failedRun('spawn_failed', 'Cursor Agent needs a state directory for its config home')

    let configDir: string
    try {
      configDir = prepareCursorHome(options.stateDir, options.permissions, options.env)
    } catch (err) {
      return failedRun('spawn_failed', `Cursor Agent config home could not be prepared: ${err instanceof Error ? err.message : String(err)}`)
    }

    let sessionId: string | null = options.resumeSessionId ?? null
    if (sessionId) options.onSessionId?.(sessionId)
    let finalText = ''
    let thinking = ''
    let resultEvent: Record<string, unknown> | null = null

    const handle = runProcess({
      command: executable.command,
      args: [...(executable.args ?? []), ...buildCursorArgs(options)],
      cwd: options.cwd,
      env: { ...options.env, CURSOR_CONFIG_DIR: configDir, PWD: options.cwd },
      stdin: promptWithRoleAndSchema(options),
      timeoutMs: options.timeoutMs,
      label: options.label,
      onStdoutLine: (line) => {
        const event = parseJsonLine(line)
        if (!event) return
        if (typeof event.session_id === 'string' && event.session_id !== sessionId) {
          sessionId = event.session_id
          options.onSessionId?.(sessionId)
        }
        if (event.type === 'thinking') {
          if (event.subtype === 'delta') thinking += str(event.text)
          else if (event.subtype === 'completed' && thinking.trim()) {
            options.onEntry?.({ role: 'assistant', blocks: [{ type: 'thinking', thinking }] })
            thinking = ''
          }
        } else if (event.type === 'assistant') {
          const content = obj(event.message).content
          const text = Array.isArray(content) ? content.map((part) => str(obj(part).text)).join('') : ''
          if (text) {
            finalText += text
            options.onEntry?.({ role: 'assistant', blocks: [{ type: 'text', text }] })
          }
        } else if (event.type === 'tool_call') {
          // The final answer is the text after the last tool call.
          finalText = ''
          if (event.subtype === 'completed') {
            const blocks = cursorToolBlocks(event)
            if (blocks.length > 0) options.onEntry?.({ role: 'assistant', blocks })
          }
        } else if (event.type === 'result') {
          resultEvent = event
        }
      }
    })

    const result = handle.done.then((exit): HeadlessResult => {
      const base: HeadlessResult = { ok: false, sessionId, structured: null, finalText: finalText || null, costUsd: null, warnings: [], error: null }
      const exitError = processError(exit, 'Cursor Agent')
      if (exitError && exitError.code !== 'failed' && exitError.code !== 'limit') return { ...base, error: exitError }
      const final = resultEvent as Record<string, unknown> | null
      if (final?.is_error === true) {
        const message = str(final.result) || str(final.subtype) || 'Cursor Agent reported an error'
        return { ...base, error: { code: classifyFailure(message), message } }
      }
      if (exitError) return { ...base, error: exitError }
      if (!finalText) return { ...base, error: { code: 'no_output', message: 'Cursor Agent returned no final message' } }
      if (options.outputSchema) {
        try {
          base.structured = parseFinalJson(finalText)
        } catch {
          return { ...base, error: { code: 'no_output', message: 'Cursor Agent final message is not valid JSON' } }
        }
      }
      return { ...base, ok: true }
    })

    return { result, cancel: () => handle.cancel() }
  }
}
