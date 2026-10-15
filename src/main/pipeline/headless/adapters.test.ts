import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { HistoryEntry } from '../../pty/cliTools/types'
import { buildClaudeArgs, claudeHeadless } from './claudeHeadless'
import { buildCodexArgs, codexHeadless, MAX_PROMPT_CHARS, parseCodexDefaults, unwrapShellCommand } from './codexHeadless'
import type { HeadlessCapability, HeadlessRunOptions } from './types'

const FAKE_CLI = join(__dirname, '..', 'testing', 'fakeCli.cjs')

const runDirs: string[] = []
afterAll(() => { for (const dir of runDirs) rmSync(dir, { recursive: true, force: true }) })

function options(steps: unknown[], extra: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions {
  const runDir = mkdtempSync(join(tmpdir(), 'aide-headless-'))
  runDirs.push(runDir)
  return {
    cwd: __dirname,
    runDir,
    prompt: 'do the thing',
    permissions: 'write',
    env: { ...process.env, FAKE_CLI_SCRIPT: JSON.stringify(steps) },
    executable: { command: process.execPath, args: [FAKE_CLI] },
    label: 'test',
    ...extra
  }
}

async function run(adapter: HeadlessCapability, opts: HeadlessRunOptions): Promise<{ result: Awaited<ReturnType<HeadlessCapability['run']>['result']>; entries: HistoryEntry[]; sessionIds: string[] }> {
  const entries: HistoryEntry[] = []
  const sessionIds: string[] = []
  const result = await adapter.run({ ...opts, onEntry: (e) => entries.push(e), onSessionId: (id) => sessionIds.push(id) }).result
  return { result, entries, sessionIds }
}

const line = (value: unknown): { out: string } => ({ out: JSON.stringify(value) })

describe('claude headless adapter', () => {
  const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }

  it('builds new-session and resume arguments', () => {
    const fresh = buildClaudeArgs({ ...options([]), permissions: 'read-only', outputSchema: schema }, 'sid-1', '/tmp/append.md')
    expect(fresh).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'sid-1', '--append-system-prompt-file', '/tmp/append.md', '--json-schema', '--permission-mode', 'dontAsk']))
    expect(fresh).not.toContain('--resume')
    const resumed = buildClaudeArgs({ ...options([]), resumeSessionId: 'sid-9' }, 'ignored', null)
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 'sid-9', '--permission-mode', 'bypassPermissions']))
    expect(resumed).not.toContain('--session-id')
    expect(buildClaudeArgs({ ...options([]), effort: 'high' }, 'sid', null)).toEqual(expect.arrayContaining(['--effort', 'high']))
    expect(fresh).not.toContain('--effort')
  })

  it('streams entries and returns structured output', async () => {
    const { result, entries, sessionIds } = await run(claudeHeadless, options([
      line({ type: 'system', subtype: 'init', session_id: 'x' }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
      line({ type: 'result', subtype: 'success', is_error: false, result: '{"status":"done"}', structured_output: { status: 'done' }, total_cost_usd: 0.01, session_id: 'sess-abc' })
    ], { outputSchema: schema }))
    expect(result.ok).toBe(true)
    expect(result.structured).toEqual({ status: 'done' })
    expect(result.costUsd).toBe(0.01)
    expect(result.sessionId).toBe('sess-abc')
    expect(sessionIds).toHaveLength(1)
    expect(entries).toHaveLength(3)
    expect(entries[0].blocks[0]).toMatchObject({ type: 'tool_use', view: { kind: 'read', path: 'a.txt' } })
  })

  it('classifies an error result as a limit', async () => {
    const { result } = await run(claudeHeadless, options([
      line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude usage limit reached' }),
      { exit: 1 }
    ]))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('limit')
  })

  it('fails when a schema was requested but no structured output came back', async () => {
    const { result } = await run(claudeHeadless, options([
      line({ type: 'result', subtype: 'success', is_error: false, result: 'plain text' })
    ], { outputSchema: schema }))
    expect(result.error?.code).toBe('no_output')
  })

  it('fails without a result event', async () => {
    const { result } = await run(claudeHeadless, options([{ out: 'not json' }]))
    expect(result.error?.code).toBe('no_output')
  })
})

describe('codex headless adapter', () => {
  it('builds new-session and resume arguments', () => {
    const fresh = buildCodexArgs({ ...options([]), permissions: 'read-only' }, { schema: '/s.json', lastMessage: '/m.txt' })
    expect(fresh.slice(0, 2)).toEqual(['exec', '--json'])
    expect(fresh).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--output-schema', '/s.json', '-o', '/m.txt', '--cd']))
    expect(fresh[fresh.length - 1]).toBe('-')
    const resumed = buildCodexArgs({ ...options([]), resumeSessionId: 'thread-1' }, { schema: null, lastMessage: '/m.txt' })
    expect(resumed.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(resumed.slice(-2)).toEqual(['thread-1', '-'])
    expect(resumed).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(resumed).not.toContain('--cd')
  })

  it('passes model and effort explicitly, since --ignore-user-config drops the user\'s', () => {
    const files = { schema: null, lastMessage: '/m.txt' }
    const fromUser = buildCodexArgs(options([]), files, { model: 'gpt-x', effort: 'medium' })
    expect(fromUser).toEqual(expect.arrayContaining(['--model', 'gpt-x', '-c', "model_reasoning_effort='medium'"]))
    const fromStep = buildCodexArgs({ ...options([]), model: 'gpt-y', effort: 'high' }, files, { model: 'gpt-x', effort: 'medium' })
    expect(fromStep).toEqual(expect.arrayContaining(['--model', 'gpt-y', "model_reasoning_effort='high'"]))
    const bare = buildCodexArgs(options([]), files, {})
    expect(bare).not.toContain('--model')
    expect(bare.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false)
  })

  it('reads the top-level model settings of a Codex config', () => {
    const toml = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = \'medium\'\nmodel_reasoning_summary = "detailed"\n\n[profiles.fast]\nmodel_reasoning_effort = "low"\n'
    expect(parseCodexDefaults(toml)).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' })
    expect(parseCodexDefaults('[windows]\nsandbox = "elevated"\n')).toEqual({ model: undefined, effort: undefined })
  })

  it('adds the elevated Windows sandbox to read-only runs on Windows', () => {
    const readOnly = buildCodexArgs({ ...options([]), permissions: 'read-only' }, { schema: null, lastMessage: '/m.txt' })
    const write = buildCodexArgs({ ...options([]), permissions: 'write' }, { schema: null, lastMessage: '/m.txt' })
    expect(readOnly.includes("windows.sandbox='elevated'")).toBe(process.platform === 'win32')
    expect(write).not.toContain("windows.sandbox='elevated'")
  })

  it('unwraps PowerShell command wrappers for display', () => {
    expect(unwrapShellCommand(`"C:\\Apps\\pwsh.exe" -Command 'Get-Content -LiteralPath note.txt'`)).toBe('Get-Content -LiteralPath note.txt')
    expect(unwrapShellCommand(`"C:\\Apps\\pwsh.exe" -Command "Set-Content -Value 'x'"`)).toBe("Set-Content -Value 'x'")
    expect(unwrapShellCommand('git status')).toBe('git status')
  })

  it('maps events, picks up the thread id and parses the last message', async () => {
    const { result, entries, sessionIds } = await run(codexHeadless, options([
      line({ type: 'thread.started', thread_id: 'thread-42' }),
      line({ type: 'turn.started' }),
      line({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'ignoring unknown setting' } }),
      line({ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking...' } }),
      line({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'git status', aggregated_output: 'clean', exit_code: 0, status: 'completed' } }),
      line({ type: 'item.completed', item: { id: 'i3', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } }),
      line({ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: '{"decision":"approve"}' } }),
      { writeAfterFlag: '-o', content: '{"decision":"approve"}' },
      line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })
    ], { outputSchema: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { type: 'string' } } } }))
    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('thread-42')
    expect(sessionIds).toEqual(['thread-42'])
    expect(result.structured).toEqual({ decision: 'approve' })
    expect(result.warnings).toEqual(['ignoring unknown setting'])
    const kinds = entries.flatMap((e) => e.blocks.map((b) => b.type === 'tool_use' ? `tool:${b.view?.kind}` : b.type))
    expect(kinds).toEqual(['thinking', 'tool:shell', 'tool_result', 'tool:patch', 'tool_result', 'text'])
  })

  it('reports turn.failed as an error', async () => {
    const { result } = await run(codexHeadless, options([
      line({ type: 'thread.started', thread_id: 't' }),
      line({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }),
      { exit: 1 }
    ]))
    expect(result.error?.code).toBe('limit')
  })

  it('rejects prompts above the stdin limit without spawning', async () => {
    const { result } = await run(codexHeadless, options([], { prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }))
    expect(result.error?.code).toBe('prompt_too_large')
  })

  it('prepends role instructions to the prompt', async () => {
    const { result } = await run(codexHeadless, options([{ writeAfterFlag: '-o' }], { systemAppend: 'You are a reviewer.' }))
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('You are a reviewer.\n\n---\n\ndo the thing')
  })
})
