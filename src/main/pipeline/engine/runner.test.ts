import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PipelineRun, UNAVAILABLE_RETRY_MS, type AgentRequest, type EngineDeps } from './runner'
import { rootSetup, type GitSetup } from '../gitConfig'
import { RunStore } from './runStore'
import { isSignificant } from '../events'
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
  engineVersion: 6,
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
  agent: (request: AgentRequest, call: number) => (Partial<HeadlessResult> & { structured?: unknown }) | 'hang'
  check?: (call: number) => { exitCode: number; output: string } | 'hang'
  status?: () => FileChange[]
  /** The account pool handles this CLI's usage limits. */
  pool?: boolean
}

function harness(script: Script, machine: MachineDefinition = MACHINE, params: Record<string, unknown> = { taskSpec: 'Add feature X' }) {
  const requests: AgentRequest[] = []
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const commits: string[] = []
  const commands: string[] = []
  const checkOutput: string[] = []
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
      if (scripted === 'hang') {
        let cancel: () => void = () => {}
        const result = new Promise<HeadlessResult>((resolve) => { cancel = () => resolve({ ok: false, sessionId, structured: null, finalText: null, costUsd: null, warnings: [], error: { code: 'cancelled', message: 'cancelled' } }) })
        return { result, cancel: async () => cancel() }
      }
      const result: HeadlessResult = { ok: true, sessionId, structured: null, finalText: null, costUsd: 0.01, warnings: [], error: null, ...scripted }
      return { result: Promise.resolve(result), cancel: async () => {} }
    },
    runCheck: (options) => {
      const call = checkCalls++
      commands.push(options.commandLine)
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
    emit: (_runId, type, data) => { events.push({ type, data }) },
    accountPool: () => script.pool === true,
    // Records the output with what the check log held when it was announced.
    onCheckOutput: (runId, node, visit, text) => { checkOutput.push(`${node}#${visit} ${text} (log: ${store.readCheckLog(runId, node, visit)})`) }
  }
  const store = new RunStore(join(root, `runs-${Math.random().toString(36).slice(2)}`))
  const run = PipelineRun.create({ machine, machineDir: root }, params, 'run-1', root, store, deps)
  const labels = (): string[] => requests.map((r) => r.label.replace('claude-code:', ''))
  return { run, requests, events, commits, commands, checkOutput, store, labels, state: (): RunState => run.state }
}

const done = { structured: { status: 'done', summary: 'implemented', docsChanged: [], pipelineIssues: [] } }
const planWrong = { structured: { status: 'plan_wrong', summary: 'the spec contradicts itself', docsChanged: [], pipelineIssues: [] } }
const accept = { structured: { verdict: 'accept', blocking: [], non_blocking: ['rename foo'], summary: 'ok', pipelineIssues: [] } }
const reject = { structured: { verdict: 'reject', blocking: ['missing null check'], non_blocking: [], summary: 'no', pipelineIssues: [] } }
const prep = { structured: { commitMessage: 'Add feature X', excluded: [], pipelineIssues: [] } }

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
  it('announces check output after appending it to the check log', async () => {
    const h = harness({ agent: happy, check: () => ({ exitCode: 0, output: 'tests passed' }) })
    await h.run.run()
    expect(h.checkOutput).toEqual(['checks#1 tests passed (log: tests passed)'])
  })

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

  it('reports each check by its last result and how often it ran', async () => {
    const h = harness({ agent: happy, check: (call) => call === 0 ? { exitCode: 1, output: 'FAIL a.test' } : { exitCode: 0, output: 'ok' } })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const report = h.store.readReport('run-1') as { checks: unknown }
    expect(report.checks).toEqual([{ node: 'checks', command: 'npm test', passed: true, runs: 2 }])
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
    expect(implement.systemAppend).toContain('You are inside a loop: it starts over only when a later step reports a problem, and the steps then get that problem as feedback.')
    expect(implement.systemAppend).toContain('Time limit of this step: 60 minutes.')
    // Behaviour comes from the role file, not from AIDE.
    for (const advice of ['implement all of them', 'Finish your whole task', 'say so in "pipelineIssues"', 'easy to continue']) expect(implement.systemAppend).not.toContain(advice)
    expect(implement.prompt).toContain('Add feature X')
    // The reviewer comes after the checks, but a repeat runs them again — it is still told not to run them.
    expect(review.systemAppend).toContain('AIDE itself runs these checks later')
    expect(implement.systemAppend).toContain('Do not run them to verify your finished work')
    expect(implement.systemAppend).toContain('building and running the tests you add or change is fine; run a whole check yourself only when your task or a decision explicitly asks for it.')
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
    expect(h.requests[3].prompt).toMatch(/Full log: .*checks-1\.log/)
  })

  it('feeds back the failure lines of the whole log, not only its tail', async () => {
    const log = ['running 120 tests', 'test map::tests::load ... FAILED', ...Array.from({ length: 2000 }, (_, i) => `test ok_${i} ... ok`), 'failures:', '    map::tests::load', 'test result: FAILED. 119 passed; 1 failed'].join('\n')
    const h = harness({ agent: happy, check: (call) => call === 0 ? { exitCode: 101, output: log } : { exitCode: 0, output: 'ok' } })
    await h.run.run()
    const feedback = h.requests[3].prompt
    expect(feedback).toContain('Exit code 101.')
    expect(feedback).toContain('Failure lines from the log:\ntest map::tests::load ... FAILED\nfailures:\ntest result: FAILED. 119 passed; 1 failed')
  })

  it('tells later steps the current results of the pass and marks feedback the pass has answered as superseded', async () => {
    let reviews = 0
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? (++reviews === 1 ? accept : accept) : happy(req), check: (call) => call === 0 ? { exitCode: 1, output: 'TypeError' } : { exitCode: 0, output: 'ok' } })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const review = h.requests.find((r) => r.label.endsWith(':review'))!
    expect(review.systemAppend).toContain('- Results so far in this pass: implement: done, checks passed.')
    expect(review.prompt).toContain('## Feedback: this is iteration 2 of loop "build"')
    expect(review.prompt).toContain('Superseded: "checks" has run again in this pass (outcome: passed).')
    // The implementer of the same pass gets the feedback as current.
    expect(h.requests[3].prompt).not.toContain('Superseded')
  })

  it('check commands use params, shell-quoted', async () => {
    const steps: Step[] = [
      { type: 'check', id: 'captures', command: 'cargo xtask captures --stage {{params.stageId}} --cases {{params.cases}}' },
      { type: 'agent', id: 'finish', summary: 'finishes', role: 'r.md', output: 'implementerReport' }
    ]
    const machine: MachineDefinition = { ...MACHINE, id: 'templated', params: { stageId: { type: 'string' }, cases: { type: 'string[]' } }, steps }
    expect(validateMachine(machine, { headlessClis: ['claude-code'], roleExists: () => true }).errors).toEqual([])
    const h = harness({ agent: () => done }, machine, { stageId: 'S5.5', cases: ['ui/build menu', 'rig'] })
    await h.run.run()
    const quoted = process.platform === 'win32' ? '"ui/build menu"' : "'ui/build menu'"
    expect(h.commands).toEqual([`cargo xtask captures --stage S5.5 --cases ${quoted} rig`])
    expect(h.store.readOutput('run-1', 'captures', 1)).toMatchObject({ command: h.commands[0] })
  })

  it('run.iteration in an if is the iteration of the innermost loop around the if', async () => {
    const steps: Step[] = [{
      type: 'loop', id: 'outer', maxIterations: 3,
      steps: [
        { type: 'agent', id: 'make', summary: 'makes', role: 'r.md', output: 'implementerReport' },
        { type: 'loop', id: 'ciLoop', maxIterations: 3, steps: [
          { type: 'if', id: 'notFirst', condition: 'run.iteration != 1', then: [{ type: 'agent', id: 'fix', summary: 'fixes', role: 'r.md', output: 'implementerReport' }] },
          { type: 'check', id: 'ci', command: 'ci' }
        ] },
        { type: 'agent', id: 'judge', summary: 'judges', role: 'r.md', output: 'reviewVerdict', repeatIf: "outputs.judge.verdict != 'accept'" }
      ]
    }]
    const machine: MachineDefinition = { ...MACHINE, id: 'nestedIf', steps }
    expect(validateMachine(machine, { headlessClis: ['claude-code'], roleExists: () => true }).errors).toEqual([])
    let judged = 0
    const h = harness({
      agent: (req) => req.label.endsWith(':judge') ? (++judged === 1 ? reject : accept) : done,
      check: (call) => call === 1 ? { exitCode: 1, output: 'fail' } : { exitCode: 0, output: 'ok' }
    }, machine)
    await h.run.run()
    expect(h.state().result).toBe('success')
    // outer 1: make, ci ok, judge rejects. outer 2: make, ci (first pass: no fix) fails, fix, ci ok, judge.
    expect(h.state().history.map((v) => v.node)).toEqual(['make', 'ci', 'judge', 'make', 'ci', 'fix', 'ci', 'judge'])
  })

  it('reloads an edited machine between steps, keeping the position; refuses when the run state no longer fits', async () => {
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement')) h.run.pause()
      return happy(req)
    } })
    await h.run.run()
    expect(h.state()).toMatchObject({ status: 'paused', current: 'checks' })
    const edited = JSON.parse(JSON.stringify(MACHINE)) as MachineDefinition
    const build = (edited.steps[1] as { steps: Step[] }).steps[0] as { steps: Array<{ command?: string }> }
    build.steps[1].command = 'npm test -- --bail'
    expect(h.run.reload({ machine: edited, machineDir: root })).toEqual([])
    const broken = { ...MACHINE, steps: [MACHINE.steps[0]] }
    expect(h.run.reload({ machine: broken, machineDir: root }).join('\n')).toMatch(/"checks" is part of the run's state but is no longer in the machine/)
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.commands).toEqual(['npm test -- --bail'])
  })

  it('a run stopped while an escalation is open asks for the answer again on resume', async () => {
    const h = harness({ agent: (req) => req.label.endsWith(':implement') ? planWrong : happy(req) })
    await h.run.run()
    const escalation = h.run.pendingEscalation()!
    await h.run.stop()
    expect(h.state().status).toBe('stopped')
    await h.run.run()
    expect(h.state().status).toBe('waiting')
    expect(h.labels().filter((l) => l === 'implement')).toHaveLength(1)
    expect(h.events.filter((e) => e.type === 'escalation').at(-1)!.data.escalationId).toBe(escalation.id)
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
    await h.run.answer(limit.id, { action: 'retry', text: 'one more try', by: 'strategist' })
    await waitFor(() => h.run.isFinal())
    expect(h.state().result).toBe('success')
    expect(h.state().iterations.build).toBe(4)
    const fourth = h.requests.filter((r) => r.label.endsWith(':implement'))[3]
    expect(fourth.systemAppend).toContain('loop build (repeats until a pass completes, at most 4 iterations) — now on iteration 4')
    expect(fourth.systemAppend).toContain('iteration 4 of at most 4')

    const stuck = harness({ agent: (req) => req.label.endsWith(':review') ? reject : happy(req) })
    await stuck.run.run()
    await stuck.run.answer(stuck.run.pendingEscalation()!.id, { action: 'stop', text: 'give up', by: 'strategist' })
    expect(stuck.state().status).toBe('failed')
  })

  it('keeps events compact: no logs in them, escalations clipped with the allowed actions and a pointer to the details', async () => {
    const longLog = 'E'.repeat(20_000)
    const h = harness({ agent: happy, check: () => ({ exitCode: 1, output: longLog }) })
    await h.run.run()
    const failed = h.events.find((e) => e.type === 'check_failed')!
    expect(failed.data).toEqual({ node: 'checks', visit: 1, summary: 'check checks failed (visit 1)' })
    const escalation = h.events.find((e) => e.type === 'escalation')!.data
    expect(escalation).toMatchObject({ kind: 'limit', node: 'build', actions: ['retry', 'continue', 'stop'], source: { step: 'checks', visit: 3 }, more: 'pipeline_output step "checks" visit 3' })
    expect(String(escalation.message).length).toBeLessThan(1300)
    expect(JSON.stringify(h.events).length).toBeLessThan(6000)
    // The full message stays in the run state for the run view.
    expect(h.run.pendingEscalation()!.message.length).toBeGreaterThan(2000)
    expect(h.store.readOutput('run-1', 'checks', 2)).toMatchObject({ exitCode: 1 })
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
    await h.run.answer(escalation.id, { action: 'continue', text: 'proceed anyway', by: 'strategist' })
    await waitFor(() => h.run.isFinal() || h.state().status === 'waiting')
    expect(h.labels().slice(2)).toEqual(['implement', 'review', 'commitPrep'])

    const stopped = harness({ agent: (req) => req.label.endsWith(':implement') ? planWrong : happy(req) })
    await stopped.run.run()
    await stopped.run.answer(stopped.run.pendingEscalation()!.id, { action: 'stop', text: 'drop it', by: 'strategist' })
    expect(stopped.state().result).toBe('failure')
  })

  it('a retry ordered on an escalated step runs it again in the same iteration of its loop', async () => {
    let implementVisits = 0
    const h = harness({ agent: (req) => req.label.endsWith(':implement') ? (++implementVisits === 1 ? planWrong : done) : req.label.endsWith(':review') ? (implementVisits < 4 ? reject : accept) : happy(req) })
    await h.run.run()
    await h.run.answer(h.run.pendingEscalation()!.id, { action: 'retry', text: 'do it as written', by: 'strategist' })
    await waitFor(() => h.run.isFinal() || h.state().status === 'waiting')
    // Iteration 1: the escalated visit and its retry; iterations 2 and 3: one visit each; the third review accepts.
    expect(h.labels().filter((l) => l === 'implement' || l === 'review')).toEqual(['implement', 'implement', 'review', 'implement', 'review', 'implement', 'review'])
    expect(h.state().result).toBe('success')
  })

  it('raises an engine escalation on agent failure; retry continues the failed session without resending the task', async () => {
    let first = true
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && first) { first = false; return { ok: false, error: { code: 'failed', message: 'stream disconnected' } } }
      return happy(req)
    } })
    await h.run.run()
    const escalation = h.run.pendingEscalation()!
    expect(escalation).toMatchObject({ node: 'implement', kind: 'engine' })
    expect(escalation.message).toContain('stream disconnected')
    expect(h.state().visits.implement).toBe(0)
    await h.run.answer(escalation.id, { action: 'retry', text: 'transient', by: 'user' })
    await waitFor(() => h.state().status === 'finished')
    expect(h.state().visits.implement).toBe(1)
    const [failed, retried] = h.requests.filter((r) => r.label.endsWith(':implement'))
    expect(retried.resumeSessionId).toBe(failed.resumeSessionId ?? 'session-3')
    expect(retried.prompt).toContain('ended with an error (claude-code failed (failed): stream disconnected)')
    expect(retried.prompt).toContain('do not redo it')
    expect(retried.prompt).not.toContain('Add feature X')
  })

  it('holds the run on a CLI usage limit, keeps the session, and resumes in it', async () => {
    let first = true
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && first) { first = false; return { ok: false, error: { code: 'limit', message: "You've hit your usage limit. Try again in 2 hours." } } }
      return happy(req)
    } })
    await h.run.run()
    expect(h.state().status).toBe('stopped')
    expect(h.run.pendingEscalation()).toBeNull()
    const stopped = h.events.find((e) => e.type === 'run_stopped')!.data
    expect(stopped).toMatchObject({ node: 'implement', reason: 'usage_limit' })
    const resumeAt = Date.parse(String(stopped.resumeAt))
    expect(resumeAt - Date.now()).toBeGreaterThan(115 * 60_000)
    expect(h.state().visits.implement).toBe(0)
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.state().limitResumeAt).toBeNull()
    const implement = h.requests.filter((r) => r.label.endsWith(':implement'))
    expect(implement[1].resumeSessionId).toBe('session-3')
    expect(implement[1].prompt).toContain("ended with an error (claude-code: You've hit your usage limit")
    // The limit has passed: one record for the visit, without the error.
    const visits = h.state().history.filter((v) => v.node === 'implement')
    expect(visits).toHaveLength(1)
    expect(visits[0]).toMatchObject({ visit: 1, outcome: 'ok', error: null })
    expect(isSignificant(h.events.find((e) => e.type === 'run_stopped')!)).toBe(true)
  })

  it('does not wake the orchestrator for a usage limit the account pool switches away from', async () => {
    let first = true
    const h = harness({ pool: true, agent: (req) => {
      if (req.label.endsWith(':implement') && first) { first = false; return { ok: false, error: { code: 'limit', message: 'usage limit reached' } } }
      return happy(req)
    } })
    await h.run.run()
    const stopped = h.events.find((e) => e.type === 'run_stopped')!
    expect(stopped.data).toMatchObject({ reason: 'usage_limit', cli: 'claude-code', quiet: true })
    expect(isSignificant(stopped)).toBe(false)
    expect(h.run.setLimitResume(new Date(Date.now() + 3_600_000).toISOString(), 'every checked account hit its limit')).toBe(true)
    expect(isSignificant(h.events.at(-1)!)).toBe(false)
  })

  it('names the limited CLI and the visit start, and lets the account pool move the resume time', async () => {
    let first = true
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && first) { first = false; return { ok: false, error: { code: 'limit', message: 'usage limit reached' } } }
      return happy(req)
    } })
    await h.run.run()
    const stopped = h.events.find((e) => e.type === 'run_stopped')!.data
    expect(stopped).toMatchObject({ reason: 'usage_limit', cli: 'claude-code', resumeAt: null })
    expect(Number.isNaN(Date.parse(String(stopped.visitStartedAt)))).toBe(false)
    expect(h.state().limitCli).toBe('claude-code')

    const at = new Date(Date.now() + 3_600_000).toISOString()
    expect(h.run.setLimitResume(at, 'every checked account hit its limit')).toBe(true)
    expect(h.state().limitResumeAt).toBe(at)
    const rescheduled = h.events.filter((e) => e.type === 'run_stopped').at(-1)!.data
    expect(rescheduled).toMatchObject({ reason: 'usage_limit', cli: 'claude-code', resumeAt: at, rescheduled: true })

    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.state().limitCli).toBeNull()
    expect(h.run.setLimitResume(at, 'too late')).toBe(false)
  })

  it('amending a running agent step restarts it in its session with the new instruction; later steps see it', async () => {
    let hang = true
    const h = harness({ agent: (req) => req.label.endsWith(':implement') && hang ? 'hang' : happy(req) })
    const loop = h.run.run()
    await waitFor(() => h.state().current === 'implement' && h.requests.length === 3)
    hang = false
    expect(await h.run.amend('Buildings can be built in the air.', 'strategist')).toBe('restarted')
    await loop
    await waitFor(() => h.run.isFinal())
    expect(h.state().result).toBe('success')
    expect(h.events.map((e) => e.type)).not.toContain('run_stopped')
    const [first, second] = h.requests.filter((r) => r.label.endsWith(':implement'))
    expect(second.resumeSessionId).toBe('session-3')
    expect(second.prompt).toContain('New instructions from the Strategist')
    expect(second.prompt).toContain('- Buildings can be built in the air.')
    expect(first.prompt).toContain('Add feature X')
    expect(h.requests.find((r) => r.label.endsWith(':review'))!.systemAppend).toContain('Instruction from the Strategist (the agent that manages the work) (given during "implement"): Buildings can be built in the air.')
    const report = h.store.readReport('run-1') as { amendments: Array<{ text: string }> }
    expect(report.amendments.map((a) => a.text)).toEqual(['Buildings can be built in the air.'])
  })

  it('collects pipeline issues from every visit into the report', async () => {
    let reviews = 0
    const h = harness({ agent: (req) => req.label.endsWith(':review')
      ? (++reviews === 1 ? { structured: { ...reject.structured, pipelineIssues: ['The context says implement while my role says never modify files.'] } } : accept)
      : happy(req) })
    await h.run.run()
    const report = h.store.readReport('run-1') as { pipelineIssues: Array<{ step: string; visit: number; issue: string }> }
    expect(report.pipelineIssues).toEqual([{ step: 'review', visit: 1, issue: 'The context says implement while my role says never modify files.' }])
    expect(h.events.find((e) => e.type === 'run_finished')!.data.report).toMatchObject({ pipelineIssues: [{ step: 'review' }] })
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
        ? (++preps === 1 ? { structured: { commitMessage: 'msg', excluded: [], pipelineIssues: [] } } : { structured: { commitMessage: 'msg', excluded: [{ path: 'debug.log', reason: 'local log' }], pipelineIssues: [] } })
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

  it('the context shows only the if branch the params select', async () => {
    const steps: Step[] = [
      { type: 'agent', id: 'implement', summary: 'implements', role: 'r.md', output: 'implementerReport' },
      { type: 'if', id: 'which', condition: 'params.milestone == true', then: [{ type: 'check', id: 'ciFull', command: 'ci --full' }], else: [{ type: 'check', id: 'ci', command: 'ci --quick' }] },
      { type: 'if', id: 'late', condition: "outputs.implement.status == 'done'", then: [{ type: 'check', id: 'extra', command: 'extra' }] }
    ]
    const machine: MachineDefinition = { ...MACHINE, id: 'milestones', params: { milestone: { type: 'boolean' } }, steps }
    const h = harness({ agent: () => done }, machine, { milestone: false })
    await h.run.run()
    const system = h.requests[0].systemAppend ?? ''
    expect(system).toContain('milestone is false in this run, so:')
    expect(system).toContain('2. ci [AIDE]')
    expect(system).not.toContain('ciFull')
    expect(system).toContain('Next in order: ci')
    expect(system).toContain('`ci --quick`')
    expect(system).not.toContain('ci --full')
    expect(system).toContain('if status is "done":') // depends on an output: both shown as a condition
  })

  it('an answer can change params for the rest of the run; invalid params are refused', async () => {
    const steps: Step[] = [
      { type: 'gate', id: 'approveSpec', question: 'Approve the split?' },
      { type: 'agent', id: 'commitPrep', summary: 'prepares', role: 'r.md', task: 'Prepare the commit of stage {{params.stageId}}.', output: 'implementerReport' }
    ]
    const machine: MachineDefinition = { ...MACHINE, id: 'split', params: { stageId: { type: 'string' } }, steps }
    const h = harness({ agent: () => done }, machine, { stageId: 'S5.7' })
    await h.run.run()
    const id = h.run.pendingEscalation()!.id
    expect(await h.run.answer(id, { action: 'continue', text: 'Part A only', by: 'strategist', params: { stageId: 5 } })).toContain('must be string')
    expect(h.run.pendingEscalation()?.id).toBe(id)
    await h.run.answer(id, { action: 'continue', text: 'Part A only', by: 'strategist', params: { stageId: 'S5.7a' } })
    await waitFor(() => h.state().status === 'finished')
    expect(h.requests[0].prompt).toContain('stage S5.7a')
    expect(h.requests[0].systemAppend).toContain('Part A only (params changed for the rest of the run: stageId = "S5.7a")')
    expect(h.store.load('run-1')!.params).toEqual({ stageId: 'S5.7a' })
  })

  it('keeps what each agent CLI invocation was sent', async () => {
    const h = harness({ agent: (req, call) => call === 0 ? { structured: { wrong: true } } : happy(req) })
    await h.run.run()
    const inputs = h.store.readAgentInputs('run-1', 'generate', 1)
    expect(inputs.map((i) => i.kind)).toEqual(['task', 'retry'])
    expect(inputs[0]).toMatchObject({ cli: 'claude-code', permissions: 'write', resumeSessionId: null })
    expect(inputs[0].prompt).toContain('Add feature X')
    expect(inputs[0].systemAppend).toContain('ROLE roles/generator.md')
    expect(inputs[1].resumeSessionId).toBe('session-1')
  })

  it('filters file inputs by globs and saves an oversized input to a file', async () => {
    const big = 'x'.repeat(120_000)
    const diff = [`diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+${big}`, 'diff --git a/golden/one.txt b/golden/one.txt\n--- a/golden/one.txt\n+++ b/golden/one.txt\n+golden'].join('\n')
    const steps: Step[] = [
      { type: 'agent', id: 'review', summary: 'reviews', role: 'r.md', permissions: 'read-only', output: 'reviewVerdict', inputs: [{ ref: 'run.diff', exclude: ['golden/**'] }] }
    ]
    const machine: MachineDefinition = { ...MACHINE, id: 'filtered', steps }
    const h = harness({ agent: () => accept }, machine)
    const deps = (h.run as unknown as { deps: EngineDeps }).deps
    deps.git.workingDiff = async () => diff
    await h.run.run()
    const prompt = h.requests[0].prompt
    expect(prompt).toContain('Filtered by the machine (exclude golden/**): 1 of 2 files.')
    expect(prompt).toContain('Too large for the prompt')
    expect(prompt).toContain('- src/a.ts (+1 −0)')
    expect(prompt).not.toContain('golden/one.txt')
    expect(prompt.length).toBeLessThan(5000)
    const saved = /saved it to `([^`]+)`/.exec(prompt)![1]
    expect(readFileSync(saved, 'utf8')).toContain(big)
  })

  it('gates: approval goes on; rejection repeats the loop with the answer, or holds the run outside loops', async () => {
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
    await h.run.answer(h.run.pendingEscalation()!.id, { action: 'reject', text: 'not now', by: 'strategist' })
    expect(h.state().result).toBeNull()
    expect(h.state()).toMatchObject({ status: 'stopped', current: 'ship' })
    expect(h.events.at(-1)!.type).toBe('run_stopped')
    await h.run.run()
    expect(h.run.pendingEscalation()?.node).toBe('ship')
    await h.run.answer(h.run.pendingEscalation()!.id, { action: 'continue', text: 'now', by: 'strategist' })
    expect(h.state().result).toBe('success')
    expect(h.state().history.filter((v) => v.node === 'approveDraft').map((v) => v.outcome)).toEqual(['fail', 'ok'])
  })
})

describe('PipelineRun with an unavailable CLI', () => {
  afterEach(() => { vi.useRealTimers() })

  const atCapacity = { ok: false, error: { code: 'unavailable' as const, message: 'Selected model is at capacity. Please try a different model.' } }
  const minute = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS) }

  it('retries every minute in the session without telling the orchestrator, then goes on', async () => {
    vi.useFakeTimers()
    let failures = 3
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && failures > 0) { failures--; return atCapacity }
      return happy(req)
    } })
    const running = h.run.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state().status).toBe('running')
    expect(h.run.describe().unavailable).toMatchObject({ node: 'implement', attempts: 1 })
    for (let i = 0; i < 3; i++) await minute()
    await running
    expect(h.state().result).toBe('success')
    expect(h.events.some((e) => e.type === 'escalation')).toBe(false)
    expect(h.events.filter((e) => e.type === 'step_retrying').map((e) => e.data.attempt)).toEqual([1, 2, 3])
    expect(h.state().unavailable).toBeNull()
    expect(h.state().visits.implement).toBe(1)
    const visits = h.state().history.filter((v) => v.node === 'implement')
    expect(visits).toHaveLength(1)
    expect(visits[0]).toMatchObject({ outcome: 'ok', retries: 3 })
    const [first, ...retries] = h.requests.filter((r) => r.label.endsWith(':implement'))
    expect(first.prompt).toContain('Add feature X')
    expect(retries).toHaveLength(3)
    expect(retries[0].resumeSessionId).toBe('session-3')
    expect(retries[0].prompt).toContain('ended with an error')
    expect(retries[0].prompt).not.toContain('Add feature X')
  })

  it('asks the orchestrator after 20 minutes; its retry makes one attempt', async () => {
    vi.useFakeTimers()
    const h = harness({ agent: (req) => req.label.endsWith(':implement') ? atCapacity : happy(req) })
    void h.run.run()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) await minute()
    const escalation = h.run.pendingEscalation()!
    expect(escalation).toMatchObject({ node: 'implement', kind: 'engine' })
    expect(escalation.message).toContain('claude-code has been unavailable for 20 min (21 attempts')
    expect(escalation.message).toContain('at capacity')
    expect(h.events.filter((e) => e.type === 'step_retrying')).toHaveLength(20)
    expect(h.state().visits.implement).toBe(0)

    const before = h.requests.length
    await h.run.answer(escalation.id, { action: 'retry', text: 'try again', by: 'strategist' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.requests.length).toBe(before + 1)
    expect(h.run.pendingEscalation()).toMatchObject({ node: 'implement', kind: 'engine' })
  })

  it('stop and pause end the wait at once; resuming by hand starts a new window', async () => {
    vi.useFakeTimers()
    let failures = 2
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && failures > 0) { failures--; return atCapacity }
      return happy(req)
    } })
    void h.run.run()
    await vi.advanceTimersByTimeAsync(0)
    await h.run.stop()
    expect(h.state().status).toBe('stopped')
    expect(h.state().visits.implement).toBe(0)
    expect(h.state().unavailable).toMatchObject({ attempts: 1 })

    void h.run.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state().unavailable).toMatchObject({ attempts: 1 })
    h.run.pause()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.state().status).toBe('paused')
    expect(h.events.at(-1)).toMatchObject({ type: 'run_paused', data: { next: 'implement' } })

    const resumed = h.run.resume()
    await vi.advanceTimersByTimeAsync(0)
    await resumed
    expect(h.state().result).toBe('success')
    // Stopped and paused while waiting: still one record, and the errors that passed are gone.
    const visits = h.state().history.filter((v) => v.node === 'implement')
    expect(visits).toHaveLength(1)
    expect(visits[0]).toMatchObject({ visit: 1, outcome: 'ok', error: null, retries: 2 })
    expect(visits[0].pendingRetry).toBeUndefined()
  })
})

describe('the run git setup', () => {
  const engineDeps = (run: PipelineRun): EngineDeps => (run as unknown as { deps: EngineDeps }).deps

  it('reads take the setup stored at start; the commit runs in the root repo', async () => {
    const h = harness({ agent: happy })
    expect(h.state().git).toEqual(rootSetup(root))
    const deps = engineDeps(h.run)
    const scopes: GitSetup[] = []
    const cwds: string[] = []
    const { workingDiff, status, commitIndex } = deps.git
    deps.git.workingDiff = async (scope) => { scopes.push(scope); return workingDiff(scope) }
    deps.git.status = async (scope) => { scopes.push(scope); return status(scope) }
    deps.git.commitIndex = async (cwd, message) => { cwds.push(cwd); return commitIndex(cwd, message) }
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(scopes.length).toBeGreaterThan(0)
    expect(scopes.every((s) => s === h.state().git)).toBe(true)
    expect(cwds).toEqual([root])
  })

  it('in no-git mode the commit block is skipped; without a shadow, run.diff is the note', async () => {
    const h = harness({ agent: happy })
    h.state().git = { mode: 'none' }
    await h.run.run()
    expect(h.state().startCommit).toBeNull()
    expect(h.run.pendingEscalation()).toBeNull()
    expect(h.state().result).toBe('success')
    expect(h.state().outputs.commit).toEqual({ skipped: 'no git', checkpoint: null, issues: [] })
    expect(h.requests.find((r) => r.label.endsWith(':review'))?.prompt).toContain('(diff unavailable: shadow snapshots are not available; read the files the implementer reports)')
    expect(h.commits).toEqual([])
  })

  it('a resumed run escalates when its repos are gone; retry checks again', async () => {
    let first = true
    const h = harness({ agent: (req) => { if (req.label.endsWith(':generate') && first) { first = false; return 'hang' } return happy(req) } })
    const running = h.run.run()
    await waitFor(() => h.requests.length === 1)
    await h.run.stop()
    await running
    expect(h.state().status).toBe('stopped')
    let problems = ['Repo "web": "frontend" does not exist.']
    const checked: GitSetup[] = []
    engineDeps(h.run).git.checkRepos = async (scope) => { checked.push(scope); return problems }
    await h.run.resume()
    const escalation = h.run.pendingEscalation()!
    expect(escalation).toMatchObject({ node: 'generate', kind: 'engine' })
    expect(escalation.message).toBe('The run\'s git repositories changed since it started:\n- Repo "web": "frontend" does not exist.\n\nRestore them and retry, or stop the run.')
    expect(checked).toEqual([h.state().git])
    problems = []
    await h.run.answer(escalation.id, { action: 'retry', text: 'restored', by: 'strategist' })
    await waitFor(() => h.run.isFinal())
    expect(h.state().result).toBe('success')
  })
})

describe('the repo of a commit step', () => {
  const engineDeps = (run: PipelineRun): EngineDeps => (run as unknown as { deps: EngineDeps }).deps
  const TWO_REPOS: GitSetup = { mode: 'git', repos: [{ id: 'web', path: 'frontend', abs: '/p/frontend' }, { id: 'api', path: 'backend', abs: '/p/backend' }], commits: true }
  const withCommit = (change: (commit: Extract<Step, { type: 'commit' }>) => void, params?: MachineDefinition['params']): MachineDefinition => {
    const machine = structuredClone(MACHINE)
    if (params) machine.params = { ...machine.params, ...params }
    const integration = machine.steps[1] as Extract<Step, { type: 'group' }>
    change(integration.steps[1] as Extract<Step, { type: 'commit' }>)
    return machine
  }
  const prepSystem = (h: ReturnType<typeof harness>): string => h.requests.find((r) => r.label.endsWith(':commitPrep'))!.systemAppend ?? ''
  const WEB_STAGED = parsePorcelain('M  frontend/src/a.ts\0')
  const API_LEFT = parsePorcelain('?? backend/new.go\0')

  /** A run on two repos whose commit step is resolved to `web`; records what the step asked git. */
  function twoRepos(machine: MachineDefinition = MACHINE) {
    const h = harness({ agent: (req) => req.label.endsWith(':commit:review') ? { structured: { verdict: 'accept', issues: [] } } : happy(req) }, machine)
    h.state().git = TWO_REPOS
    h.state().commitRepos = { commit: 'web' }
    const deps = engineDeps(h.run)
    const statusAsked: Array<string | undefined> = []
    const stagedAsked: Array<string | undefined> = []
    const cwds: string[] = []
    const { commitIndex } = deps.git
    deps.git.status = async (_scope, repoId) => { statusAsked.push(repoId); return repoId === 'web' ? WEB_STAGED : [...WEB_STAGED, ...API_LEFT] }
    deps.git.stagedDiff = async (_scope, repoId) => { stagedAsked.push(repoId); return 'staged diff of the repo' }
    deps.git.commitIndex = async (cwd, message) => { cwds.push(cwd); return commitIndex(cwd, message) }
    return { ...h, statusAsked, stagedAsked, cwds }
  }

  it('without "repo" in a single-repo project commits as before, in that repo', async () => {
    const h = harness({ agent: happy })
    expect(h.state().commitRepos).toEqual({ commit: 'root' })
    await h.run.run()
    const report = h.store.readReport('run-1') as { commits: unknown[] }
    expect(report.commits).toEqual([{ sha: 'sha-1', files: ['src/a.ts'], message: 'Add feature X', repo: 'root' }])
    expect(h.events.find((e) => e.type === 'commit_done')?.data).toEqual({ node: 'commit', sha: 'sha-1', summary: 'committed sha-1 Add feature X (1 files)' })
    expect(prepSystem(h)).toContain('- You prepare the commit (stage files, write the message); AIDE reviews it and commits. Do not commit yourself.')
  })

  it('looks only at its repo: coverage, staged diff, commit; paths are project-relative', async () => {
    const h = twoRepos(withCommit((commit) => { commit.review = 'agent'; commit.reviewer = { role: 'roles/reviewer.md' } }))
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.statusAsked.slice(0, -1)).toEqual(['web'])
    expect(h.stagedAsked).toEqual(['web'])
    expect(h.cwds).toEqual(['/p/frontend'])
    expect(h.requests.find((r) => r.label.endsWith(':commit:review'))?.prompt).toContain('staged diff of the repo')
    const report = h.store.readReport('run-1') as { commits: unknown[] }
    expect(report.commits).toEqual([{ sha: 'sha-1', files: ['frontend/src/a.ts'], message: 'Add feature X', repo: 'web' }])
    expect(h.state().outputs.commit).toMatchObject({ repo: 'web', files: ['frontend/src/a.ts'], issues: [] })
  })

  it('names the repo in commit_done when the setup has several', async () => {
    const h = twoRepos()
    await h.run.run()
    expect(h.events.find((e) => e.type === 'commit_done')?.data).toEqual({ node: 'commit', sha: 'sha-1', repo: 'web', summary: 'committed in web sha-1 Add feature X (1 files)' })
  })

  it('reports changes left in any repo as uncommitted, also to the orchestrator', async () => {
    const h = twoRepos()
    await h.run.run()
    expect(h.statusAsked.at(-1)).toBeUndefined()
    const report = h.store.readReport('run-1') as { uncommitted: string[] }
    expect(report.uncommitted).toEqual(['frontend/src/a.ts', 'backend/new.go'])
    const finished = h.events.find((e) => e.type === 'run_finished')!
    expect((finished.data.report as { uncommitted: string[] }).uncommitted).toEqual(['frontend/src/a.ts', 'backend/new.go'])
  })

  it('an unreadable git leaves the list out of the report, not the report out', async () => {
    const h = twoRepos()
    const { status } = engineDeps(h.run).git
    engineDeps(h.run).git.status = async (scope, repoId) => { if (repoId === undefined) throw new Error('git is gone'); return status(scope, repoId) }
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.store.readReport('run-1')).not.toHaveProperty('uncommitted')
    expect(h.events.at(-1)?.type).toBe('run_finished')
  })

  it('the compact report caps a long uncommitted list and leaves out an empty one', async () => {
    const empty = harness({ agent: happy })
    const { status } = engineDeps(empty.run).git
    engineDeps(empty.run).git.status = async (scope, repoId) => repoId === undefined ? [] : status(scope, repoId)
    await empty.run.run()
    expect(empty.events.at(-1)?.data.report).not.toHaveProperty('uncommitted')

    const many = Array.from({ length: 25 }, (_, i) => `f${i}.ts`)
    const long = harness({ agent: happy })
    const before = engineDeps(long.run).git.status
    engineDeps(long.run).git.status = async (scope, repoId) => repoId === undefined ? parsePorcelain(many.map((f) => `?? ${f}`).join('\0') + '\0') : before(scope, repoId)
    await long.run.run()
    const list = (long.events.at(-1)?.data.report as { uncommitted: string[] }).uncommitted
    expect(list).toHaveLength(21)
    expect(list[20]).toBe('… and 5 more (pipeline_report detail: true)')
    expect((long.store.readReport('run-1') as { uncommitted: string[] }).uncommitted).toEqual(many)
  })

  it('tells the prep agent where its repo is', async () => {
    const h = twoRepos()
    await h.run.run()
    const system = prepSystem(h)
    expect(system).toContain('- You prepare the commit in the repository at frontend/ (stage with git -C frontend add …); AIDE reviews it and commits. Do not commit yourself.')
    expect(system).toContain('- In "excluded", give paths relative to the project root (frontend/…).')
  })

  it('a repo at the project root of a multi-repo setup keeps the plain prep text', async () => {
    const h = harness({ agent: happy })
    h.state().git = { mode: 'git', repos: [{ id: 'main', path: '.', abs: root }, { id: 'web', path: 'frontend', abs: join(root, 'frontend') }], commits: true }
    h.state().commitRepos = { commit: 'main' }
    await h.run.run()
    expect(prepSystem(h)).toContain('- You prepare the commit (stage files, write the message); AIDE reviews it and commits. Do not commit yourself.')
    expect(h.events.find((e) => e.type === 'commit_done')?.data.summary).toBe('committed in main sha-1 Add feature X (1 files)')
  })

  it('a step with no resolved repo among several asks instead of guessing', async () => {
    const h = twoRepos()
    h.state().commitRepos = {}
    await h.run.run()
    expect(h.run.pendingEscalation()).toMatchObject({ node: 'commit', kind: 'engine', message: expect.stringContaining('(web, api)') })
    expect(h.commits).toEqual([])
  })

  it('an answer that changes the params resolves the repo again, and refuses an unknown one', async () => {
    let first = true
    const h = harness({ agent: (req) => { if (req.label.endsWith(':implement') && first) { first = false; return planWrong } return happy(req) } }, withCommit((commit) => { commit.repo = '{{params.repo}}' }, { repo: { type: 'string' } }), { taskSpec: 'x', repo: 'web' })
    h.state().git = TWO_REPOS
    h.state().commitRepos = { commit: 'web' }
    await h.run.run()
    const escalation = h.run.pendingEscalation()!
    expect(await h.run.answer(escalation.id, { action: 'retry', text: '', by: 'strategist', params: { repo: 'nope' } })).toBe('Invalid params:\n- Commit step "commit": "nope" is not a repo of this project (web, api).')
    expect(h.state().commitRepos).toEqual({ commit: 'web' })
    await h.run.answer(escalation.id, { action: 'retry', text: '', by: 'strategist', params: { repo: 'api' } })
    expect(h.state().commitRepos).toEqual({ commit: 'api' })
    await waitFor(() => h.run.isFinal())
    expect(h.events.find((e) => e.type === 'commit_done')?.data.repo).toBe('api')
  })

  it('a reload resolves the repos of the edited machine, and refuses a step without one', () => {
    const h = harness({ agent: happy })
    h.state().git = TWO_REPOS
    h.state().commitRepos = { commit: 'web' }
    expect(h.run.reload({ machine: MACHINE, machineDir: root })).toEqual(['Commit step "commit" must name its repo ("repo": one of web, api).'])
    expect(h.state().commitRepos).toEqual({ commit: 'web' })
    expect(h.run.reload({ machine: withCommit((commit) => { commit.repo = 'api' }), machineDir: root })).toEqual([])
    expect(h.state().commitRepos).toEqual({ commit: 'api' })
  })
})

describe('commit blocks without commits (no git, commits off)', () => {
  const engineDeps = (run: PipelineRun): EngineDeps => (run as unknown as { deps: EngineDeps }).deps
  const COMMITS_OFF: GitSetup = { mode: 'git', repos: [{ id: 'root', path: '.', abs: root }], commits: false }
  /** The guide-like machine with a step after the commit that reads run.diff. */
  const withLaterStep = (): MachineDefinition => {
    const machine = structuredClone(MACHINE)
    machine.steps.push({ type: 'agent', id: 'docs', summary: 'documents the change', role: 'roles/implementer.md', output: 'implementerReport', inputs: ['run.diff'] })
    return machine
  }

  /** A run in `setup` with a fake shadow: each snapshot is sha-<n>, the diff names the checkpoint it compares with. */
  function skipping(setup: GitSetup, machine: MachineDefinition = MACHINE, snapshot?: () => never) {
    const h = harness({ agent: happy }, machine)
    h.state().git = setup
    const labels: string[] = []
    const removed: string[] = []
    engineDeps(h.run).shadow = {
      snapshot: async (_target, label) => { snapshot?.(); labels.push(label); return { project: `sha-${labels.length}` } },
      diff: async (_target, shas) => `diff --git a/x b/x\n+since ${shas.project}`,
      changes: async () => [],
      remove: async (runId) => { removed.push(runId) }
    }
    return { ...h, labels: h.labels, snapshots: labels, removed }
  }
  const prompt = (h: ReturnType<typeof harness>, step: string): AgentRequest => h.requests.find((r) => r.label.endsWith(`:${step}`))!

  it('commits off: the prep agent does not run, nothing is committed, the block is one ok visit with a checkpoint', async () => {
    const h = skipping(COMMITS_OFF)
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(h.labels()).toEqual(['generate', 'contentReview', 'implement', 'review'])
    expect(h.commits).toEqual([])
    expect(h.state().history.filter((v) => v.node === 'commit').map((v) => v.outcome)).toEqual(['ok'])
    expect(h.state().iterations.commit).toBeUndefined()
    expect(h.state().outputs.commit).toEqual({ skipped: 'commits disabled', checkpoint: 'sha-2', issues: [] })
    expect(h.events.find((e) => e.type === 'commit_skipped')?.data).toEqual({ node: 'commit', reason: 'commits disabled', checkpoint: 'sha-2', summary: 'commit skipped: the project does not let AIDE commit' })
    expect(h.snapshots).toEqual(['baseline', 'checkpoint commit'])
    expect(prompt(h, 'review').prompt).toContain('+since sha-1')
    // The run is over: its snapshots go.
    expect(h.removed).toEqual(['run-1'])
  })

  it('run.diff after a skipped commit shows only the later changes', async () => {
    const h = skipping({ mode: 'none' }, withLaterStep())
    await h.run.run()
    expect(h.state().outputs.commit).toMatchObject({ skipped: 'no git' })
    expect(prompt(h, 'docs').prompt).toContain('+since sha-2')
  })

  it('tells every agent not to stage or commit, and shows the commit block as skipped', async () => {
    const off = skipping(COMMITS_OFF, withLaterStep())
    await off.run.run()
    const implement = prompt(off, 'implement').systemAppend ?? ''
    expect(implement).toContain('- This project does not let AIDE commit: do not stage or commit; leave your changes in the working tree.')
    expect(implement).not.toContain('Staging and committing happen in a later step')
    expect(implement).toContain('  - commit commit (skipped: commits disabled)\n6. docs [agent]')
    expect(implement).not.toContain('commitPrep')
    expect(prompt(off, 'docs').systemAppend).toContain('This project does not let AIDE commit')

    const none = skipping({ mode: 'none' })
    await none.run.run()
    expect(prompt(none, 'review').systemAppend).toContain('  - commit commit (skipped: no git)')
    expect(prompt(none, 'review').systemAppend).toContain('- You are the last step; the run ends after you.')
  })

  it('a project over the file-count limit gets the note instead of run.diff, and the run goes on', async () => {
    const h = skipping({ mode: 'none' }, MACHINE, () => { throw new Error('the project has more than 50000 files to snapshot (see "git.shadowExclude")') })
    await h.run.run()
    expect(h.state().result).toBe('success')
    expect(prompt(h, 'review').prompt).toContain('(diff unavailable: the project has more than 50000 files to snapshot (see "git.shadowExclude"); read the files the implementer reports)')
    expect(h.state().shadowDisabled).toContain('more than 50000 files')
    expect(h.state().outputs.commit).toEqual({ skipped: 'no git', checkpoint: null, issues: [] })
    expect(h.snapshots).toEqual([])
    expect(h.removed).toEqual(['run-1'])
  })

  it('a plan task is marked done at the skipped last commit', async () => {
    const h = skipping(COMMITS_OFF)
    h.state().planTask = { plan: 'p', task: 't' }
    const marked: string[] = []
    engineDeps(h.run).planCommit = async (link, findings) => { marked.push(`${link.plan}/${link.task} ${findings.join(',')}`); return () => {} }
    await h.run.run()
    expect(marked).toEqual(['p/t rename foo,rename foo'])
    expect(h.commits).toEqual([])
  })

  it('a project that commits keeps its commit block and takes no snapshot', async () => {
    const h = skipping(rootSetup(root))
    await h.run.run()
    expect(h.commits).toEqual(['Add feature X'])
    expect(h.snapshots).toEqual([])
    expect(h.removed).toEqual([])
    expect(prompt(h, 'review').prompt).toContain('+line')
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('withPlanTrailer', () => {
  it('adds the trailer once, also when the prep agent copied it from the log', async () => {
    const { withPlanTrailer } = await import('./runner')
    const link = { plan: 'p', task: 't' }
    expect(withPlanTrailer('Subject\n\nBody.\n\nCo-Authored-By: X <x@y>', link)).toBe('Subject\n\nBody.\n\nCo-Authored-By: X <x@y>\nPlan-Task: p/t\n')
    expect(withPlanTrailer('Subject\n\nBody.\n\nPlan-Task: p/t\nCo-Authored-By: X <x@y>', link)).toBe('Subject\n\nBody.\n\nCo-Authored-By: X <x@y>\nPlan-Task: p/t\n')
    expect(withPlanTrailer('Subject', link)).toBe('Subject\n\nPlan-Task: p/t\n')
  })
})

describe('runs from before engine 6', () => {
  it('read "orchestrator" as the Strategist', async () => {
    const { currentActors } = await import('./runStore')
    const legacy = { escalations: [{ to: 'orchestrator', answer: { by: 'orchestrator' } }, { to: 'user', answer: { by: 'user' } }], amendments: [{ by: 'orchestrator' }] } as unknown as RunState
    const state = currentActors(legacy)
    expect(state.escalations.map((e) => [e.to, e.answer?.by])).toEqual([['agent', 'strategist'], ['user', 'user']])
    expect(state.amendments![0].by).toBe('strategist')
    // A current run is left alone: there "orchestrator" is the plan's.
    expect(currentActors({ ...state, escalations: [{ to: 'agent', answer: { by: 'orchestrator' } }] } as unknown as RunState).escalations[0].answer?.by).toBe('orchestrator')
  })
})
