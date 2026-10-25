import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { HistoryEntry } from '../../pty/cliTools/types'
import { openCodePartBlocks } from '../../pty/cliTools/openCodeParts'
import { describeOpenCodeCredentials, effectiveOpenCodeCredentials, openCodeAccountHint } from '../../pty/cliTools/openCodeAuth'
import type { OpenCodeCredential } from '../../pty/cliTools/openCodeScanner'
import {
  buildOpenCodeArgs, buildOpenCodeConfigContent, openCodeHeadless, openCodeModel,
  readOpenCodeConfig, READ_ONLY_AGENT, retryLimitMessage
} from './openCodeHeadless'
import { parseFinalJson, promptWithRoleAndSchema } from './common'
import type { HeadlessRunOptions } from './types'

const FAKE_CLI = join(__dirname, '..', 'testing', 'fakeCli.cjs')

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aide-opencode-'))
  dirs.push(dir)
  return dir
}

function options(steps: unknown[], extra: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions {
  const home = tempDir()
  return {
    cwd: tempDir(),
    runDir: tempDir(),
    prompt: 'do the thing',
    permissions: 'write',
    // An empty config home keeps the user's real OpenCode config out of the tests.
    env: { ...process.env, XDG_CONFIG_HOME: home, FAKE_CLI_SCRIPT: JSON.stringify(steps) },
    executable: { command: process.execPath, args: [FAKE_CLI] },
    label: 'test',
    ...extra
  }
}

const line = (value: unknown): { out: string } => ({ out: JSON.stringify(value) })
const SID = 'ses_test'

// Event shapes recorded from opencode 2.1.4 `run --format json`.
const toolEvent = (id: string, tool: string, input: unknown, output: string): unknown => ({
  type: 'tool_use', sessionID: SID,
  part: { type: 'tool', id, tool, messageID: 'msg_1', state: { status: 'completed', input, output } }
})
const textEvent = (messageID: string, text: string): unknown => ({ type: 'text', sessionID: SID, part: { type: 'text', messageID, text } })
const stepFinish = (cost: number): unknown => ({ type: 'step_finish', sessionID: SID, part: { type: 'step-finish', reason: 'tool-calls', cost } })

describe('opencode parts', () => {
  it('maps streamed and stored tool parts the same way', () => {
    const streamed = openCodePartBlocks({ type: 'tool', id: 'c1', tool: 'shell', state: { status: 'completed', input: { command: 'git status' }, output: 'clean' } })
    const stored = openCodePartBlocks({ type: 'tool', id: 'c1', name: 'shell', state: { status: 'completed', input: { command: 'git status' }, content: [{ type: 'text', text: 'clean' }] } })
    expect(stored).toEqual(streamed)
    expect(streamed).toEqual([
      { type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'git status' }, view: { kind: 'shell', command: 'git status' } },
      { type: 'tool_result', tool_use_id: 'c1', content: 'clean' }
    ])
  })

  it('shows a rejected call with its error and skips a running one', () => {
    const rejected = openCodePartBlocks({ type: 'tool', id: 'c2', name: 'shell', state: { status: 'error', input: { command: 'rm x' }, error: { type: 'permission.rejected', message: 'Permission denied: shell' } } })
    expect(rejected[1]).toEqual({ type: 'tool_result', tool_use_id: 'c2', content: 'Permission denied: shell' })
    expect(openCodePartBlocks({ type: 'tool', id: 'c3', name: 'read', state: { status: 'running', input: { path: 'a' } } })).toEqual([])
  })

  it('maps file tools of old and current sessions', () => {
    expect(openCodePartBlocks({ type: 'tool', id: 'r', name: 'read', state: { status: 'completed', input: { path: 'a.ts', offset: 10, limit: 5 }, content: [] } })[0])
      .toMatchObject({ view: { kind: 'read', path: 'a.ts', range: 'lines 10–14' } })
    expect(openCodePartBlocks({ type: 'tool', id: 'e', name: 'edit', state: { status: 'completed', input: { filePath: 'b.ts', oldString: 'x', newString: 'y' }, content: [] } })[0])
      .toMatchObject({ view: { kind: 'edit', path: 'b.ts', edits: [{ oldText: 'x', newText: 'y' }] } })
    expect(openCodePartBlocks({ type: 'reasoning', text: 'hmm' })).toEqual([{ type: 'thinking', thinking: 'hmm' }])
    expect(openCodePartBlocks({ type: 'step-start' })).toEqual([])
  })
})

describe('opencode headless adapter', () => {
  it('builds arguments for new, resumed and read-only runs', () => {
    const fresh = buildOpenCodeArgs(options([]), 'deepseek/flash#high')
    expect(fresh).toEqual(['run', '--standalone', '--format', 'json', '--thinking', '--auto', '--model', 'deepseek/flash#high'])
    const readOnly = buildOpenCodeArgs({ ...options([]), permissions: 'read-only', resumeSessionId: 'ses_1' }, undefined)
    expect(readOnly).toEqual(expect.arrayContaining(['--agent', READ_ONLY_AGENT, '--session', 'ses_1']))
    expect(readOnly).not.toContain('--model')
  })

  it('passes effort as the model variant', () => {
    expect(openCodeModel('a/b', 'high', 'c/d')).toBe('a/b#high')
    expect(openCodeModel(undefined, 'high', 'c/d')).toBe('c/d#high')
    expect(openCodeModel('a/b#max', 'high', undefined)).toBe('a/b#max')
    expect(openCodeModel(undefined, undefined, 'c/d')).toBeUndefined()
    expect(openCodeModel(undefined, 'high', undefined)).toBeUndefined()
  })

  it('reads the default model and every MCP server from user and project configs', () => {
    const home = tempDir()
    const project = tempDir()
    mkdirSync(join(home, 'opencode'))
    writeFileSync(join(home, 'opencode', 'opencode.json'), JSON.stringify({ model: 'user/model', mcp: { search: { type: 'local', command: ['x'] } } }))
    writeFileSync(join(project, 'opencode.jsonc'), '{\n  // project\n  "model": "project/model",\n  "mcp": { "aide": { "type": "local", "command": ["y"] }, },\n}\n')
    expect(readOpenCodeConfig(project, { XDG_CONFIG_HOME: home })).toEqual({ model: 'project/model', mcpServers: ['search', 'aide'] })
  })

  it('switches every MCP server off with a complete entry and defines the read-only agent', () => {
    const config = JSON.parse(buildOpenCodeConfigContent(['aide']))
    expect(config.mcp).toEqual({ aide: { type: 'local', command: ['node'], enabled: false } })
    expect(config.agent[READ_ONLY_AGENT].permission).toMatchObject({ edit: 'deny', bash: { '*': 'deny', 'git diff*': 'allow' } })
  })

  it('prepends role instructions and appends the output schema', () => {
    const prompt = promptWithRoleAndSchema({ ...options([]), systemAppend: 'You are a reviewer.', outputSchema: { type: 'object' } })
    expect(prompt.startsWith('You are a reviewer.\n\n---\n\ndo the thing\n\n---\n\nEnd your turn')).toBe(true)
    expect(prompt).toContain('"type": "object"')
  })

  it('parses a final JSON answer with or without a fence', () => {
    expect(parseFinalJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseFinalJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseFinalJson('Here it is: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } })
    expect(() => parseFinalJson('no json')).toThrow()
  })

  it('streams entries, takes the session id and parses the last message', async () => {
    const entries: HistoryEntry[] = []
    const sessionIds: string[] = []
    const result = await openCodeHeadless.run({
      ...options([
        line({ type: 'step_start', sessionID: SID, part: { type: 'step-start' } }),
        line(textEvent('msg_1', 'Let me look.')),
        line(toolEvent('c1', 'read', { path: 'a.txt' }, 'hello')),
        line(stepFinish(0.002)),
        line(textEvent('msg_2', '{"status":')),
        line(textEvent('msg_2', '"done"}'))
      ], { outputSchema: { type: 'object' } }),
      onEntry: (e) => entries.push(e),
      onSessionId: (id) => sessionIds.push(id)
    }).result
    expect(result.error).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe(SID)
    expect(sessionIds).toEqual([SID])
    expect(result.structured).toEqual({ status: 'done' })
    expect(result.costUsd).toBe(0.002)
    expect(entries.flatMap((e) => e.blocks.map((b) => b.type === 'tool_use' ? `tool:${b.view?.kind}` : b.type)))
      .toEqual(['text', 'tool:read', 'tool_result', 'text', 'text'])
  })

  it('reports an error event', async () => {
    const result = await openCodeHeadless.run(options([
      line({ type: 'error', sessionID: SID, error: { type: 'provider.no-route', message: 'Model unavailable: nosuch/model' } }),
      { exit: 1 }
    ])).result
    expect(result.ok).toBe(false)
    expect(result.error).toEqual({ code: 'failed', message: 'Model unavailable: nosuch/model' })
  })

  it('reports a provider quota or rate-limit error as a usage limit', async () => {
    const result = await openCodeHeadless.run(options([
      line({ type: 'error', sessionID: SID, error: { type: 'provider.quota', message: 'Insufficient Balance', status: 402 } }),
      { exit: 1 }
    ])).result
    expect(result.error).toEqual({ code: 'limit', message: 'Insufficient Balance' })
  })

  it('words a long retry so the engine reads when to try again', () => {
    expect(retryLimitMessage({ attempt: 4, errorType: 'provider.rate-limit', message: 'Rate limit reached', retryAfterMs: 20_000 }))
      .toBe('Rate limit reached (OpenCode retried 4 times; try again in 1 minute)')
    expect(retryLimitMessage({ attempt: 3, errorType: 'provider.rate-limit', message: '', retryAfterMs: 150_000 }))
      .toBe('provider.rate-limit (OpenCode retried 3 times; try again in 3 minutes)')
  })

  it('fails without a final message, and on a non-JSON answer when a schema was asked', async () => {
    expect((await openCodeHeadless.run(options([line(stepFinish(0))])).result).error?.code).toBe('no_output')
    expect((await openCodeHeadless.run(options([line(textEvent('m', 'plain'))], { outputSchema: { type: 'object' } })).result).error?.code).toBe('no_output')
  })
})

describe('opencode accounts', () => {
  const cred = (id: string, integrationID: string, active: boolean | null): OpenCodeCredential =>
    ({ id, integrationID, label: id, active, value: { type: 'key', key: `sk-${id}-0000` } })

  it('counts a credential without an active flag while its provider has no active one', () => {
    const all = [cred('legacy', 'local_qwen', null), cred('a', 'deepseek', false), cred('b', 'deepseek', true), cred('old', 'deepseek', null)]
    expect(effectiveOpenCodeCredentials(all).map((c) => c.id)).toEqual(['legacy', 'b'])
  })

  it('leaves out credentials of providers OpenCode does not know (it never sends them, logout refuses them)', () => {
    const all = [cred('orphan', 'local_qwen', null), cred('b', 'deepseek', true)]
    expect(effectiveOpenCodeCredentials(all, new Set(['deepseek', 'opencode'])).map((c) => c.id)).toEqual(['b'])
  })

  it('tells accounts apart by the end of an API key or the email of an OAuth login', () => {
    const oauth: OpenCodeCredential = { id: 'z', integrationID: 'opencode', label: 'Personal', active: true, value: { type: 'oauth', access: 'a', refresh: 'r', metadata: { email: 'me@example.com' } } }
    expect(describeOpenCodeCredentials([cred('k', 'deepseek', true), oauth])).toBe('deepseek: k …0000, opencode: Personal (me@example.com)')
  })

  it('explains why there is nothing to save and what to do', () => {
    expect(openCodeAccountHint([], ['deepseek'])).toContain('the key of deepseek in opencode.json is not a stored credential')
    expect(openCodeAccountHint([], [])).toContain('Free models need none.')
    expect(openCodeAccountHint([cred('legacy', 'local_qwen', null)], ['deepseek'])).toContain('not part of a saved account')
    expect(openCodeAccountHint([cred('b', 'deepseek', true)], ['deepseek'])).toBeNull()
  })
})
