import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PipelineManager, type ManagerEnvironment } from '../manager'
import { McpServer } from '../mcp/protocol'
import { buildPipelineTools } from '../mcp/tools'
import type { HeadlessResult } from '../headless/types'
import type { AgentRequest } from '../engine/runner'
import type { MachineDefinition } from '../engine/types'
import { ENGINE_VERSION } from '../engine/compat'
import { parsePorcelain } from '../git'
import { pipelineEvents } from '../events'
import { buildRemotePlanView } from '../../remote/planView'
import { decisionSchema, PlanService } from './planService'
import type { OrchestratorDecision, PlanFile } from '../../../shared/plan'

const root = mkdtempSync(join(tmpdir(), 'aide-plan-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MACHINE: MachineDefinition = {
  id: 'feature',
  name: 'Feature',
  description: 'Does a task',
  engineVersion: ENGINE_VERSION,
  params: { taskSpec: { type: 'string', description: 'What to do' }, scope: { type: 'string[]', required: false } },
  defaults: { cli: 'claude-code' },
  steps: [
    { type: 'agent', id: 'implement', role: 'roles/implementer.md', summary: 'Implements', output: 'implementerReport', task: '{{params.taskSpec}}' },
    { type: 'commit', id: 'commit', review: 'algorithmic', prep: { type: 'agent', id: 'prep', role: 'roles/implementer.md', summary: 'Prepares', output: 'commitPrep', session: 'new' } }
  ]
} as unknown as MachineDefinition

/** The implementer may stop the run for a decision. */
const GUARDED: MachineDefinition = {
  ...MACHINE,
  id: 'guarded',
  steps: [
    { type: 'agent', id: 'implement', role: 'roles/implementer.md', summary: 'Implements', output: 'implementerReport', task: '{{params.taskSpec}}', escalateIf: "outputs.implement.status != 'done'", escalateMessage: 'The implementer says the task cannot be done as written.' },
    MACHINE.steps[1]
  ]
} as unknown as MachineDefinition

let counter = 0
let lastFixture: Fixture | null = null

interface Fixture {
  dir: string
  manager: PipelineManager
  plans: PlanService
  server: McpServer
  committed: string[]
  staged: string[]
  orchestratorPrompts: AgentRequest[]
  stepInstructions: () => string[]
  decide: (request: AgentRequest) => Partial<HeadlessResult>
  /** The implementer's answer to each visit. */
  implement: (request: AgentRequest) => Partial<HeadlessResult>
  failRun: { on: string | null }
  holdImplement: Promise<void> | null
  file: () => PlanFile
}

const next = (extra: Partial<OrchestratorDecision> = {}): Partial<HeadlessResult> => ({ structured: { verdict: 'next', reason: 'fine', proposal: '', handoff: '', params: { taskSpec: 'do it', scope: null }, ...extra } })

function fixture(): Fixture {
  const dir = join(root, `p${++counter}`)
  mkdirSync(join(dir, 'aide', 'pipelines', 'roles'), { recursive: true })
  writeFileSync(join(dir, 'aide', 'pipelines', 'feature.json'), JSON.stringify(MACHINE))
  writeFileSync(join(dir, 'aide', 'pipelines', 'guarded.json'), JSON.stringify(GUARDED))
  writeFileSync(join(dir, 'aide', 'pipelines', 'roles', 'implementer.md'), 'role')
  const fx: Fixture = {
    dir,
    committed: [],
    staged: [],
    orchestratorPrompts: [],
    stepInstructions: () => [],
    decide: () => next(),
    implement: () => ({ structured: { status: 'done', summary: 'did it', docsChanged: [], pipelineIssues: [] } }),
    failRun: { on: null },
    holdImplement: null,
    file: () => JSON.parse(readFileSync(join(dir, 'aide', 'plans', 'p.json'), 'utf8')) as PlanFile
  } as unknown as Fixture
  let sessions = 0
  const env: ManagerEnvironment = {
    runsRoot: (p) => join(p, '.aide', 'runs'),
    libraryDirs: (p) => [{ dir: join(p, 'aide', 'pipelines'), source: 'shared' }],
    headlessClis: () => ['claude-code'],
    deps: () => ({
      startAgent: (request) => {
        const sessionId = request.resumeSessionId ?? `s-${++sessions}`
        let partial: Partial<HeadlessResult>
        if (request.label.includes('plan-orchestrator')) {
          fx.orchestratorPrompts.push(request)
          partial = fx.decide(request)
        } else if (request.label.endsWith(':prep')) {
          partial = { structured: { commitMessage: 'Do it\n\nBody.\n\nCo-Authored-By: X <x@y>', excluded: [], pipelineIssues: [] } }
        } else {
          partial = fx.implement(request)
        }
        const hold = request.label.endsWith(':implement') ? fx.holdImplement : null
        const result: HeadlessResult = { ok: true, sessionId, structured: null, finalText: null, costUsd: 0.01, warnings: [], error: null, ...partial }
        return { result: hold ? hold.then(() => result) : Promise.resolve(result), cancel: async () => {} }
      },
      runCheck: () => { throw new Error('no checks') },
      git: {
        workingDiff: async () => '',
        stagedDiff: async () => '',
        status: async () => parsePorcelain('M  src/a.ts\0'),
        headSha: async () => `head${fx.committed.length}`,
        commitIndex: async (_cwd, message) => {
          if (fx.failRun.on === 'commit') throw new Error('hook failed')
          fx.committed.push(message)
          return { sha: `sha${fx.committed.length}`, files: ['src/a.ts'], message }
        }
      }
    })
  }
  fx.manager = new PipelineManager(env)
  fx.plans = new PlanService(fx.manager, {
    userDir: (p) => join(p, '.aide', 'plans'),
    stage: async (_p, paths) => { fx.staged.push(...paths) },
    headSha: async () => `head${fx.committed.length}`,
    commitsSince: async () => []
  })
  fx.server = new McpServer({ name: 'aide', version: '1', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: '1', launcherPath: 'x', docPath: 'd', manager: fx.manager, plans: fx.plans, planGuide: () => 'guide' })))
  lastFixture = fx
  return fx
}

function approvedPlan(fx: Fixture, overrides: Record<string, unknown> = {}): void {
  fx.plans.create(fx.dir, {
    id: 'p',
    title: 'P',
    orchestrator: { cli: 'claude-code', prompt: 'CHECK-THIS', ...((overrides.orchestrator as object) ?? {}) },
    tasks: overrides.tasks ?? [
      { id: 'one', title: 'First', machine: 'feature', spec: 'docs/x.md#one', acceptance: ['works'] },
      { id: 'two', title: 'Second', machine: 'feature', after: ['one'] }
    ]
  })
  fx.plans.approve(fx.dir, 'p')
  fx.plans.activate(fx.dir, 'p')
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!condition()) throw new Error(`timed out; plan state: ${JSON.stringify(lastFixture?.plans.snapshot(lastFixture.dir).autopilot?.attention ?? null)}`)
}

const attentionOf = (fx: Fixture): { kind: string; reason: string; proposal?: string } | null | undefined => fx.plans.snapshot(fx.dir).autopilot?.attention
const events = (fx: Fixture): Array<Record<string, unknown>> => pipelineEvents.since(fx.dir, null, 0).filter((e) => e.type === 'plan_attention').map((e) => e.data)

async function call(fx: Fixture, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError?: boolean }> {
  const response = await fx.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { projectPath: fx.dir, connectionId: 'c', tabId: null }) as { result: { content: Array<{ text: string }>; isError?: boolean } }
  return { text: response.result.content[0].text, isError: response.result.isError }
}

describe('plan lifecycle', () => {
  it('a draft cannot be activated; one plan is active and activating starts nothing', () => {
    const fx = fixture()
    fx.plans.create(fx.dir, { id: 'a', title: 'A', tasks: [] })
    fx.plans.create(fx.dir, { id: 'b', title: 'B', tasks: [] })
    expect(() => fx.plans.activate(fx.dir, 'a')).toThrow('only an approved plan')
    fx.plans.approve(fx.dir, 'a')
    fx.plans.approve(fx.dir, 'b')
    fx.plans.activate(fx.dir, 'a')
    fx.plans.activate(fx.dir, 'b')
    expect(fx.plans.snapshot(fx.dir).activeId).toBe('b')
    expect(fx.plans.snapshot(fx.dir).autopilot).toBeNull()
    expect(fx.orchestratorPrompts).toHaveLength(0)
  })

  it('refuses an edit on an old revision, and names the current one', () => {
    const fx = fixture()
    approvedPlan(fx)
    const revision = fx.file().revision
    expect(fx.plans.edit(fx.dir, 'p', revision, [{ op: 'update', id: 'two', fields: { title: 'Changed' } }]).revision).toBe(revision + 1)
    expect(() => fx.plans.edit(fx.dir, 'p', revision, [{ op: 'drop', id: 'two' }])).toThrow(`revision ${revision + 1}`)
  })

  it('an invalid file is reported, not overwritten', () => {
    const fx = fixture()
    approvedPlan(fx)
    writeFileSync(join(fx.dir, 'aide', 'plans', 'p.json'), '<<<<<<< HEAD')
    expect(() => fx.plans.edit(fx.dir, 'p', 1, [{ op: 'drop', id: 'two' }])).toThrow('not valid JSON')
    expect(readFileSync(join(fx.dir, 'aide', 'plans', 'p.json'), 'utf8')).toBe('<<<<<<< HEAD')
    expect(fx.plans.snapshot(fx.dir).plans[0].error).toContain('not valid JSON')
  })
})

describe('autopilot', () => {
  it('walks the plan: the Orchestrator starts each task, the commit marks it done, and the Strategist hears only the end', async () => {
    const fx = fixture()
    approvedPlan(fx)
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'finished')

    // Each task: an Orchestrator call in a new session, read-only, with the plan's prompt.
    expect(fx.orchestratorPrompts).toHaveLength(2)
    expect(fx.orchestratorPrompts[0]).toMatchObject({ permissions: 'read-only', cwd: fx.dir })
    expect(fx.orchestratorPrompts[0].resumeSessionId).toBeUndefined()
    expect(fx.orchestratorPrompts[0].systemAppend).toContain('CHECK-THIS')
    expect(fx.orchestratorPrompts[0].prompt).toContain('No step has run yet')
    expect(fx.orchestratorPrompts[1].prompt).toContain('did it')

    // Statuses go in with the work, marked by AIDE.
    expect(fx.file().tasks.map((t) => t.status)).toEqual(['done', 'done'])
    expect(fx.file().state).toBe('done')
    expect(fx.staged).toContain('aide/plans/p.json')
    expect(fx.committed[0]).toContain('Plan-Task: p/one')
    // In the message's trailer block, not a paragraph of its own.
    expect(fx.committed[0]).toContain('Co-Authored-By: X <x@y>\nPlan-Task: p/one')

    // The end of a step does not wake the Strategist; the end of the plan does.
    const kinds = pipelineEvents.since(fx.dir, null, 0).filter((e) => e.data.quiet !== true && ['run_finished', 'run_failed', 'plan_attention'].includes(e.type)).map((e) => e.type)
    expect(kinds).toEqual(['plan_attention'])
    expect(events(fx)[0]).toMatchObject({ plan: 'p', kind: 'finished' })
  })

  it('hands the task, its spec and the handoff to every step of the run', async () => {
    const fx = fixture()
    approvedPlan(fx)
    let calls = 0
    fx.decide = () => next(++calls === 2 ? { handoff: 'The handler moved.' } : {})
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'finished')
    const runs = fx.manager.runs(fx.dir)
    const second = runs[0].runId
    const amendments = fx.manager.runState(fx.dir, second)!.amendments!.map((a) => a.text)
    expect(amendments.join('\n')).toContain('The handler moved.')
    const first = fx.manager.runState(fx.dir, runs[1].runId)!.amendments!.map((a) => a.text).join('\n')
    expect(first).toContain('docs/x.md#one')
    expect(first).toContain('works')
  })

  it('a param fixed in the plan wins over the Orchestrator', async () => {
    const fx = fixture()
    approvedPlan(fx, { tasks: [{ id: 'one', title: 'First', machine: 'feature', params: { taskSpec: 'FROM-PLAN' } }] })
    fx.decide = () => ({ structured: { verdict: 'next', reason: 'ok', proposal: '', handoff: '', params: { scope: null } } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'finished')
    expect(fx.orchestratorPrompts[0].outputSchema).toMatchObject({ properties: { params: { required: ['scope'] } } })
    expect(fx.manager.report(fx.dir, fx.manager.runs(fx.dir)[0].runId)?.params).toEqual({ taskSpec: 'FROM-PLAN' })
  })

  it('wake holds the plan with the reason and proposal, and does not change the plan', async () => {
    const fx = fixture()
    approvedPlan(fx)
    const before = fx.file()
    fx.decide = () => ({ structured: { verdict: 'wake', reason: 'It splits in two', proposal: 'Split one', handoff: '', params: { taskSpec: null, scope: null } } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'wake')
    expect(attentionOf(fx)).toMatchObject({ reason: 'It splits in two', proposal: 'Split one' })
    expect(events(fx)[0]).toMatchObject({ proposal: 'Split one', task: 'one' })
    expect(fx.file()).toEqual(before)
    expect(fx.manager.runs(fx.dir)).toEqual([])

    // The Strategist answers with a note; the next Orchestrator reads it.
    fx.decide = () => next()
    await fx.plans.run(fx.dir, { note: 'One piece is fine, go on.' })
    await until(() => attentionOf(fx)?.kind === 'finished')
    expect(fx.orchestratorPrompts[1].prompt).toContain('One piece is fine, go on.')
  })

  it('a useless answer gets one retry in its session, then wakes the Strategist; only the model can say continue', async () => {
    const fx = fixture()
    approvedPlan(fx)
    fx.decide = () => ({ structured: { verdict: 'perhaps' } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'orchestrator_failed')
    expect(fx.orchestratorPrompts).toHaveLength(2)
    expect(fx.orchestratorPrompts[1].resumeSessionId).toBeTruthy()
    expect(fx.manager.runs(fx.dir)).toEqual([])
    const decision = fx.plans.snapshot(fx.dir).autopilot!.decisions
    expect(fx.plans.decisionRecord(fx.dir, 'p', decision).inputs).toHaveLength(2)
  })

  it('params that do not fit the machine count as a useless answer', async () => {
    const fx = fixture()
    approvedPlan(fx)
    fx.decide = () => ({ structured: { verdict: 'next', reason: 'ok', proposal: '', handoff: '', params: { taskSpec: null, scope: null } } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'orchestrator_failed')
    expect(attentionOf(fx)?.reason).toContain('taskSpec')
  })

  it('wakes the Strategist without a model call when the next task has no machine', async () => {
    const fx = fixture()
    approvedPlan(fx, { tasks: [{ id: 'one', title: 'First' }] })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'no_machine')
    expect(fx.orchestratorPrompts).toHaveLength(0)
  })

  it('wakes the Strategist at a checkpoint and at the unreviewed limit', async () => {
    const fx = fixture()
    approvedPlan(fx, { tasks: [{ id: 'one', title: 'First', machine: 'feature', checkpoint: true }, { id: 'two', title: 'Second', machine: 'feature' }] })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'checkpoint')
    expect(fx.orchestratorPrompts).toHaveLength(1)
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'finished')

    const limited = fixture()
    approvedPlan(limited, { orchestrator: { maxUnreviewed: 1 } })
    await limited.plans.run(limited.dir)
    await until(() => attentionOf(limited)?.kind === 'review_due')
    expect(limited.file().tasks[1].status).toBe('pending')
  })

  it('a stuck plan says what holds it', async () => {
    const fx = fixture()
    approvedPlan(fx, { tasks: [{ id: 'one', title: 'First', machine: 'feature', status: 'blocked', reason: 'no key' }] })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'stuck')
    expect(attentionOf(fx)?.reason).toContain('no key')
    expect(fx.file().state).toBe('approved')
  })

  it('shadow mode shows the decision and carries it out on plan_run, without asking again', async () => {
    const fx = fixture()
    approvedPlan(fx, { orchestrator: { shadow: true } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'shadow')
    expect(fx.manager.runs(fx.dir)).toEqual([])
    expect(events(fx)[0].decision).toMatchObject({ task: 'one' })
    await fx.plans.run(fx.dir)
    await until(() => fx.file().tasks[0].status === 'done' && attentionOf(fx)?.kind === 'shadow')
    expect(fx.orchestratorPrompts).toHaveLength(2) // one per task: the first decision was not asked again
  })

  it('shadow mode asks again when the plan changed since', async () => {
    const fx = fixture()
    approvedPlan(fx, { orchestrator: { shadow: true } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'shadow')
    fx.plans.edit(fx.dir, 'p', fx.file().revision, [{ op: 'update', id: 'one', fields: { title: 'Changed' } }])
    await fx.plans.run(fx.dir)
    await until(() => fx.orchestratorPrompts.length === 2)
    expect(fx.manager.runs(fx.dir)).toEqual([])
  })

  it('a failed commit takes the status back', async () => {
    const fx = fixture()
    approvedPlan(fx)
    fx.failRun.on = 'commit'
    await fx.plans.run(fx.dir)
    await until(() => pipelineEvents.since(fx.dir, null, 0).some((e) => e.type === 'escalation'))
    expect(fx.file().tasks[0].status).toBe('pending')
  })

  it('run_failed reaches the Strategist as the plan holding', async () => {
    const fx = fixture()
    approvedPlan(fx)
    fx.failRun.on = 'commit'
    await fx.plans.run(fx.dir)
    await until(() => pipelineEvents.since(fx.dir, null, 0).some((e) => e.type === 'escalation'))
    await fx.manager.abandon(fx.dir, 'giving up')
    await until(() => attentionOf(fx)?.kind === 'run_failed')
    expect(attentionOf(fx)?.reason).toContain('giving up')
  })

  it('does not change the task a running step works on, and holds after the step when paused', async () => {
    const fx = fixture()
    approvedPlan(fx)
    let release: () => void = () => {}
    fx.holdImplement = new Promise<void>((r) => { release = r })
    await fx.plans.run(fx.dir)
    await until(() => fx.plans.snapshot(fx.dir).autopilot?.status === 'running' && fx.manager.activeRun(fx.dir)?.state.current === 'implement')
    const revision = fx.file().revision
    expect(() => fx.plans.edit(fx.dir, 'p', revision, [{ op: 'update', id: 'one', fields: { title: 'X' } }])).toThrow('is running')
    expect(fx.plans.edit(fx.dir, 'p', revision, [{ op: 'update', id: 'two', fields: { title: 'Y' } }]).revision).toBe(revision + 1)
    await expect(fx.manager.start(fx.dir, 'feature', { taskSpec: 'x' })).rejects.toThrow('plan_pause')
    expect(fx.plans.pause(fx.dir)).toBe('after_step')
    fx.holdImplement = null
    release()
    await until(() => attentionOf(fx)?.kind === 'paused')
    expect(fx.file().tasks[0].status).toBe('done')
    expect(fx.orchestratorPrompts).toHaveLength(1)
    expect(events(fx)).toEqual([])
  })
})

describe('runs outside the plan', () => {
  it('pipeline_start without planTask touches nothing in the plan', async () => {
    const fx = fixture()
    approvedPlan(fx)
    const before = fx.file()
    const { runId } = await fx.manager.start(fx.dir, 'feature', { taskSpec: 'hotfix' })
    await until(() => fx.manager.activeRun(fx.dir)?.isFinal() === true)
    expect(fx.file()).toEqual(before)
    expect(fx.committed[0]).not.toContain('Plan-Task')
    // Its end does reach the Strategist, as it always did.
    expect(pipelineEvents.since(fx.dir, runId, 0).find((e) => e.type === 'run_finished')?.data.quiet).toBeUndefined()
    expect(fx.staged).toEqual([])
  })

  it('a run with planTask marks the task done without the autopilot, and the Strategist gets its end', async () => {
    const fx = fixture()
    approvedPlan(fx)
    const { runId } = await fx.manager.start(fx.dir, 'feature', { taskSpec: 'x' }, { planTask: { plan: 'p', task: 'two' } })
    await until(() => fx.manager.activeRun(fx.dir)?.isFinal() === true)
    expect(fx.file().tasks[1].status).toBe('done')
    expect(fx.committed[0]).toContain('Plan-Task: p/two')
    expect(pipelineEvents.since(fx.dir, runId, 0).find((e) => e.type === 'run_finished')?.data.quiet).toBeUndefined()
    expect(fx.orchestratorPrompts).toHaveLength(0)
  })

  it('refuses a link to a task that does not exist', async () => {
    const fx = fixture()
    approvedPlan(fx)
    await expect(fx.manager.start(fx.dir, 'feature', { taskSpec: 'x' }, { planTask: { plan: 'p', task: 'nope' } })).rejects.toThrow('no task "nope"')
  })

  it('a run started while the Orchestrator decides drops its call and holds the plan until plan_run', async () => {
    const fx = fixture()
    approvedPlan(fx)
    let finishDecision: (result: HeadlessResult) => void = () => {}
    const deciding = new Promise<HeadlessResult>((resolve) => { finishDecision = resolve })
    const startAgent = fx.manager.startAgent.bind(fx.manager)
    let cancelled = false
    fx.manager.startAgent = (projectPath, request) => {
      if (!request.label.includes('plan-orchestrator')) return startAgent(projectPath, request)
      return { result: deciding, cancel: async () => { cancelled = true } }
    }
    await fx.plans.run(fx.dir)
    await until(() => fx.plans.snapshot(fx.dir).autopilot?.status === 'deciding' && cancelled === false && fx.plans.snapshot(fx.dir).autopilot!.decisions === 1)
    await new Promise((r) => setTimeout(r, 5))
    await fx.manager.start(fx.dir, 'feature', { taskSpec: 'hotfix' })
    expect(cancelled).toBe(true)
    expect(attentionOf(fx)?.kind).toBe('outside_run')
    expect(events(fx)).toEqual([]) // whoever started the run knows
    finishDecision({ ok: true, sessionId: 's', structured: next().structured, finalText: null, costUsd: 0, warnings: [], error: null })
    await until(() => fx.manager.activeRun(fx.dir)?.isFinal() === true)
    await new Promise((r) => setTimeout(r, 20))
    expect(fx.manager.runs(fx.dir)).toHaveLength(1)
    expect(fx.plans.snapshot(fx.dir).autopilot?.status).toBe('held')
  })
})

describe('tools', () => {
  it('creates, approves, activates, edits and reports a plan', async () => {
    const fx = fixture()
    expect((await call(fx, 'plan_list')).text).toContain('No plans yet')
    expect((await call(fx, 'plan_guide')).text).toBe('guide')
    expect((await call(fx, 'plan_create', { id: 'p', title: 'P', tasks: [{ id: 'a', title: 'A', machine: 'feature' }] })).text).toContain('draft')
    const invalid = await call(fx, 'plan_create', { id: 'q', title: 'Q', tasks: [{ id: 'a', title: 'A', after: ['z'] }] })
    expect(invalid.isError).toBe(true)
    expect(existsSync(join(fx.dir, 'aide', 'plans', 'q.json'))).toBe(false)
    expect((await call(fx, 'plan_activate', { planId: 'p' })).isError).toBe(true)
    await call(fx, 'plan_approve', { planId: 'p' })
    await call(fx, 'plan_activate', { planId: 'p' })
    const edited = JSON.parse((await call(fx, 'plan_edit', { baseRevision: 2, ops: [{ op: 'add', task: { id: 'b', title: 'B' } }] })).text)
    expect(edited.revision).toBe(3)
    expect(edited.changed).toEqual([expect.objectContaining({ id: 'b' })])
    const status = JSON.parse((await call(fx, 'plan_status')).text)
    expect(status).toMatchObject({ id: 'p', active: true, done: 0, total: 2, next: 'a', revision: 3 })
    expect(JSON.parse((await call(fx, 'plan_get', { taskId: 'b' })).text).title).toBe('B')
    expect((await call(fx, 'plan_run')).isError).toBe(true) // no orchestrator prompt yet
  })

  it('pipeline_wait without runId covers the plan, and a timeout gives one line of state', async () => {
    const fx = fixture()
    approvedPlan(fx)
    const tick = await call(fx, 'pipeline_wait', { timeoutSec: 0.01 })
    expect(tick.text).toContain('Plan p 0/2')
    expect(tick.text).toContain('nothing needs checking')
    const waiting = call(fx, 'plan_run', { wait: 5 })
    const result = await waiting
    expect(result.text).toContain('plan_attention')
    expect(result.text).toContain('"kind":"finished"')
  })

  it('tells a waiter on a 5-minute cache to stop waiting', async () => {
    const fx = fixture()
    fx.server = new McpServer({ name: 'aide', version: '1', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: '1', launcherPath: 'x', docPath: 'd', manager: fx.manager, plans: fx.plans, cacheTtl: () => '5m' })))
    expect((await call(fx, 'pipeline_wait', { timeoutSec: 0.01 })).text).toContain('Stop waiting')
  })
})

describe('decision schema', () => {
  it('is strict: every open param required and nullable', () => {
    const schema = decisionSchema({ a: { type: 'string' }, b: { type: 'string[]', required: false } }) as { properties: { params: { required: string[]; properties: Record<string, { type: unknown }> } } }
    expect(schema.properties.params.required).toEqual(['a', 'b'])
    expect(schema.properties.params.properties.a.type).toEqual(['string', 'null'])
    expect(schema.properties.params.properties.b.type).toEqual(['array', 'null'])
  })
})

describe('remote plan view', () => {
  it('shows the tasks with their history; the brief says when the plan needs someone', async () => {
    const fx = fixture()
    approvedPlan(fx)
    expect(buildRemotePlanView({ plans: [], activeId: null, autopilot: null, journal: [] })).toBeNull()
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'finished')
    const snapshot = fx.plans.snapshot(fx.dir)
    const view = buildRemotePlanView(snapshot) as Exclude<ReturnType<typeof buildRemotePlanView>, null> & { active: { tasks: Array<{ id: string; history: Array<{ kind: string; decision?: number; runId?: string }> }> } }
    const history = view.active.tasks[0].history
    expect(history.map((h) => h.kind)).toEqual(['decision', 'run'])
    expect(history[0].decision).toBe(1)
    const runId = history[1].runId!
    // The history goes down to every step visit, and the Orchestrator's call keeps its input and answer.
    expect(fx.plans.runVisits(fx.dir, runId).map((v) => [v.node, v.agent])).toEqual([['implement', true], ['prep', true], ['commit', false]])
    const record = fx.plans.decisionRecord(fx.dir, 'p', 1)
    expect(record.inputs).toHaveLength(1)
    expect(record.decision).toMatchObject({ verdict: 'next' })
    expect(buildRemotePlanView(snapshot, { brief: true })).toEqual({ title: 'P', needsAttention: false })
  })
})

describe('the Orchestrator on escalations inside a step', () => {
  const isEscalationCall = (request: AgentRequest): boolean => JSON.stringify(request.outputSchema ?? {}).includes('"escalate"')
  const blockedOnce = (fx: Fixture): void => {
    let visits = 0
    fx.implement = () => ({ structured: { status: ++visits === 1 ? 'plan_wrong' : 'done', summary: visits === 1 ? 'The spec names a file that does not exist.' : 'did it', docsChanged: [], pipelineIssues: [] } })
  }
  const guardedPlan = (fx: Fixture, orchestrator: Record<string, unknown>): void => approvedPlan(fx, {
    orchestrator,
    tasks: [{ id: 'one', title: 'First', machine: 'guarded', spec: 'docs/x.md#one', acceptance: ['works'] }]
  })
  const escalationEvents = (fx: Fixture): Array<Record<string, unknown>> => pipelineEvents.since(fx.dir, null, 0).filter((e) => e.type === 'escalation' && e.data.quiet !== true).map((e) => e.data)

  it('answers a kind the plan lets it answer; the Strategist is not woken and the answer reaches the step', async () => {
    const fx = fixture()
    guardedPlan(fx, { escalations: ['step'] })
    blockedOnce(fx)
    const instructions: string[] = []
    fx.decide = (request) => {
      if (!isEscalationCall(request)) return next()
      return { structured: { verdict: 'answer', action: 'retry', text: 'Create the file; the spec means src/new.ts.', reason: 'The spec decides it.', proposal: '' } }
    }
    const implement = fx.implement
    fx.implement = (request) => { instructions.push(request.prompt + request.systemAppend); return implement(request) }
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'finished')

    const escalationCall = fx.orchestratorPrompts.find(isEscalationCall)!
    expect(escalationCall).toMatchObject({ permissions: 'read-only' })
    expect(escalationCall.prompt).toContain('The implementer says the task cannot be done as written.')
    expect(escalationCall.prompt).toContain('The spec names a file that does not exist.')
    // The whole plan, not just the task.
    expect(escalationCall.prompt).toContain('acceptance: works')
    expect(JSON.stringify(escalationCall.outputSchema)).not.toContain('"stop"')

    expect(escalationEvents(fx)).toEqual([])
    const state = fx.manager.runState(fx.dir, fx.manager.runs(fx.dir)[0].runId)!
    expect(state.escalations[0].answer).toMatchObject({ action: 'retry', by: 'orchestrator', text: 'Create the file; the spec means src/new.ts.' })
    expect(state.escalations[0].orchestrator).toMatchObject({ status: 'answered' })
    expect(instructions[1]).toContain('Create the file; the spec means src/new.ts.')
    const journal = fx.plans.snapshot(fx.dir).journal.filter((e) => e.kind === 'decision')
    expect(journal.map((e) => e.kind === 'decision' && e.verdict)).toEqual(['next', 'answer'])
    expect(fx.plans.snapshot(fx.dir).autopilot?.answering ?? null).toBeNull()
  })

  it('passes on what it cannot decide, with its reason and proposal', async () => {
    const fx = fixture()
    guardedPlan(fx, { escalations: ['step'] })
    blockedOnce(fx)
    fx.decide = (request) => isEscalationCall(request)
      ? { structured: { verdict: 'escalate', action: null, text: '', reason: 'The task conflicts with task two.', proposal: 'Drop the file from the spec.' } }
      : next()
    await fx.plans.run(fx.dir)
    await until(() => escalationEvents(fx).length === 1)
    expect(escalationEvents(fx)[0]).toMatchObject({ orchestrator: { status: 'escalated', reason: 'The task conflicts with task two.', proposal: 'Drop the file from the spec.' } })
    const waited = await call(fx, 'pipeline_wait', { since: 0, timeoutSec: 1 })
    expect(waited.text).toContain('passed on by the Orchestrator')

    // The Strategist answers; a wait from an older since does not get the escalation again.
    const pending = fx.manager.activeRun(fx.dir)!.pendingEscalation()!
    await call(fx, 'pipeline_answer', { escalationId: pending.id, action: 'retry', text: 'Go on without the file.' })
    await until(() => attentionOf(fx)?.kind === 'finished')
    const again = await call(fx, 'pipeline_wait', { since: 0, timeoutSec: 1 })
    expect(again.text).toContain('finished')
    expect(fx.manager.runState(fx.dir, fx.manager.runs(fx.dir)[0].runId)!.escalations[0].answer?.by).toBe('strategist')
  })

  it('in shadow mode shows the answer it would give instead of giving it', async () => {
    const fx = fixture()
    guardedPlan(fx, { escalations: ['step'], shadow: false })
    fx.plans.edit(fx.dir, 'p', fx.file().revision, [{ op: 'set', orchestrator: { cli: 'claude-code', prompt: 'CHECK-THIS', escalations: ['step'], shadow: true } }])
    blockedOnce(fx)
    fx.decide = (request) => isEscalationCall(request)
      ? { structured: { verdict: 'answer', action: 'continue', text: 'Fine as it is.', reason: 'Nothing to do.', proposal: '' } }
      : next()
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'shadow')
    await fx.plans.run(fx.dir)
    await until(() => escalationEvents(fx).length === 1)
    expect(escalationEvents(fx)[0]).toMatchObject({ orchestrator: { status: 'shadow', wouldAnswer: { action: 'continue', text: 'Fine as it is.' } } })
    expect(fx.manager.activeRun(fx.dir)!.pendingEscalation()).not.toBeNull()
  })

  it('leaves kinds the plan does not name, and decisions for the user, to them', async () => {
    const fx = fixture()
    guardedPlan(fx, { escalations: ['limit'] })
    blockedOnce(fx)
    await fx.plans.run(fx.dir)
    await until(() => escalationEvents(fx).length === 1)
    expect(fx.orchestratorPrompts.filter(isEscalationCall)).toHaveLength(0)
    expect(escalationEvents(fx)[0].orchestrator).toBeUndefined()
  })

  it('a plan attention the Strategist dealt with is not handed out again to a wait without since', async () => {
    const fx = fixture()
    approvedPlan(fx, { orchestrator: { shadow: true } })
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'shadow')
    expect((await call(fx, 'pipeline_wait', { timeoutSec: 1 })).text).toContain('shadow')
    fx.plans.pause(fx.dir)
    await fx.plans.run(fx.dir)
    await until(() => attentionOf(fx)?.kind === 'shadow' && events(fx).length === 2)
    const waited = await call(fx, 'pipeline_wait', { timeoutSec: 1 })
    // The first shadow attention was carried out; only the second one is handed out.
    expect(pipelineEvents.since(fx.dir, null, 0).filter((e) => e.type === 'plan_attention' && e.data.resolved !== true)).toHaveLength(1)
    expect(waited.text).toContain('two')
  })
})
