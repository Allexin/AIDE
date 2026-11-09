import { afterEach, describe, it, expect, vi } from 'vitest'
import { AIDE_WORK_INSTRUCTION, buildPipelineTools, serverInstructions } from './tools'
import { McpServer, type ToolContext } from './protocol'
import { pipelineEvents } from '../events'
import { logEvent } from '../../diagnostics'

vi.mock('../../diagnostics', () => ({ logEvent: vi.fn() }))

const helloDescription = (workInstruction?: () => string): string =>
  buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', workInstruction })).find((t) => t.name === 'pipeline_hello')!.description

describe('work instruction', () => {
  it("server instructions carry AIDE's instruction by default and the override when set", () => {
    expect(serverInstructions()).toContain(AIDE_WORK_INSTRUCTION)
    const custom = serverInstructions('Use pipelines only when I ask.')
    expect(custom).toContain('Use pipelines only when I ask.')
    expect(custom).not.toContain(AIDE_WORK_INSTRUCTION)
  })

  it('an empty override leaves no instruction and keeps the rest', () => {
    const text = serverInstructions('  ')
    expect(text).not.toContain(AIDE_WORK_INSTRUCTION)
    expect(text).not.toContain('  ')
    expect(text).toContain('pipeline_hello')
    expect(text).toContain('toolbar_guide')
  })

  it('the pipeline_hello description follows the instruction in effect', () => {
    expect(helloDescription()).toContain(AIDE_WORK_INSTRUCTION)
    expect(helloDescription(() => 'Only when asked.')).toContain('Only when asked.')
    expect(helloDescription(() => '')).not.toContain(AIDE_WORK_INSTRUCTION)
  })

  it('initialize reads instructions given as a function at every call', async () => {
    let current = 'first'
    const server = new McpServer({ name: 'aide', version: 't', instructions: () => current }, () => [])
    const init = async (): Promise<unknown> => {
      const reply = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { projectPath: 'p', connectionId: 'c', tabId: null })
      return (reply as { result: { instructions: string } }).result.instructions
    }
    expect(await init()).toBe('first')
    current = 'second'
    expect(await init()).toBe('second')
  })
})

describe('waiting for events', () => {
  const PROJECT = '/projects/tools-wait'
  const context = (extra: Partial<ToolContext> = {}): ToolContext => ({ projectPath: PROJECT, connectionId: 'c', tabId: null, clientInfo: null, ...extra })
  const handler = (name: string, manager?: object): ((args: Record<string, unknown>, ctx?: ToolContext) => Promise<{ text: string }>) => {
    const tool = buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager: manager as never })).find((t) => t.name === name)!
    return async (args, ctx = context()) => tool.handler(args, ctx)
  }
  const mcp = (): McpServer => new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l' })))
  const waitCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pipeline_wait', arguments: { timeoutSec: 30 } } }
  /** Live waiters: a progress event is covered by none of them, so they all count as "other". */
  const liveWaiters = (): number => {
    const { delivery } = pipelineEvents.publish(PROJECT, 'probe', 'node_started', {})
    return delivery.covering + delivery.other
  }

  afterEach(() => {
    pipelineEvents.reset(PROJECT)
    vi.mocked(logEvent).mockClear()
  })

  it('a wait scoped to a run returns a plan_attention emitted while it waits', async () => {
    const pending = handler('pipeline_wait')({ runId: 'run-1', timeoutSec: 30 })
    const { event } = pipelineEvents.publish(PROJECT, 'plan:p1', 'plan_attention', { plan: 'p1', kind: 'wake' })
    expect(JSON.parse((await pending).text)).toMatchObject({ id: event.id, type: 'plan_attention', runId: 'plan:p1' })
  })

  it('a wait scoped to a run ignores events of other runs', async () => {
    const controller = new AbortController()
    const pending = handler('pipeline_wait')({ runId: 'run-1', timeoutSec: 30 }, context({ signal: controller.signal }))
    expect(pipelineEvents.publish(PROJECT, 'run-2', 'escalation', {}).delivery).toEqual({ covering: 0, other: 1, handedTo: 0 })
    controller.abort('cancelled')
    await pending
  })

  it('pipeline_answer with wait returns a plan_attention emitted while it waits', async () => {
    const manager = {
      activeRun: () => ({ runId: 'run-1' }),
      answer: async () => { setImmediate(() => pipelineEvents.emit(PROJECT, 'plan:p1', 'plan_attention', { plan: 'p1' })) }
    }
    const { text } = await handler('pipeline_answer', manager)({ escalationId: 'esc', action: 'continue', wait: 30 })
    expect(text).toContain('plan_attention')
  })

  it('pipeline_resume with wait returns a plan_attention emitted while it waits', async () => {
    const manager = {
      activeRun: () => ({ runId: 'run-1' }),
      resume: () => { setImmediate(() => pipelineEvents.emit(PROJECT, 'plan:p1', 'plan_attention', { plan: 'p1' })) }
    }
    const { text } = await handler('pipeline_resume', manager)({ wait: 30 })
    expect(text).toContain('plan_attention')
  })

  it('pipeline_start with wait does not return a plan_attention raised before the start', async () => {
    pipelineEvents.emit(PROJECT, 'plan:p1', 'plan_attention', { plan: 'p1', reason: 'stale' })
    const manager = { start: async () => { pipelineEvents.emit(PROJECT, 'run-1', 'run_finished', { result: 'success' }); return { runId: 'run-1', warnings: [] } } }
    const { text } = await handler('pipeline_start', manager)({ machine: 'm', wait: 30 })
    expect(text).toContain('run_finished')
    expect(text).not.toContain('plan_attention')
  })

  it('pipeline_start with wait returns a plan_attention raised after the start', async () => {
    const manager = { start: async () => { setImmediate(() => pipelineEvents.emit(PROJECT, 'plan:p1', 'plan_attention', { plan: 'p1' })); return { runId: 'run-1', warnings: [] } } }
    const { text } = await handler('pipeline_start', manager)({ machine: 'm', wait: 30 })
    expect(text).toContain('plan_attention')
  })

  it('reports each event it hands over', async () => {
    const handed: number[] = []
    const pending = handler('pipeline_wait')({ timeoutSec: 30 }, context({ onEventHandedOut: (event) => { handed.push(event.id) } }))
    const { event } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {})
    await pending
    expect(handed).toEqual([event.id])
  })

  it('counts a backlog event as handed out', async () => {
    const { event } = pipelineEvents.publish(PROJECT, 'run-1', 'escalation', {})
    await handler('pipeline_wait')({ runId: 'run-1' })
    expect(pipelineEvents.wasHandedOut(PROJECT, event.id)).toBe(true)
  })

  it('leaves no listener after notifications/cancelled and sends no response', async () => {
    const server = mcp()
    const requestContext = { projectPath: PROJECT, connectionId: 'conn-1', tabId: 'tab-1' }
    const pending = server.handle(waitCall, requestContext)
    expect(liveWaiters()).toBe(1)

    await expect(server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, requestContext)).resolves.toBeNull()

    expect(liveWaiters()).toBe(0)
    await expect(pending).resolves.toBeNull()
    expect(logEvent).toHaveBeenCalledWith('pipeline-wait-ended', expect.objectContaining({ via: 'mcp', reason: 'cancelled', tabId: 'tab-1' }))
  })

  it('a cancellation for another connection or request does not touch the wait', async () => {
    const server = mcp()
    const owner = { projectPath: PROJECT, connectionId: 'conn-1', tabId: null }
    const pending = server.handle(waitCall, owner)

    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, { ...owner, connectionId: 'conn-2' })
    await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 8 } }, owner)
    expect(liveWaiters()).toBe(1)

    pipelineEvents.emit(PROJECT, 'run-1', 'run_failed', {})
    expect(JSON.stringify(await pending)).toContain('run_failed')
  })

  it('leaves no listener when the connection of the call closes', async () => {
    const connection = new AbortController()
    const pending = mcp().handle(waitCall, { projectPath: PROJECT, connectionId: 'c', tabId: null, signal: connection.signal })
    expect(liveWaiters()).toBe(1)

    connection.abort('connection-closed')

    expect(liveWaiters()).toBe(0)
    await expect(pending).resolves.toBeNull()
    expect(logEvent).toHaveBeenCalledWith('pipeline-wait-ended', expect.objectContaining({ reason: 'connection-closed' }))
  })

  it('does not start waiting for a call already cancelled', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')
    pipelineEvents.emit(PROJECT, 'run-1', 'escalation', {})
    const handed: number[] = []
    await handler('pipeline_wait')({ timeoutSec: 30 }, context({ signal: controller.signal, onEventHandedOut: (e) => { handed.push(e.id) } }))
    expect(handed).toEqual([])
    expect(liveWaiters()).toBe(0)
  })
})
