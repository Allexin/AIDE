import http from 'http'
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { logEvent } from '../../diagnostics'
import { McpServer, type ToolDefinition } from '../mcp/protocol'
import { orchestrators } from '../orchestrators'
import { tabActivity } from '../../pty/tabActivity'
import { isSignificant, pipelineEvents, type PipelineEvent } from '../events'
import { validateAgainstSchema } from '../engine/schema'
import type { JsonSchema } from '../engine/types'
import type { ResultTool } from '../headless/types'
import { pruneStaleRuntimes, removeAllProjectRuntimes, removeProjectRuntime, writeProjectRuntime } from './runtimeFiles'

/**
 * App-wide localhost server through which agents reach AIDE's pipeline API.
 * Agents never talk to it directly: the stdio shim (resources/mcp/aide-mcp.cjs)
 * finds it via a per-project discovery file and forwards requests.
 *
 *   POST /mcp     one JSON-RPC message (or batch) → JSON-RPC response, 202 for notifications
 *   GET  /events  NDJSON stream of a run's significant events (?run=&since=; &all=1 for every event)
 *   GET  /wait    the next significant event of a run as one JSON line (?run=&since=&timeout=)
 *   POST /step    MCP of one step visit (header x-aide-step): its submit_result tool (see openResultChannel)
 *
 * Every request must carry the token and a registered project path. Same
 * guarantees as the hook server: localhost only, permanent 'error' listeners.
 */

export interface PipelineServerOptions {
  runtimeDir: string
  serverName: string
  serverVersion: string
  instructions: string
  tools: () => ToolDefinition[]
}

/** MCP server name of a step's result channel. */
export const RESULT_SERVER_NAME = 'aide_step'

export interface ResultChannel extends ResultTool {
  close(): void
}

interface OpenChannel {
  projectPath: string
  mcp: McpServer
}

function resultTool(schema: JsonSchema, record: (answer: unknown) => void): ToolDefinition {
  return {
    name: 'submit_result',
    description: 'Submit the final answer of this pipeline step. Its parameters are the required answer format. Call it once you are done; if it reports problems, correct the answer and call it again.',
    inputSchema: schema,
    handler: (args) => {
      const errors = validateAgainstSchema(args, schema)
      if (errors.length > 0) return { text: `The answer does not match the required format: ${errors.join('; ')}. Call submit_result again with a corrected answer.`, isError: true }
      record(args)
      return { text: 'Answer recorded. The step is complete: end your turn now.' }
    }
  }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_WAIT_SEC = 600
const HEARTBEAT_MS = 30_000

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

export class PipelineServer {
  private server: http.Server | null = null
  private port = 0
  private token = ''
  private readonly projects = new Set<string>()
  private readonly openStreams = new Set<http.ServerResponse>()
  private mcp: McpServer | null = null
  private options: PipelineServerOptions | null = null
  private readonly channels = new Map<string, OpenChannel>()

  async start(options: PipelineServerOptions): Promise<void> {
    if (this.server) return
    this.options = options
    this.token = randomBytes(24).toString('hex')
    this.mcp = new McpServer({ name: options.serverName, version: options.serverVersion, instructions: options.instructions }, options.tools)
    pruneStaleRuntimes(options.runtimeDir, isAlive)
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>((resolve, reject) => {
      const srv = this.server!
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        this.port = (srv.address() as { port: number }).port
        srv.removeListener('error', reject)
        // Permanent listeners: an 'error' event without one is thrown and would
        // take the whole main process down (see CLAUDE.md).
        srv.on('error', (err: NodeJS.ErrnoException) => {
          logEvent('pipeline-server-error', { code: err?.code ?? null, message: err?.message ?? String(err) }, 'warn')
        })
        srv.on('clientError', (err: NodeJS.ErrnoException, socket) => {
          logEvent('pipeline-server-client-error', { code: err?.code ?? null, message: err?.message ?? String(err) }, 'warn')
          socket.destroy()
        })
        resolve()
      })
    })
    for (const projectPath of this.projects) writeProjectRuntime(options.runtimeDir, projectPath, this.port, this.token)
  }

  getPort(): number { return this.port }

  isRunning(): boolean { return this.server !== null }

  /** Publish a discovery file so agents working in `projectPath` can reach this instance. */
  registerProject(projectPath: string): void {
    this.projects.add(projectPath)
    if (this.server && this.options) writeProjectRuntime(this.options.runtimeDir, projectPath, this.port, this.token)
  }

  unregisterProject(projectPath: string): void {
    this.projects.delete(projectPath)
    if (this.options) removeProjectRuntime(this.options.runtimeDir, projectPath)
  }

  /**
   * A result channel for one agent run: an MCP endpoint with a `submit_result`
   * tool whose parameters are `schema`. Null when the server does not run, the
   * project is not registered or the schema is not an object (a tool takes an object).
   */
  openResultChannel(projectPath: string, schema: JsonSchema): ResultChannel | null {
    if (!this.server || !this.projects.has(projectPath) || schema.type !== 'object') return null
    const id = randomUUID()
    let value: { answer: unknown } | null = null
    const tool = resultTool(schema, (answer) => { value = { answer } })
    const mcp = new McpServer({ name: RESULT_SERVER_NAME, version: this.options?.serverVersion ?? '', instructions: 'Submit the final answer of this pipeline step with submit_result.' }, () => [tool])
    this.channels.set(id, { projectPath, mcp })
    return {
      serverName: RESULT_SERVER_NAME,
      url: `http://127.0.0.1:${this.port}/step`,
      headers: { 'x-aide-token': this.token, 'x-aide-project': projectPath, 'x-aide-step': id },
      submitted: () => value?.answer,
      close: () => { this.channels.delete(id) }
    }
  }

  async stop(): Promise<void> {
    if (this.options) removeAllProjectRuntimes(this.options.runtimeDir, this.projects)
    for (const res of this.openStreams) res.end()
    this.openStreams.clear()
    const srv = this.server
    this.server = null
    if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()))
  }

  private authorized(req: http.IncomingMessage): string | null {
    const token = String(req.headers['x-aide-token'] ?? '')
    const expected = Buffer.from(this.token)
    const given = Buffer.from(token)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    const project = String(req.headers['x-aide-project'] ?? '')
    return this.projects.has(project) ? project : null
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const projectPath = this.authorized(req)
      if (!projectPath) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
        return
      }
      const tabId = req.headers['x-aide-tab'] ? String(req.headers['x-aide-tab']) : null
      if (tabId) {
        // An agent calling the pipeline is working, whatever its PTY shows.
        orchestrators.touch(projectPath, tabId)
        tabActivity.markBusy(tabId)
      }
      if (url.pathname === '/events' || url.pathname === '/wait') pipelineEvents.noteObserver(projectPath)
      if (req.method === 'POST' && url.pathname === '/mcp') await this.handleMcp(req, res, projectPath, this.mcp!)
      else if (req.method === 'POST' && url.pathname === '/step') {
        const channel = this.channels.get(String(req.headers['x-aide-step'] ?? ''))
        if (channel && channel.projectPath === projectPath) await this.handleMcp(req, res, projectPath, channel.mcp)
        else res.writeHead(404, { 'content-type': 'text/plain' }).end('No such step')
      }
      else if (req.method === 'GET' && url.pathname === '/events') this.handleEvents(url, res, projectPath)
      else if (req.method === 'GET' && url.pathname === '/wait') this.handleWait(url, res, projectPath)
      else res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    } catch (err) {
      logEvent('pipeline-server-request-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal error')
    }
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse, projectPath: string, mcp: McpServer): Promise<void> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain' }).end('Payload too large')
        return
      }
      chunks.push(chunk as Buffer)
    }
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    const response = await mcp.handle(payload, {
      projectPath,
      connectionId: String(req.headers['x-aide-conn'] ?? ''),
      tabId: req.headers['x-aide-tab'] ? String(req.headers['x-aide-tab']) : null
    })
    if (response === null) res.writeHead(202).end()
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response))
  }

  private handleEvents(url: URL, res: http.ServerResponse, projectPath: string): void {
    const runId = url.searchParams.get('run')
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    // Every line may become a notification in the orchestrator's context: by default only events that need it.
    const all = url.searchParams.get('all') === '1'
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
    this.openStreams.add(res)
    const write = (event: PipelineEvent): void => { if (all || isSignificant(event)) res.write(JSON.stringify(event) + '\n') }
    for (const event of pipelineEvents.since(projectPath, runId, since)) write(event)
    const unsubscribe = pipelineEvents.subscribe(projectPath, (event) => {
      if (runId === null || event.runId === runId) write(event)
    })
    // Keeps idle connections from being dropped by intermediaries and reveals dead peers.
    const heartbeat = setInterval(() => res.write('\n'), HEARTBEAT_MS)
    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
      this.openStreams.delete(res)
    }
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  private handleWait(url: URL, res: http.ServerResponse, projectPath: string): void {
    const runId = url.searchParams.get('run')
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const timeoutSec = Math.min(Number(url.searchParams.get('timeout') ?? DEFAULT_WAIT_SEC) || DEFAULT_WAIT_SEC, 3600)
    const respond = (body: unknown): void => {
      if (!res.writableEnded) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body) + '\n')
    }
    const pending = pipelineEvents.since(projectPath, runId, since).find(isSignificant)
    if (pending) { respond(pending); return }
    const unsubscribe = pipelineEvents.subscribe(projectPath, (event) => {
      if ((runId === null || event.runId === runId) && isSignificant(event)) { done(); respond(event) }
    })
    const timer = setTimeout(() => { done(); respond({ type: 'timeout', since }) }, timeoutSec * 1000)
    const done = (): void => { clearTimeout(timer); unsubscribe() }
    res.on('close', done)
  }
}

export const pipelineServer = new PipelineServer()
