import { describe, expect, it, vi } from 'vitest'
import { AIDE_WORK_INSTRUCTION, AIDE_WORK_INSTRUCTION_WITHOUT_PLANS, buildPipelineTools, serverInstructions, workInstructionFor } from './tools'
import { McpServer, type RequestContext } from './protocol'
import { ALL_FEATURES_ON, PLAN_RUN_OFF_TEXT, featureOffText, toolFeature, type FeatureName, type FeatureSet } from '../../../shared/features'
import type { PlanService } from '../plan/planService'
import type { TaskService } from '../../tasks/taskService'
import { TRACKER_RULE } from '../../tasks/taskSnapshot'

vi.mock('../../diagnostics', () => ({ logEvent: vi.fn() }))

/**
 * The MCP server as pipeline/index.ts builds it, with the switches of each project
 * (docs/task-tracker-implementation.md §10).
 */
const TRACKER_PART = TRACKER_RULE

const plans = { list: () => [], tickLine: () => null } as unknown as PlanService
const tasks = { tailFor: () => '— tracker since your last call: task X closed by bob.' } as unknown as TaskService

function server(featuresOf: (projectPath: string) => FeatureSet): McpServer {
  return new McpServer({
    name: 'aide',
    version: 't',
    instructions: (context) => {
      const features = featuresOf(context.projectPath)
      return serverInstructions(AIDE_WORK_INSTRUCTION, features.tracker ? TRACKER_PART : '', features)
    },
    unavailableTool: (name, context) => {
      const feature = toolFeature(name)
      return feature && !featuresOf(context.projectPath)[feature] ? featureOffText(feature) : null
    }
  }, (context) => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'L', plans, tasks, planGuide: () => 'plan guide', features: featuresOf(context.projectPath) })))
}

const context = (projectPath = 'p'): RequestContext => ({ projectPath, connectionId: 'c', tabId: null })

async function session(mcp: McpServer, projectPath = 'p'): Promise<{ instructions: string; tools: string[] }> {
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, context(projectPath)) as { result: { instructions: string } }
  const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context(projectPath)) as { result: { tools: Array<{ name: string }> } }
  return { instructions: init.result.instructions, tools: list.result.tools.map((t) => t.name) }
}

async function call(mcp: McpServer, name: string, projectPath = 'p'): Promise<{ text: string; isError?: boolean }> {
  const reply = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } }, context(projectPath)) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  return { text: reply.result.content[0].text, isError: reply.result.isError }
}

const off = (name: FeatureName): FeatureSet => ({ ...ALL_FEATURES_ON, [name]: false })

describe('feature switches in the MCP server', () => {
  it('with no switches set nothing changes: the default is all on', async () => {
    expect(serverInstructions('W', 'T')).toBe(serverInstructions('W', 'T', ALL_FEATURES_ON))
    const plain = buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'L' }))
    const allOn = buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'L', features: ALL_FEATURES_ON }))
    expect(allOn.map((t) => [t.name, t.description])).toEqual(plain.map((t) => [t.name, t.description]))
    const { tools, instructions } = await session(server(() => ALL_FEATURES_ON))
    for (const prefix of ['pipeline_', 'plan_', 'task_', 'agent_']) expect(tools.some((t) => t.startsWith(prefix))).toBe(true)
    expect(instructions).toContain(TRACKER_PART)
    expect(instructions).toContain('pipeline_hello')
    expect(instructions).toContain('plan_guide')
    expect(instructions).toContain('agent_list')
  })

  it('pipelines off: no pipeline_* tools and no pipeline text; plan_run says why it is unavailable, other plan tools work', async () => {
    const mcp = server(() => off('pipelines'))
    const { tools, instructions } = await session(mcp)
    expect(tools.filter((t) => t.startsWith('pipeline_'))).toEqual([])
    expect(tools).toContain('toolbar_guide')
    expect(instructions).not.toContain('pipeline_')
    expect(instructions).not.toContain(AIDE_WORK_INSTRUCTION)
    expect(instructions).toContain('plan_guide')
    expect(instructions).toContain(TRACKER_PART)

    expect(tools).toContain('plan_run')
    const run = await call(mcp, 'plan_run')
    expect(run.isError).toBe(true)
    // The tracker is on: its tail follows the reason.
    expect(run.text.startsWith(PLAN_RUN_OFF_TEXT)).toBe(true)
    expect((await call(mcp, 'plan_list')).isError).toBeUndefined()
    expect(await call(mcp, 'pipeline_hello')).toEqual({ text: 'Pipelines are turned off in Settings.', isError: true })
  })

  it('plans off: no plan_* tools and no plan text in the instructions or in pipeline_hello', async () => {
    const mcp = server(() => off('plans'))
    const { tools, instructions } = await session(mcp)
    expect(tools.filter((t) => t.startsWith('plan_'))).toEqual([])
    expect(instructions).not.toContain('plan_')
    expect(instructions).not.toContain('Plans (')
    // No plan wording at all: AIDE's work instruction and the tracker rule come without plans.
    expect(instructions).not.toMatch(/\bplans?\b/i)
    expect(instructions).not.toContain(AIDE_WORK_INSTRUCTION)
    expect(instructions).toContain(AIDE_WORK_INSTRUCTION_WITHOUT_PLANS)
    expect(instructions).toContain('Task tracker (task_* tools)')
    expect(instructions).toContain('pipeline_hello')
    const listed = await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, context()) as { result: { tools: Array<{ name: string; description: string }> } }
    expect(listed.result.tools.find((t) => t.name === 'pipeline_hello')!.description).not.toMatch(/\bplans?\b/i)
    const hello = (await call(mcp, 'pipeline_hello')).text
    for (const text of ['plan_attention', 'plan_run', 'plan_edit', 'plan\'s autopilot', 'Orchestrator of a plan', 'the plan continued']) expect(hello).not.toContain(text)
    expect(hello).toContain('pipeline_start runs a machine directly')
    expect(hello).toContain('Escalation kinds')
    expect(await call(mcp, 'plan_list')).toEqual({ text: 'Plans are turned off in Settings.', isError: true })
  })

  it('tracker off: no task_* tools, no tracker text, and no tracker tail on other results', async () => {
    const on = server(() => ALL_FEATURES_ON)
    expect((await call(on, 'pipeline_schema')).text).toContain('tracker since your last call')

    const mcp = server(() => off('tracker'))
    const { tools, instructions } = await session(mcp)
    expect(tools.filter((t) => t.startsWith('task_'))).toEqual([])
    expect(instructions).not.toContain('task_')
    expect(instructions).not.toContain('Task tracker')
    expect((await call(mcp, 'pipeline_schema')).text).not.toContain('tracker since your last call')
    expect((await call(mcp, 'plan_list')).text).not.toContain('tracker since your last call')
    expect(await call(mcp, 'task_snapshot')).toEqual({ text: 'The task tracker is turned off in Settings.', isError: true })
  })

  it("with plans off a user's own work instruction passes as written", () => {
    const own = 'Use plans for everything.'
    expect(workInstructionFor(own, off('plans'))).toBe(own)
    expect(serverInstructions(own, '', off('plans'))).toContain(own)
    expect(workInstructionFor(AIDE_WORK_INSTRUCTION, ALL_FEATURES_ON)).toBe(AIDE_WORK_INSTRUCTION)
  })

  it('agents off: no agent_* tools and no agent messaging text in instructions', async () => {
    const mcp = server(() => off('agents'))
    const { tools, instructions } = await session(mcp)
    expect(tools.filter((t) => t.startsWith('agent_'))).toEqual([])
    expect(instructions).not.toContain('agent_list')
    expect(instructions).not.toContain('Agent messaging')
    expect(await call(mcp, 'agent_list')).toEqual({ text: 'Agent messaging is turned off in Settings.', isError: true })
  })

  it('two projects on one server resolve independently', async () => {
    const mcp = server((projectPath) => projectPath === 'a' ? { pipelines: false, plans: false, tracker: false, agents: false } : ALL_FEATURES_ON)
    const a = await session(mcp, 'a')
    const b = await session(mcp, 'b')
    expect(a.tools).toEqual(['toolbar_guide', 'view_show'])
    expect(b.tools.length).toBeGreaterThan(20)
    expect(b.instructions).toContain(TRACKER_PART)
  })

  it('a change of the switches reaches the next session', async () => {
    let features = ALL_FEATURES_ON
    const mcp = server(() => features)
    expect((await session(mcp)).tools).toContain('task_snapshot')
    features = off('tracker')
    expect((await session(mcp)).tools).not.toContain('task_snapshot')
  })
})
