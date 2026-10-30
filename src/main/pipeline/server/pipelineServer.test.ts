import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createInterface } from 'readline'
import { PipelineServer } from './pipelineServer'
import { buildPipelineTools } from '../mcp/tools'
import { orchestrators } from '../orchestrators'
import { pipelineEvents } from '../events'

const SHIM = resolve(__dirname, '../../../../resources/mcp/aide-mcp.cjs')

interface Shim {
  child: ChildProcessWithoutNullStreams
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>
  notify(message: Record<string, unknown>): void
}

function startShim(cwd: string, runtimeDir: string, args: string[] = ['mcp'], extraEnv: Record<string, string> = {}): Shim {
  const child = spawn(process.execPath, [SHIM, ...args], { cwd, env: { ...process.env, AIDE_RUNTIME_DIR: runtimeDir, ...extraEnv } })
  const waiting = new Map<unknown, (value: Record<string, unknown>) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  return {
    child,
    request: (message) => new Promise((resolveResponse) => {
      waiting.set(message.id, resolveResponse)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    }),
    notify: (message) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
  }
}

function runFeed(cwd: string, runtimeDir: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SHIM, ...args], { cwd, env: { ...process.env, AIDE_RUNTIME_DIR: runtimeDir } })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('close', (code) => resolveRun({ code, stdout }))
  })
}

describe('pipeline server + stdio shim', () => {
  const root = mkdtempSync(join(tmpdir(), 'aide-pipeline-server-'))
  const runtimeDir = join(root, 'runtime')
  const project = join(root, 'project')
  const nested = join(project, 'src', 'deep')
  const server = new PipelineServer()
  const shims: Shim[] = []

  beforeAll(async () => {
    mkdirSync(nested, { recursive: true })
    server.registerProject(project)
    await server.start({
      runtimeDir,
      serverName: 'aide',
      serverVersion: '0.0.0-test',
      instructions: 'test instructions',
      tools: () => buildPipelineTools(() => ({ aideVersion: '0.0.0-test', launcherPath: 'aide-pipeline', docPath: '.aide/docs/orchestration-mcp.md' }))
    })
  })

  afterAll(async () => {
    // Wait for the shims to exit: Windows refuses to delete a live process's cwd.
    await Promise.all(shims.map((shim) => new Promise<void>((resolveExit) => {
      if (shim.child.exitCode !== null || shim.child.signalCode !== null) { resolveExit(); return }
      shim.child.once('exit', () => resolveExit())
      shim.child.kill()
    })))
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a discovery file for the registered project', () => {
    expect(readdirSync(join(runtimeDir, 'projects'))).toHaveLength(1)
  })

  it('completes the MCP handshake through the shim from a nested directory', async () => {
    const shim = startShim(nested, runtimeDir, ['mcp'], { AIDE_TAB_ID: 'tab-7' })
    shims.push(shim)
    const init = await shim.request({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.2.3' } } })
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'aide' }, instructions: 'test instructions' })
    shim.notify({ method: 'notifications/initialized' })

    const list = await shim.request({ id: 2, method: 'tools/list' })
    expect((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain('pipeline_hello')

    const connected = new Promise<unknown>((resolveConnected) => orchestrators.once('connected', resolveConnected))
    const hello = await shim.request({ id: 3, method: 'tools/call', params: { name: 'pipeline_hello', arguments: {} } })
    const result = hello.result as { content: Array<{ text: string }>; structuredContent?: unknown }
    expect(result.content[0].text).toContain('Strategist')
    // Results are text only — nothing is duplicated into the agent's context.
    expect(result.structuredContent).toBeUndefined()
    expect(await connected).toMatchObject({ projectPath: project, tabId: 'tab-7', client: { name: 'test-client', version: '1.2.3' } })
  })

  it('reports unknown tools and methods as JSON-RPC errors', async () => {
    const shim = startShim(project, runtimeDir)
    shims.push(shim)
    const unknownTool = await shim.request({ id: 1, method: 'tools/call', params: { name: 'nope' } })
    expect(unknownTool.error).toMatchObject({ code: -32602 })
    const unknownMethod = await shim.request({ id: 2, method: 'resources/list' })
    expect(unknownMethod.error).toMatchObject({ code: -32601 })
  })

  it('answers locally when no AIDE serves the directory', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const shim = startShim(outside, runtimeDir)
    shims.push(shim)
    const init = await shim.request({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(init.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { version: 'offline' } })
    const call = await shim.request({ id: 2, method: 'tools/call', params: { name: 'pipeline_hello' } })
    expect(String((call.error as { message: string }).message)).toContain('not running')
  })

  it('wait returns a significant event already in the log', async () => {
    pipelineEvents.emit(project, 'run-1', 'node_started', { node: 'implement' })
    const finished = pipelineEvents.emit(project, 'run-1', 'run_finished', { result: 'success' })
    const { code, stdout } = await runFeed(project, runtimeDir, ['wait', '--run', 'run-1', '--since', '0'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ id: finished.id, type: 'run_finished' })
  })

  it('wait blocks until the next significant event', async () => {
    const pending = runFeed(project, runtimeDir, ['wait', '--run', 'run-2', '--since', '0'])
    setTimeout(() => {
      pipelineEvents.emit(project, 'run-2', 'node_started', {})
      pipelineEvents.emit(project, 'run-2', 'escalation', { question: 'proceed?' })
    }, 500)
    const { stdout } = await pending
    expect(JSON.parse(stdout)).toMatchObject({ runId: 'run-2', type: 'escalation' })
  })

  async function streamLines(args: string[], emitLive: () => void, count: number): Promise<Array<Record<string, unknown>>> {
    const child = spawn(process.execPath, [SHIM, 'events', ...args], { cwd: project, env: { ...process.env, AIDE_RUNTIME_DIR: runtimeDir } })
    const lines: Array<Record<string, unknown>> = []
    await new Promise<void>((resolveLines) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        expect(line.trim()).not.toBe('') // heartbeats never reach the agent
        lines.push(JSON.parse(line) as Record<string, unknown>)
        if (lines.length === 1) setTimeout(emitLive, 100)
        if (lines.length === count) resolveLines()
      })
    })
    child.kill()
    return lines
  }

  it('events streams only the events that need the orchestrator, backlog and live', async () => {
    pipelineEvents.emit(project, 'run-3', 'node_started', { node: 'a' })
    pipelineEvents.emit(project, 'run-3', 'escalation', { node: 'a' })
    const lines = await streamLines(['--run', 'run-3'], () => {
      pipelineEvents.emit(project, 'run-3', 'node_finished', { node: 'a' })
      pipelineEvents.emit(project, 'run-3', 'run_finished', { result: 'success' })
    }, 2)
    expect(lines.map((l) => l.type)).toEqual(['escalation', 'run_finished'])
  })

  it('events --all streams every event', async () => {
    pipelineEvents.emit(project, 'run-4', 'node_started', { node: 'a' })
    const lines = await streamLines(['--run', 'run-4', '--all'], () => pipelineEvents.emit(project, 'run-4', 'node_finished', { node: 'a' }), 2)
    expect(lines.map((l) => l.type)).toEqual(['node_started', 'node_finished'])
  })

  it('rejects requests without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/mcp`, { method: 'POST', body: '{}', headers: { 'x-aide-project': project } })
    expect(res.status).toBe(403)
  })

  it('takes a step answer through its result channel, checked against the schema', async () => {
    const schema = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', enum: ['accept', 'reject'] } } }
    const channel = server.openResultChannel(project, schema)!
    expect(server.openResultChannel(join(root, 'elsewhere'), schema)).toBeNull()
    expect(server.openResultChannel(project, { type: 'array' })).toBeNull()
    const rpc = async (body: Record<string, unknown>): Promise<{ status: number; json?: Record<string, unknown> }> => {
      const res = await fetch(channel.url, { method: 'POST', headers: { ...channel.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })
      return { status: res.status, json: res.status === 200 ? await res.json() as Record<string, unknown> : undefined }
    }
    const listed = await rpc({ method: 'tools/list' })
    expect(listed.json).toMatchObject({ result: { tools: [{ name: 'submit_result', inputSchema: schema }] } })

    const wrong = await rpc({ method: 'tools/call', params: { name: 'submit_result', arguments: { verdict: 'maybe' } } })
    expect(wrong.json).toMatchObject({ result: { isError: true } })
    expect(JSON.stringify(wrong.json)).toContain('Call submit_result again')
    expect(channel.submitted()).toBeUndefined()

    const right = await rpc({ method: 'tools/call', params: { name: 'submit_result', arguments: { verdict: 'accept' } } })
    expect(JSON.stringify(right.json)).toContain('end your turn now')
    expect(channel.submitted()).toEqual({ verdict: 'accept' })

    channel.close()
    expect((await rpc({ method: 'tools/list' })).status).toBe(404)
  })
})
