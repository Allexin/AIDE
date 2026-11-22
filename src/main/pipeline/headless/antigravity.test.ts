import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { HistoryEntry } from '../../pty/cliTools/types'
import { antigravityHeadless, buildAntigravityArgs, buildAntigravitySettings } from './antigravityHeadless'
import type { HeadlessRunOptions } from './types'

const FAKE_CLI = join(__dirname, '..', 'testing', 'fakeCli.cjs')

const runDirs: string[] = []
afterAll(() => { for (const dir of runDirs) rmSync(dir, { recursive: true, force: true }) })

function makeOptions(steps: unknown[], extra: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions {
  const runDir = mkdtempSync(join(tmpdir(), 'aide-agy-headless-'))
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

const line = (value: unknown): { out: string } => ({ out: JSON.stringify(value) })

describe('antigravity headless adapter', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string' } } }

  it('builds read-only and write settings and CLI args', () => {
    const ro = buildAntigravitySettings('read-only')
    expect(ro).toMatchObject({
      agentMode: '',
      toolPermission: 'request-review',
      enableTerminalSandbox: false,
      permissions: {
        allow: expect.arrayContaining(['read_file(*)', 'command(git status)', 'command(git diff)']),
        deny: expect.arrayContaining(['write_file(*)', 'mcp(*)'])
      }
    })
    expect(buildAntigravitySettings('write')).toEqual({ permissions: { deny: ['mcp(*)'] } })

    const roArgs = buildAntigravityArgs(
      { ...makeOptions([]), permissions: 'read-only', model: 'gemini-4-neon-high', effort: 'high' },
      { settings: '/tmp/s.json', schema: '/tmp/schema.json' }
    )
    expect(roArgs).toEqual(expect.arrayContaining([
      '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--disable-slash-commands', '--add-dir', '--settings', '/tmp/s.json',
      '--model', 'gemini-4-neon-high', '--effort', 'high', '--json-schema', '/tmp/schema.json'
    ]))
    expect(roArgs).not.toContain('--dangerously-skip-permissions')
    expect(roArgs).not.toContain('--conversation')

    const wrArgs = buildAntigravityArgs(
      { ...makeOptions([]), permissions: 'write', resumeSessionId: 'conv-9' },
      { settings: '/tmp/s.json', schema: null }
    )
    expect(wrArgs).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--conversation', 'conv-9']))
    expect(wrArgs).not.toContain('--json-schema')
  })

  it('streams tool steps, buffers text deltas, and returns structured output', async () => {
    const entries: HistoryEntry[] = []
    const sessionIds: string[] = []
    const opts = makeOptions([
      line({ event: 'init', conversation_id: 'conv-42', init: { cwd: __dirname } }),
      line({ event: 'step_update', step_update: { conversation_id: 'conv-42', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'a.txt' } } } }),
      line({ event: 'step_update', step_update: { conversation_id: 'conv-42', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'a.txt' }, output: 'ok' } } }),
      line({ event: 'step_update', step_update: { conversation_id: 'conv-42', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Part 1 ' } }),
      line({ event: 'step_update', step_update: { conversation_id: 'conv-42', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Part 2' } }),
      line({ event: 'result', result: { conversation_id: 'conv-42', status: 'SUCCESS', response: '{"status":"done"}', structured_output: { status: 'done' } } })
    ], { outputSchema: schema, onEntry: (e) => entries.push(e), onSessionId: (id) => sessionIds.push(id) })

    const result = await antigravityHeadless.run(opts).result
    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe('conv-42')
    expect(sessionIds).toEqual(['conv-42'])
    expect(result.structured).toEqual({ status: 'done' })
    expect(entries).toHaveLength(2)
    expect(entries[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'read_file', view: { kind: 'read', path: 'a.txt' } })
    expect(entries[0].blocks[1]).toMatchObject({ type: 'tool_result', content: 'ok' })
    expect(entries[1].blocks[0]).toEqual({ type: 'text', text: 'Part 1 Part 2' })
    expect(JSON.parse(readFileSync(join(opts.runDir, 'antigravity-schema.json'), 'utf8'))).toEqual(schema)
  })

  it('ignores stale structured_output on resumed turns when no outputSchema is requested', async () => {
    const opts = makeOptions([
      line({ event: 'result', result: { conversation_id: 'conv-42', status: 'SUCCESS', response: 'Done.', structured_output: { stale: true } } })
    ], { resumeSessionId: 'conv-42' })
    const result = await antigravityHeadless.run(opts).result
    expect(result.ok).toBe(true)
    expect(result.structured).toBeNull()
    expect(result.finalText).toBe('Done.')
  })

  it('classifies quota and service errors from ERROR result events', async () => {
    const limitRes = await antigravityHeadless.run(makeOptions([
      line({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'Quota exceeded, try again later' } }),
      { exit: 1 }
    ])).result
    expect(limitRes.ok).toBe(false)
    expect(limitRes.error?.code).toBe('limit')

    const missingRes = await antigravityHeadless.run(makeOptions([{ out: 'not json' }])).result
    expect(missingRes.error?.code).toBe('no_output')
  })
})
