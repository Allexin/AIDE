import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PipelineRun, type AgentRequest, type EngineDeps } from './runner'
import { RunStore } from './runStore'
import { validateMachine } from './validate'
import type { MachineDefinition, RunState, Step } from './types'
import type { HeadlessResult } from '../headless/types'
import type { FileChange } from '../git'
import { parsePorcelain } from '../git'

const root = mkdtempSync(join(tmpdir(), 'aide-engine-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Two phases: a content loop, then an integration loop and a commit. */
const MACHINE: MachineDefinition = {
  id: 'content-and-code',
  name: 'Content and code',
  description: 'Generates content, then integrates it.',
  params: { taskSpec: { type: 'string' } },
  defaults: { cli: 'claude-code' },
  steps: [
    {
      type: 'group', id: 'content', name: 'Content',
      steps: [{
        type: 'loop', id: 'contentLoop', maxIterations: 3,
        steps: [
          { type: 'agent', id: 'generate', summary: 'generates the content', role: 'roles/generator.md', output: 'implementerReport', inputs: ['params.taskSpec'] },
          { type: 'agent', id: 'contentReview', summary: 'reviews the content', role: 'roles/reviewer.md', permissions: 'read-only', session: 'new', output: 'reviewVerdict', repeatIf: "outputs.contentReview.verdict != 'accept'" }
        ]
      }]
    },
    {
      type: 'group', id: 'integration', name: 'Integration',
      steps: [
        {
          type: 'loop', id: 'build', maxIterations: 3,
          steps: [
            { type: 'agent', id: 'implement', summary: 'integrates the content', role: 'roles/implementer.md', output: 'implementerReport', inputs: ['params.taskSpec'], escalateIf: "outputs.implement.status != 'done'", escalateMessage: 'The implementer cannot do the task as specified.' },
            { type: 'check', id: 'checks', command: 'npm test' },
            { type: 'agent', id: 'review', summary: 'a separate reviewer inspects the diff', role: 'roles/reviewer.md', permissions: 'read-only', session: 'new', output: 'reviewVerdict', inputs: ['run.diff'], repeatIf: "outputs.review.verdict != 'accept'" }
          ]
        },
        {
          type: 'commit', id: 'commit', review: 'algorithmic',
          prep: { type: 'agent', id: 'commitPrep', summary: 'stages the change and writes the commit message', role: 'roles/implementer.md', session: 'continue:implement', output: 'commitPrep' }
        }
      ]
    }
  ]
}

interface Script {
  agent: (request: AgentRequest, call: number) => Partial<HeadlessResult> & { structured?: unknown }
  check?: (call: number) => { exitCode: number; output: string } | 'hang'
  status?: () => FileChange[]
}

function harness(script: Script, machine: MachineDefinition = MACHINE, params: Record<string, unknown> = { taskSpec: 'Add feature X' }) {
  const requests: AgentRequest[] = []
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const commits: string[] = []
  let agentCalls = 0
  let checkCalls = 0
  let sessionCounter = 0
  const deps: EngineDeps = {
    startAgent: (request) => {
      requests.push(request)
      const call = agentCalls++
      const scripted = script.agent(request, call)
      const sessionId = request.resumeSessionId ?? `session-${++sessionCounter}`
      request.onSessionId?.(sessionId)
      const result: HeadlessResult = { ok: true, sessionId, structured: null, finalText: null, costUsd: 0.01, warnings: [], error: null, ...scripted }
      return { result: Promise.resolve(result), cancel: async () => {} }
    },
    runCheck: (options) => {
      const call = checkCalls++
      const scripted = script.check?.(call) ?? { exitCode: 0, output: 'all good' }
      if (scripted === 'hang') {
        let resolveDone: (value: { exitCode: null; signal: null; timedOut: boolean; cancelled: boolean; spawnError: null; stdoutTail: string; stderrTail: string }) => void = () => {}
        const done = new Promise<Parameters<typeof resolveDone>[0]>((r) => { resolveDone = r })
        return { pid: 1, done, cancel: async () => { resolveDone({ exitCode: null, signal: null, timedOut: false, cancelled: true, spawnError: null, stdoutTail: '', stderrTail: '' }) } }
      }
      options.onOutput(scripted.output)
      return { pid: 1, done: Promise.resolve({ exitCode: scripted.exitCode, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: scripted.output, stderrTail: '' }), cancel: async () => {} }
    },
    git: {
      workingDiff: async () => 'diff --git a/x b/x\n+line',
      stagedDiff: async () => 'staged diff',
      status: async () => script.status?.() ?? parsePorcelain('M  src/a.ts\0'),
      headSha: async () => 'base-sha',
      commitIndex: async (_cwd, message) => { commits.push(message); return { sha: `sha-${commits.length}`, files: ['src/a.ts'], message } }
    },
    readRole: (_dir, rolePath) => `ROLE ${rolePath}`,
    emit: (_runId, type, data) => { events.push({ type, data }) }
  }
  const store = new RunStore(join(root, `runs-${Math.random().toString(36).slice(2)}`))
  const run = PipelineRun.create({ machine, machineDir: root }, params, 'run-1', root, store, deps)
  const labels = (): string[] => requests.map((r) => r.label.replace('claude-code:', ''))
  return { run, requests, events, commits, store, labels, state: (): RunState => run.state }
}

const done = { structured: { status: 'done', summary: 'implemented', docsChanged: [] } }
const planWrong = { structured: { status: 'plan_wrong', summary: 'the spec contradicts itself', docsChanged: [] } }
const accept = { structured: { verdict: 'accept', blocking: [], non_blocking: ['rename foo'], summary: 'ok' } }
const reject = { structured: { verdict: 'reject', blocking: ['missing null check'], non_blocking: [], summary: 'no' } }
const prep = { structured: { commitMessage: 'Add feature X', excluded: [] } }

/** Accepts every review and prepares a plain commit. */
function happy(req: AgentRequest): Partial<HeadlessResult> {
  if (req.label.endsWith('Review') || req.label.endsWith(':review')) return accept
  if (req.label.endsWith(':commitPrep')) return prep
  return done
}

describe('machine fixture', () => {
  it('is valid', () => {
    expect(validateMachine(MACHINE, { headlessClis: ['claude-code', 'codex'], roleExists: () => true })).toEqual({ errors: [], warnings: [] })
  })
})

describe('PipelineRun', () => {
  it('runs both phases top to bottom to a commit and a success report', async () => {
    const h = harness({ agent: happy })
    await h.run.run()
    expect(h.state().status).toBe('finished')
    expect(h.state().result).toBe('success')
    expect(h.labels()).toEqual(['generate', 'contentReview', 'implement', 'review', 'commitPrep'])
    expect(h.commits).toEqual(['Add feature X'])
    expect(h.events[h.events.length - 1].type).toBe('run_finished')
    const report = h.store.readReport('run-1') as { nonBlockingFindings: string[]; commits: Array<{ sha: string }> }
    expect(report.nonBlockingFindings).toEqual(['rename foo', 'rename foo'])
    expect(report.commits.map((c) => c.sha)).toEqual(['sha-1'])
  })

  it('gives each agent its role, the step tree with its position, and what comes later', async () => {
    const h = harness({ agent: happy })
    await h.run.run()
    const implement = h.requests.find((r) => r.label.endsWith(':implement'))!
    const review = h.requests.find((r) => r.label.endsWith(':review'))!
    const commitPrep = h.requests.find((r) => r.label.endsWith(':commitPrep'))!
    expect(implement.systemAppend).toContain('ROLE roles/implementer.md')
    expect(implement.systemAppend).toContain([
      '- Content',
      '  - loop contentLoop (repeats until a pass completes, at most 3 iterations)',
      '    1. generate [agent] — generates the content',
      '    2. contentReview [agent] — reviews the content; repeats "contentLoop" if verdict is not "accept"',
      '- Integration',
      '  - loop build (repeats until a pass completes, at most 3 iterations) — now on iteration 1',
      '    3. implement [agent] — integrates the content; stops for a decision if status is not "done"   ← YOU ARE HERE',
      '    4. checks [AIDE] — AIDE runs `npm test`; a failure repeats "build"'
    ].join('\n'))
    expect(implement.systemAppend).toContain('AIDE itself runs these checks later: `npm test`')
    expect(implement.systemAppend).toContain('Staging and committing happen in a later step. Do not stage or commit.')
    expect(implement.systemAppend).toContain('You are inside a loop')
    expect(implement.prompt).toContain('Add feature X')
    // The reviewer comes after the checks, but a repeat runs them again — it is still told not to run them.
    expect(review.systemAppend).toContain('AIDE itself runs these checks later')
    expect(review.permissions).toBe('read-only')
    expect(review.prompt).toContain('+line')
    expect(commitPrep.systemAppend).toContain('You prepare the commit')
    expect(commitPrep.resumeSessionId).toBe('session-3')
    expect(commitPrep.prompt).toContain('# New step: commitPrep')
    expect(implement.prompt).not.toContain('# New step')
  })

  it('repeats a loop on a rejected review, feeding the findings back and keeping the implementer session', async () => {
    let reviews = 0
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? (++reviews < 3 ? reject : accept) : happy(req) })
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.labels()).toEqual(['generate', 'contentReview', 'implement', 'review', 'implement', 'review', 'implement', 'review', 'commitPrep'])
    const implementVisits = h.requests.filter((r) => r.label.endsWith(':implement'))
    expect(implementVisits[0].resumeSessionId).toBeUndefined()
    expect(implementVisits[1].resumeSessionId).toBe('session-3')
    expect(implementVisits[1].prompt).toContain('## Feedback: this is iteration 2 of loop "build"')
    expect(implementVisits[1].prompt).toContain('missing null check')
    // session "new": every review starts fresh.
    expect(h.requests.filter((r) => r.label.endsWith(':review')).every((r) => r.resumeSessionId === undefined)).toBe(true)
    expect(h.events.filter((e) => e.type === 'loop_repeated').map((e) => e.data.iteration)).toEqual([2, 3])
  })

  it('repeats the loop on a failed check, skipping the rest of the iteration', async () => {
    const h = harness({ agent: happy, check: (call) => call === 0 ? { exitCode: 1, output: 'TypeError at a.ts:3' } : { exitCode: 0, output: 'ok' } })
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.labels()).toEqual(['generate', 'contentReview', 'implement', 'implement', 'review', 'commitPrep'])
    expect(h.requests[3].prompt).toContain('the check "checks" (`npm test`) failed')
    expect(h.requests[3].prompt).toContain('TypeError at a.ts:3')
    expect(h.events.map((e) => e.type)).toContain('check_failed')
  })

  it('escalates when a loop runs out of iterations; retry grants one more, stop ends the run', async () => {
    let reviews = 0
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? (++reviews <= 3 ? reject : accept) : happy(req) })
    await h.run.run()
    expect(h.state().status).toBe('waiting')
    const limit = h.run.pendingEscalation()!
    expect(limit).toMatchObject({ node: 'build', kind: 'limit' })
    expect(limit.message).toContain('did not pass in 3 iterations')
    expect(limit.message).toContain('missing null check')
    await h.run.answer(limit.id, { action: 'retry', text: 'one more try', by: 'orchestrator' })
    await waitFor(() => h.run.isFinal())
    expect(h.state().result).toBe('success')
    expect(h.state().iterations.build).toBe(4)

    const stuck = harness({ agent: (req) => req.label.endsWith(':review') ? reject : happy(req) })
    await stuck.run.run()
    await stuck.run.answer(stuck.run.pendingEscalation()!.id, { action: 'stop', text: 'give up', by: 'orchestrator' })
    expect(stuck.state().status).toBe('failed')
  })

  it('continue leaves an exhausted loop as if it passed', async () => {
    const h = harness({ agent: (req) => req.label.endsWith('contentReview') ? reject : happy(req) })
    await h.run.run()
    const limit = h.run.pendingEscalation()!
    expect(limit).toMatchObject({ node: 'contentLoop', kind: 'limit' })
    await h.run.answer(limit.id, { action: 'continue', text: 'good enough', by: 'user' })
    await waitFor(() => h.run.isFinal())
    expect(h.state().result).toBe('success')
    // Later agents see the decision.
    expect(h.requests.find((r) => r.label.endsWith(':implement'))!.systemAppend).toContain('Decision by the user at "contentLoop" (continue): good enough')
  })

  it('escalates on escalateIf; continue goes on, stop ends the run', async () => {
    const h = harness({ agent: (req) => req.label.endsWith(':implement') ? planWrong : happy(req) })
    await h.run.run()
    const escalation = h.run.pendingEscalation()!
    expect(escalation).toMatchObject({ node: 'implement', kind: 'step' })
    expect(escalation.message).toContain('The implementer cannot do the task as specified.')
    expect(escalation.message).toContain('the spec contradicts itself')
    await h.run.answer(escalation.id, { action: 'continue', text: 'proceed anyway', by: 'orchestrator' })
    await waitFor(() => h.run.isFinal() || h.state().status === 'waiting')
    expect(h.labels().slice(2)).toEqual(['implement', 'review', 'commitPrep'])

    const stopped = harness({ agent: (req) => req.label.endsWith(':implement') ? planWrong : happy(req) })
    await stopped.run.run()
    await stopped.run.answer(stopped.run.pendingEscalation()!.id, { action: 'stop', text: 'drop it', by: 'orchestrator' })
    expect(stopped.state().result).toBe('failure')
  })

  it('raises an engine escalation on agent failure and retries on answer', async () => {
    let first = true
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && first) { first = false; return { ok: false, error: { code: 'limit', message: 'usage limit reached' } } }
      return happy(req)
    } })
    await h.run.run()
    const escalation = h.run.pendingEscalation()!
    expect(escalation).toMatchObject({ node: 'implement', kind: 'engine' })
    expect(escalation.message).toContain('usage limit')
    expect(h.state().visits.implement).toBe(0)
    await h.run.answer(escalation.id, { action: 'retry', text: 'limits reset', by: 'user' })
    await waitFor(() => h.state().status === 'finished')
    expect(h.state().visits.implement).toBe(1)
  })

  it('asks once more for a schema-valid answer before escalating', async () => {
    let calls = 0
    const h = harness({ agent: (req) => req.label.endsWith(':generate') ? (++calls === 1 ? { structured: { status: 'finished' } } : done) : happy(req) })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const retry = h.requests[1]
    expect(retry.label).toBe('claude-code:generate')
    expect(retry.prompt).toContain('did not match the required output schema')
    expect(retry.resumeSessionId).toBe('session-1')
  })

  it('pauses after the current step and resumes', async () => {
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement')) h.run.pause()
      return happy(req)
    } })
    await h.run.run()
    expect(h.state().status).toBe('paused')
    expect(h.state().current).toBe('checks')
    expect(h.events.map((e) => e.type)).toContain('run_paused')
    await h.run.run()
    expect(h.state().result).toBe('success')
  })

  it('stop interrupts the running step; resuming re-runs it', async () => {
    let hang = true
    const h = harness({ agent: happy, check: () => hang ? 'hang' : { exitCode: 0, output: 'ok' } })
    const loop = h.run.run()
    await waitFor(() => h.state().current === 'checks' && h.state().history.some((v) => v.node === 'checks'))
    await h.run.stop()
    await loop
    expect(h.state().status).toBe('stopped')
    expect(h.state().history.find((v) => v.node === 'checks')?.outcome).toBe('interrupted')
    expect(h.state().visits.checks).toBe(0)
    hang = false
    await h.run.run()
    expect(h.state().result).toBe('success')
  })

  it('sends commit problems back to the prep agent, which continues its own session', async () => {
    let preps = 0
    const h = harness({
      agent: (req) => req.label.endsWith(':commitPrep')
        ? (++preps === 1 ? { structured: { commitMessage: 'msg', excluded: [] } } : { structured: { commitMessage: 'msg', excluded: [{ path: 'debug.log', reason: 'local log' }] } })
        : happy(req),
      status: () => parsePorcelain('M  src/a.ts\0?? debug.log\0')
    })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const [first, second] = h.requests.filter((r) => r.label.endsWith(':commitPrep'))
    expect(second.prompt).toContain('## Feedback: this is attempt 2 of commit "commit"')
    expect(second.prompt).toContain('debug.log is untracked')
    expect(second.resumeSessionId).toBe(first.resumeSessionId)
    expect(h.state().iterations.commit).toBe(2)
  })

  it('repeatLoop sends control back to an enclosing outer loop and resets the inner loops', async () => {
    const steps: Step[] = [{
      type: 'loop', id: 'all', maxIterations: 2,
      steps: [
        { type: 'loop', id: 'contentLoop', maxIterations: 2, steps: [{ type: 'agent', id: 'generate', summary: 'generates', role: 'r.md', output: 'implementerReport' }, { type: 'check', id: 'validate', command: 'validate' }] },
        { type: 'agent', id: 'integrate', summary: 'integrates', role: 'r.md', output: 'reviewVerdict', repeatIf: "outputs.integrate.verdict != 'accept'", repeatLoop: 'all' }
      ]
    }]
    const machine: MachineDefinition = { ...MACHINE, id: 'nested', steps }
    expect(validateMachine(machine, { headlessClis: ['claude-code'], roleExists: () => true }).errors).toEqual([])
    let integrations = 0
    const h = harness({
      agent: (req) => req.label.endsWith(':integrate') ? (++integrations === 1 ? reject : accept) : done,
      check: (call) => call === 0 ? { exitCode: 1, output: 'bad asset' } : { exitCode: 0, output: 'ok' }
    }, machine)
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.labels()).toEqual(['generate', 'generate', 'integrate', 'generate', 'integrate'])
    const regenerate = h.requests[3]
    expect(regenerate.prompt).toContain('## Feedback: this is iteration 2 of loop "all"')
    expect(regenerate.prompt).toContain('missing null check')
    // The inner loop started over: its old feedback is gone.
    expect(regenerate.prompt).not.toContain('bad asset')
    expect(h.state().iterations).toMatchObject({ all: 2, contentLoop: 1 })
  })

  it('a repeat step inside an if starts an outer loop over with the tested output', async () => {
    const contentWrong = { type: 'object', additionalProperties: false, required: ['verdict', 'summary'], properties: { verdict: { type: 'string', enum: ['accept', 'reject', 'content_wrong'] }, summary: { type: 'string' } } }
    const steps: Step[] = [{
      type: 'loop', id: 'whole', maxIterations: 2,
      steps: [
        { type: 'agent', id: 'generate', summary: 'generates', role: 'r.md', output: 'implementerReport' },
        { type: 'loop', id: 'build', maxIterations: 3, steps: [
          { type: 'agent', id: 'implement', summary: 'integrates', role: 'r.md', output: 'implementerReport' },
          { type: 'agent', id: 'review', summary: 'reviews', role: 'r.md', output: 'integrationVerdict', repeatIf: "outputs.review.verdict == 'reject'" }
        ] },
        { type: 'if', id: 'contentProblem', condition: "outputs.review.verdict == 'content_wrong'", then: [{ type: 'repeat', id: 'backToContent', loop: 'whole', reason: 'the integration review found problems in the content' }] }
      ]
    }]
    const machine: MachineDefinition = { ...MACHINE, id: 'back', schemas: { integrationVerdict: contentWrong }, steps }
    expect(validateMachine(machine, { headlessClis: ['claude-code'], roleExists: () => true })).toEqual({ errors: [], warnings: [] })
    const verdicts = ['reject', 'content_wrong', 'accept']
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? { structured: { verdict: verdicts.shift(), summary: 'sprite sizes are wrong' } } : done }, machine)
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.labels()).toEqual(['generate', 'implement', 'review', 'implement', 'review', 'generate', 'implement', 'review'])
    expect(h.requests[5].prompt).toContain('## Feedback: this is iteration 2 of loop "whole"')
    expect(h.requests[5].prompt).toContain('the integration review found problems in the content')
    expect(h.requests[5].prompt).toContain('sprite sizes are wrong')
    expect(h.state().iterations).toMatchObject({ whole: 2, build: 1 })
  })

  it('takes an if branch by its condition', async () => {
    const steps: Step[] = [
      { type: 'if', id: 'maybeReview', condition: 'params.review == true', then: [{ type: 'agent', id: 'review', summary: 'reviews', role: 'r.md', output: 'reviewVerdict' }], else: [{ type: 'check', id: 'quick', command: 'lint' }] },
      { type: 'agent', id: 'finish', summary: 'finishes', role: 'r.md', output: 'implementerReport' }
    ]
    const machine: MachineDefinition = { ...MACHINE, id: 'branchy', params: { review: { type: 'boolean' } }, steps }
    const yes = harness({ agent: (req) => req.label.endsWith(':review') ? accept : done }, machine, { review: true })
    await yes.run.run()
    expect(yes.labels()).toEqual(['review', 'finish'])
    const no = harness({ agent: () => done }, machine, { review: false })
    await no.run.run()
    expect(no.labels()).toEqual(['finish'])
    expect(no.state().history.map((v) => v.node)).toEqual(['quick', 'finish'])
  })

  it('gates: approval goes on; rejection repeats the loop with the answer, or fails the run outside loops', async () => {
    const steps: Step[] = [
      { type: 'loop', id: 'draft', maxIterations: 3, steps: [{ type: 'agent', id: 'write', summary: 'writes', role: 'r.md', output: 'implementerReport' }, { type: 'gate', id: 'approveDraft', question: 'Is the draft good?', to: 'user' }] },
      { type: 'gate', id: 'ship', question: 'Ship it?' }
    ]
    const machine: MachineDefinition = { ...MACHINE, id: 'gated', steps }
    const h = harness({ agent: () => done }, machine)
    await h.run.run()
    await h.run.answer(h.run.pendingEscalation()!.id, { action: 'reject', text: 'make it shorter', by: 'user' })
    await waitFor(() => h.state().status === 'waiting' && h.requests.length === 2)
    expect(h.requests[1].prompt).toContain('make it shorter')
    await h.run.answer(h.run.pendingEscalation()!.id, { action: 'continue', text: '', by: 'user' })
    await waitFor(() => h.run.pendingEscalation()?.node === 'ship')
    await h.run.answer(h.run.pendingEscalation()!.id, { action: 'reject', text: 'not now', by: 'orchestrator' })
    expect(h.state().result).toBe('failure')
    expect(h.state().history.filter((v) => v.node === 'approveDraft').map((v) => v.outcome)).toEqual(['fail', 'ok'])
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
