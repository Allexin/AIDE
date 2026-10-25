import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { HistoryEntry } from '../../pty/cliTools/types'
import { buildCursorArgs, buildCursorConfig, cursorHeadless, latestCursorVersion, prepareCursorHome } from './cursorHeadless'
import { buildDevinArgs, buildDevinConfig, devinHeadless, readDevinExport } from './devinHeadless'
import type { HeadlessRunOptions } from './types'

const FAKE_CLI = join(__dirname, '..', 'testing', 'fakeCli.cjs')

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aide-cursor-devin-'))
  dirs.push(dir)
  return dir
}

function options(steps: unknown[], extra: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions {
  const home = tempDir()
  return {
    cwd: tempDir(),
    runDir: tempDir(),
    stateDir: tempDir(),
    prompt: 'do the thing',
    permissions: 'write',
    // Empty config homes keep the user's real Cursor and Devin configs out of the tests.
    env: { ...process.env, CURSOR_CONFIG_DIR: home, APPDATA: home, XDG_CONFIG_HOME: home, FAKE_CLI_SCRIPT: JSON.stringify(steps) },
    executable: { command: process.execPath, args: [FAKE_CLI] },
    label: 'test',
    ...extra
  }
}

const line = (value: unknown): { out: string } => ({ out: JSON.stringify(value) })
const kinds = (entries: HistoryEntry[]): string[] => entries.flatMap((e) => e.blocks.map((b) => b.type === 'tool_use' ? `tool:${b.view?.kind}` : b.type))

describe('cursor headless adapter', () => {
  const SID = 'chat-1'
  // Event shapes recorded from Cursor Agent 2026.09.26 `--print --output-format stream-json`.
  const toolDone = (callId: string, kind: string, args: unknown, result: unknown): unknown =>
    ({ type: 'tool_call', subtype: 'completed', call_id: callId, tool_call: { [kind]: { args, result } }, session_id: SID })

  it('picks the newest version directory as the launcher does', () => {
    const root = tempDir()
    for (const name of ['2026.09.23-86fc751', '2026.09.26-dd393fe', '2026.06.15-18-00-12-6f5a2cf', 'dist-package']) {
      mkdirSync(join(root, 'versions', name), { recursive: true })
      writeFileSync(join(root, 'versions', name, 'node.exe'), '')
      writeFileSync(join(root, 'versions', name, 'index.js'), '')
    }
    expect(latestCursorVersion(root)?.args[0]).toBe(join(root, 'versions', '2026.09.26-dd393fe', 'index.js'))
  })

  it('builds arguments per permission profile', () => {
    const write = buildCursorArgs({ ...options([]), model: 'grok-4.7-high', resumeSessionId: SID })
    expect(write).toEqual(expect.arrayContaining(['--print', '--output-format', 'stream-json', '--trust', '--force', '--sandbox', 'disabled', '--model', 'grok-4.7-high', '--resume', SID]))
    const readOnly = buildCursorArgs({ ...options([]), permissions: 'read-only' })
    expect(readOnly).not.toContain('--force')
    expect(readOnly).not.toContain('--resume')
  })

  it('writes profile configs with the user model and a shared chats junction', () => {
    const opts = options([])
    writeFileSync(join(opts.env.CURSOR_CONFIG_DIR as string, 'cli-config.json'), JSON.stringify({ model: { modelId: 'grok-4.7' }, permissions: { allow: ['Shell(*)'], deny: [] }, display: { mode: 'zen' } }))
    const home = prepareCursorHome(opts.stateDir as string, 'read-only', opts.env)
    const config = JSON.parse(readFileSync(join(home, 'cli-config.json'), 'utf8'))
    expect(config.model).toEqual({ modelId: 'grok-4.7' })
    expect(config.display).toBeUndefined() // only the model is taken from the user's config
    expect(config.permissions.deny).toEqual(['Write(**)'])
    expect(config.permissions.allow).toContain('Shell(git diff)')
    expect(lstatSync(join(home, 'chats')).isSymbolicLink()).toBe(true)
    expect(prepareCursorHome(opts.stateDir as string, 'write', opts.env)).not.toBe(home)
    expect(existsSync(join(opts.stateDir as string, 'chats'))).toBe(true)
  })

  it('keeps what Cursor stores in its config and replaces the permissions', () => {
    const config = buildCursorConfig({ authInfo: { email: 'x' }, permissions: { allow: [], deny: [] }, model: { modelId: 'old' } }, {}, 'read-only')
    expect(config.authInfo).toEqual({ email: 'x' })
    expect(config.model).toBeUndefined()
    expect((config.permissions as { deny: string[] }).deny).toEqual(['Write(**)'])
  })

  it('streams entries, takes the session id and parses the text after the last tool call', async () => {
    const entries: HistoryEntry[] = []
    const sessionIds: string[] = []
    const result = await cursorHeadless.run({
      ...options([
        line({ type: 'system', subtype: 'init', session_id: SID, model: 'Grok' }),
        line({ type: 'thinking', subtype: 'delta', text: 'I will read', session_id: SID }),
        line({ type: 'thinking', subtype: 'completed', session_id: SID }),
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look.' }] }, session_id: SID }),
        line(toolDone('c1', 'readToolCall', { path: 'a.txt' }, { success: { content: 'hello' } })),
        line(toolDone('c2', 'shellToolCall', { command: 'rm x' }, { rejected: { command: 'rm x', reason: '' } })),
        line({ type: 'assistant', message: { content: [{ type: 'text', text: '{"status":"done"}' }] }, session_id: SID }),
        line({ type: 'result', subtype: 'success', is_error: false, result: 'Let me look.{"status":"done"}', session_id: SID })
      ], { outputSchema: { type: 'object' } }),
      onEntry: (e) => entries.push(e),
      onSessionId: (id) => sessionIds.push(id)
    }).result
    expect(result.error).toBeNull()
    expect(result.sessionId).toBe(SID)
    expect(sessionIds).toEqual([SID])
    expect(result.structured).toEqual({ status: 'done' })
    expect(kinds(entries)).toEqual(['thinking', 'text', 'tool:read', 'tool_result', 'tool:shell', 'tool_result', 'text'])
    const rejected = entries[3].blocks[1]
    expect(rejected).toMatchObject({ type: 'tool_result', content: 'rejected' })
  })

  it('reports an error result and a failed start', async () => {
    const failed = await cursorHeadless.run(options([line({ type: 'result', subtype: 'error', is_error: true, result: 'You have hit your usage limit' })])).result
    expect(failed.error?.code).toBe('limit')
    const badModel = await cursorHeadless.run(options([{ err: 'Cannot use this model: nosuch' }, { exit: 1 }])).result
    expect(badModel.error?.code).toBe('failed')
    expect(badModel.error?.message).toContain('Cannot use this model')
  })

  it('needs a state directory', async () => {
    const result = await cursorHeadless.run({ ...options([]), stateDir: undefined }).result
    expect(result.error?.code).toBe('spawn_failed')
  })
})

describe('devin headless adapter', () => {
  // ATIF shapes recorded from Devin 3000.11.92 `--export`.
  const atif = (steps: unknown[]): string => JSON.stringify({ schema_version: 'ATIF-v1.7', session_id: 'happy-otter', steps })
  const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

  it('builds arguments per permission profile', () => {
    const files = { prompt: '/p.md', config: '/c.json', export: '/e.json' }
    const readOnly = buildDevinArgs({ ...options([]), permissions: 'read-only', resumeSessionId: 'happy-otter' }, files)
    expect(readOnly).toEqual(expect.arrayContaining(['-p', '--prompt-file', '/p.md', '--config', '/c.json', '--respect-workspace-trust', 'false', '--permission-mode', 'auto', '--export', '/e.json', '--resume', 'happy-otter']))
    expect(buildDevinArgs(options([]), files)).toEqual(expect.arrayContaining(['--permission-mode', 'dangerous']))
  })

  it('drops MCP servers and the configs Devin imports from other CLIs', () => {
    expect(buildDevinConfig({ version: 1, devin: { org_id: 'o' }, mcpServers: { x: {} } }))
      .toEqual({ version: 1, devin: { org_id: 'o' }, mcpServers: {}, read_config_from: { claude: false, cursor: false } })
  })

  it('maps the steps of this run from an export', () => {
    const text = atif([
      { step_id: 1, timestamp: at(-60_000), source: 'user', message: 'earlier turn' },
      { step_id: 2, timestamp: at(-1000), source: 'system', message: 'You are Devin' },
      { step_id: 3, timestamp: at(-500), source: 'user', message: 'read it' },
      {
        step_id: 4, timestamp: at(0), source: 'agent', message: '', reasoning_content: 'thinking',
        tool_calls: JSON.stringify([{ tool_call_id: 'r1', function_name: 'read', arguments: { file_path: 'a.txt' } }]),
        observation: JSON.stringify({ results: [{ source_call_id: 'r1', content: 'hello' }] })
      },
      { step_id: 5, timestamp: at(10), source: 'agent', message: 'done', tool_calls: [] }
    ])
    const exported = readDevinExport(text, Date.now() - 5000)
    expect(exported.sessionId).toBe('happy-otter')
    expect(kinds(exported.entries)).toEqual(['text', 'thinking', 'tool:read', 'tool_result', 'text'])
    expect(exported.entries[0]).toEqual({ role: 'user', blocks: [{ type: 'text', text: 'read it' }] })
  })

  it('takes the answer from stdout and the session from the export', async () => {
    const opts = options([], { outputSchema: { type: 'object' } })
    const exportText = atif([{ step_id: 1, timestamp: at(1000), source: 'agent', message: '{"status":"done"}' }])
    opts.env.FAKE_CLI_SCRIPT = JSON.stringify([{ writeAfterFlag: '--export', content: exportText }, { out: '{"status":"done"}' }])
    const entries: HistoryEntry[] = []
    const result = await devinHeadless.run({ ...opts, onEntry: (e) => entries.push(e) }).result
    expect(result.error).toBeNull()
    expect(result.sessionId).toBe('happy-otter')
    expect(result.structured).toEqual({ status: 'done' })
    expect(entries).toHaveLength(1)
    expect(readFileSync(join(opts.runDir, 'devin-prompt.md'), 'utf8')).toContain('do the thing')
  })

  it('reports a failed run with its stderr', async () => {
    const result = await devinHeadless.run(options([{ err: "Error: Unknown model: 'nosuch'" }, { exit: 1 }])).result
    expect(result.error?.code).toBe('failed')
    expect(result.error?.message).toContain('Unknown model')
  })
})
