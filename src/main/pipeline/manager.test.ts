import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { PipelineManager, type ManagerEnvironment } from './manager'
import { McpServer } from './mcp/protocol'
import { buildPipelineTools } from './mcp/tools'
import { validateMachine } from './engine/validate'
import { RunStore } from './engine/runStore'
import type { MachineDefinition } from './engine/types'
import type { HeadlessResult } from './headless/types'
import { parsePorcelain } from './git'

const root = mkdtempSync(join(tmpdir(), 'aide-manager-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const GUIDE = resolve(__dirname, '../../../resources/docs/pipeline-authoring.md')

function guideExample(): MachineDefinition {
  const text = readFileSync(GUIDE, 'utf8')
  const block = /## 5\. Example: code feature\s+```json\n([\s\S]*?)\n```/.exec(text)
  if (!block) throw new Error('example not found in the authoring guide')
  return JSON.parse(block[1]) as MachineDefinition
}

function project(name: string, machine: MachineDefinition): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'aide', 'pipelines', 'roles'), { recursive: true })
  writeFileSync(join(dir, 'aide', 'pipelines', `${machine.id}.json`), JSON.stringify(machine, null, 2))
  for (const role of ['implementer', 'code-reviewer', 'commit-prep']) writeFileSync(join(dir, 'aide', 'pipelines', 'roles', `${role}.md`), `${role} role`)
  return dir
}

function environment(agent: (label: string) => Partial<HeadlessResult>): ManagerEnvironment {
  let sessions = 0
  return {
    runsRoot: (p) => join(p, '.aide', 'runs'),
    libraryDirs: (p) => [{ dir: join(p, 'aide', 'pipelines'), source: 'shared' }],
    headlessClis: () => ['claude-code', 'codex'],
    deps: () => ({
      startAgent: (request) => {
        const sessionId = request.resumeSessionId ?? `s-${++sessions}`
        const result: HeadlessResult = { ok: true, sessionId, structured: null, finalText: null, costUsd: 0.02, warnings: [], error: null, ...agent(request.label) }
        return { result: Promise.resolve(result), cancel: async () => {} }
      },
      runCheck: (options) => {
        options.onOutput('ok\n')
        return { pid: 1, done: Promise.resolve({ exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'ok', stderrTail: '' }), cancel: async () => {} }
      },
      git: {
        workingDiff: async () => '+change',
        stagedDiff: async () => '+change',
        status: async () => parsePorcelain('M  src/a.ts\0'),
        headSha: async () => 'base',
        commitIndex: async (_cwd, message) => ({ sha: 'abc123', files: ['src/a.ts'], message })
      }
    })
  }
}

const happy = (label: string): Partial<HeadlessResult> => {
  if (label.endsWith(':review')) return { structured: { verdict: 'accept', blocking: [], non_blocking: ['nit'], summary: 'fine' } }
  if (label.endsWith(':commitPrep')) return { structured: { commitMessage: 'Add X', excluded: [] } }
  return { structured: { status: 'done', summary: 'did X', docsChanged: [] } }
}

async function call(server: McpServer, projectPath: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; structured?: Record<string, unknown>; isError?: boolean }> {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { projectPath, connectionId: 'c', tabId: null }) as { result: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } }
  return { text: response.result.content[0].text, structured: response.result.structuredContent, isError: response.result.isError }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!condition()) throw new Error('timed out')
}

describe('authoring guide', () => {
  it('its example machine is valid', () => {
    expect(validateMachine(guideExample(), { headlessClis: ['claude-code', 'codex'], roleExists: () => true }).errors).toEqual([])
  })
})

describe('PipelineManager through the MCP tools', () => {
  it('lists, starts, waits for and reports a run', async () => {
    const dir = project('p1', guideExample())
    const manager = new PipelineManager(environment(happy))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'aide-pipeline', docPath: 'doc', manager })))

    const list = await call(server, dir, 'pipeline_list')
    expect(list.structured?.machines).toEqual([expect.objectContaining({ id: 'code-feature', valid: true })])

    const missing = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: {} })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('Missing required param "taskSpec"')

    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Add X', acceptance: ['X works'] } })
    expect(started.isError).toBeUndefined()
    const runId = String(started.structured?.runId)
    expect(started.text).toContain(`events --run ${runId}`)

    const waited = await call(server, dir, 'pipeline_wait', { runId, since: 0, timeoutSec: 5 })
    expect(['commit_done', 'run_finished']).toContain(waited.structured?.type)
    await until(() => manager.activeRun(dir)?.isFinal() === true)

    const report = await call(server, dir, 'pipeline_report', { runId })
    expect(report.structured).toMatchObject({ result: 'success', nonBlockingFindings: ['nit'], commits: [{ sha: 'abc123' }] })
    expect((await call(server, dir, 'pipeline_runs')).structured?.runs).toEqual([expect.objectContaining({ runId, status: 'finished' })])
  })

  it('refuses a second active run and answers escalations', async () => {
    const machine = guideExample()
    const dir = project('p2', machine)
    const manager = new PipelineManager(environment((label) => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [] } } : happy(label)))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', docPath: 'd', manager })))
    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] } })
    const runId = String(started.structured?.runId)
    const event = await call(server, dir, 'pipeline_wait', { runId, timeoutSec: 5 })
    expect(event.structured).toMatchObject({ type: 'escalation', data: { node: 'planWrong' } })

    const second = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Z', acceptance: [] } })
    expect(second.isError).toBe(true)
    expect(second.text).toContain('still waiting')

    const escalationId = String((event.structured?.data as Record<string, unknown>).escalationId)
    const answered = await call(server, dir, 'pipeline_answer', { escalationId, action: 'continue', text: 'agreed, drop it' })
    expect(answered.isError).toBeUndefined()
    await until(() => manager.activeRun(dir)?.isFinal() === true)
    expect(manager.activeRun(dir)?.state.result).toBe('failure')
  })

  it('recovers an interrupted run as paused and resumes it', async () => {
    const dir = project('p3', guideExample())
    const env = environment(happy)
    // Simulate a run that was executing "checks" when AIDE died.
    const store = new RunStore(env.runsRoot(dir))
    const first = new PipelineManager(env)
    const { runId } = await first.start(dir, 'code-feature', { taskSpec: 'X', acceptance: [] })
    await until(() => first.activeRun(dir)?.isFinal() === true)
    const loaded = store.load(runId)!
    loaded.state.status = 'running'
    loaded.state.result = null
    loaded.state.finishedAt = null
    loaded.state.current = 'checks'
    loaded.state.history.push({ node: 'checks', visit: 2, outcome: null, startedAt: new Date().toISOString(), finishedAt: null, sessionId: null, costUsd: null, error: null })
    loaded.state.visits.checks = 2
    store.saveState(loaded.state)

    const second = new PipelineManager(env)
    const snapshot = second.recover(dir)
    expect(snapshot?.state.status).toBe('paused')
    expect(snapshot?.state.visits.checks).toBe(1)
    expect(snapshot?.state.history.at(-1)?.outcome).toBe('interrupted')
    second.resume(dir)
    await until(() => second.activeRun(dir)?.isFinal() === true)
    expect(second.activeRun(dir)?.state.result).toBe('success')
  })
})
