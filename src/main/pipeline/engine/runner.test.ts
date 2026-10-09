import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PipelineRun, type AgentRequest, type EngineDeps } from './runner'
import { RunStore } from './runStore'
import { validateMachine } from './validate'
import type { MachineDefinition, RunState } from './types'
import type { HeadlessResult } from '../headless/types'
import type { FileChange } from '../git'
import { parsePorcelain } from '../git'

const root = mkdtempSync(join(tmpdir(), 'aide-engine-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MACHINE: MachineDefinition = {
  id: 'code-feature',
  name: 'Code feature',
  description: 'Implements one stage.',
  params: { taskSpec: { type: 'string' } },
  defaults: { cli: 'claude-code' },
  start: 'implement',
  nodes: {
    implement: { type: 'agent', summary: 'implements the task', role: 'roles/implementer.md', output: 'implementerReport', inputs: ['params.taskSpec'] },
    checks: { type: 'check', command: 'npm test' },
    review: { type: 'agent', summary: 'a separate reviewer inspects the diff', role: 'roles/reviewer.md', permissions: 'read-only', output: 'reviewVerdict', inputs: ['run.diff'], maxVisits: 3, onLimit: 'stuck' },
    fix: { type: 'agent', summary: 'fixes review findings or failed checks', role: 'roles/implementer.md', session: 'continue:implement', output: 'implementerReport', inputs: ['outputs.review.blocking', 'outputs.checks.output'] },
    commitPrep: { type: 'agent', summary: 'stages the change and writes the commit message', role: 'roles/implementer.md', session: 'continue:implement', output: 'commitPrep', inputs: ['outputs.commit.issues'], maxVisits: 3, onLimit: 'stuck' },
    commit: { type: 'commit', prep: 'commitPrep', review: 'algorithmic' },
    stuck: { type: 'escalate', to: 'orchestrator', message: 'The loop did not converge.' },
    done: { type: 'end', result: 'success' }
  },
  edges: [
    ['implement', 'checks', "outputs.implement.status == 'done'"],
    ['implement', 'stuck', 'default'],
    ['checks', 'review', 'ok'],
    ['checks', 'fix', 'fail'],
    ['review', 'commitPrep', "outputs.review.verdict == 'accept'"],
    ['review', 'fix', 'default'],
    ['fix', 'checks', 'default'],
    ['commitPrep', 'commit', 'default'],
    ['commit', 'done', 'ok'],
    ['commit', 'commitPrep', 'fail'],
    ['stuck', 'done', 'default']
  ]
}

interface Script {
  agent: (request: AgentRequest, call: number) => Partial<HeadlessResult> & { structured?: unknown }
  check?: (call: number) => { exitCode: number; output: string } | 'hang'
  status?: () => FileChange[]
}

function harness(script: Script, machine: MachineDefinition = MACHINE) {
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
  const run = PipelineRun.create({ machine, machineDir: root }, { taskSpec: 'Add feature X' }, 'run-1', root, store, deps)
  return { run, requests, events, commits, store, state: (): RunState => run.state }
}

const done = { structured: { status: 'done', summary: 'implemented', docsChanged: [] } }
const accept = { structured: { verdict: 'accept', blocking: [], non_blocking: ['rename foo'], summary: 'ok' } }
const reject = { structured: { verdict: 'reject', blocking: ['missing null check'], non_blocking: [], summary: 'no' } }
const prep = { structured: { commitMessage: 'Add feature X', excluded: [] } }

describe('machine fixture', () => {
  it('is valid', () => {
    expect(validateMachine(MACHINE, { headlessClis: ['claude-code', 'codex'], roleExists: () => true })).toEqual({ errors: [], warnings: [] })
  })
})

describe('PipelineRun', () => {
  it('runs the happy path to a commit and a success report', async () => {
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? accept : req.label.endsWith(':commitPrep') ? prep : done })
    await h.run.run()
    expect(h.state().status).toBe('finished')
    expect(h.state().result).toBe('success')
    expect(h.commits).toEqual(['Add feature X'])
    expect(h.requests.map((r) => r.label)).toEqual(['claude-code:implement', 'claude-code:review', 'claude-code:commitPrep'])
    expect(h.events.map((e) => e.type)).toContain('commit_done')
    expect(h.events[h.events.length - 1].type).toBe('run_finished')
    const report = h.store.readReport('run-1') as { nonBlockingFindings: string[]; commits: Array<{ sha: string }>; costUsd: number }
    expect(report.nonBlockingFindings).toEqual(['rename foo'])
    expect(report.commits.map((c) => c.sha)).toEqual(['sha-1'])
  })

  it('gives each agent its role, pipeline context and inputs', async () => {
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? accept : req.label.endsWith(':commitPrep') ? prep : done })
    await h.run.run()
    const [implement, review, commitPrep] = h.requests
    expect(implement.systemAppend).toContain('ROLE roles/implementer.md')
    expect(implement.systemAppend).toContain('implement [agent] — implements the task   ← YOU ARE HERE')
    expect(implement.systemAppend).toContain('AIDE itself runs these checks later: `npm test`')
    expect(implement.systemAppend).toContain('Staging and committing happen in a later step. Do not stage or commit.')
    expect(implement.prompt).toContain('Add feature X')
    expect(review.permissions).toBe('read-only')
    expect(review.prompt).toContain('+line')
    expect(commitPrep.systemAppend).toContain('You prepare the commit')
    expect(commitPrep.resumeSessionId).toBe('session-1')
  })

  it('loops review → fix → checks until accepted, continuing the implementer session', async () => {
    let reviews = 0
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':review')) return ++reviews < 3 ? reject : accept
      if (req.label.endsWith(':commitPrep')) return prep
      return done
    } })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const fixes = h.requests.filter((r) => r.label.endsWith(':fix'))
    expect(fixes).toHaveLength(2)
    expect(fixes.every((f) => f.resumeSessionId === 'session-1')).toBe(true)
    expect(fixes[0].prompt).toContain('missing null check')
    expect(h.state().visits.review).toBe(3)
  })

  it('escalates when the review loop hits its limit, and stops on answer', async () => {
    const h = harness({ agent: (req) => req.label.endsWith(':review') ? reject : done })
    await h.run.run()
    expect(h.state().status).toBe('waiting')
    const escalation = h.run.pendingEscalation()!
    expect(escalation).toMatchObject({ node: 'stuck', kind: 'node', message: 'The loop did not converge.' })
    await h.run.answer(escalation.id, { action: 'stop', text: 'give up', by: 'orchestrator' })
    expect(h.state().status).toBe('failed')
  })

  it('routes failed checks to fix with their output', async () => {
    const h = harness({
      agent: (req) => req.label.endsWith(':review') ? accept : req.label.endsWith(':commitPrep') ? prep : done,
      check: (call) => call === 0 ? { exitCode: 1, output: 'TypeError at a.ts:3' } : { exitCode: 0, output: 'ok' }
    })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const fix = h.requests.find((r) => r.label.endsWith(':fix'))!
    expect(fix.prompt).toContain('TypeError at a.ts:3')
    expect(h.events.map((e) => e.type)).toContain('check_failed')
  })

  it('raises an engine escalation on agent failure and retries on answer', async () => {
    let first = true
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement') && first) { first = false; return { ok: false, error: { code: 'limit', message: 'usage limit reached' } } }
      return req.label.endsWith(':review') ? accept : req.label.endsWith(':commitPrep') ? prep : done
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
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement')) return ++calls === 1 ? { structured: { status: 'finished' } } : done
      return req.label.endsWith(':review') ? accept : prep
    } })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const retry = h.requests[1]
    expect(retry.label).toBe('claude-code:implement')
    expect(retry.prompt).toContain('did not match the required output schema')
    expect(retry.resumeSessionId).toBe('session-1')
  })

  it('pauses after the current node and resumes', async () => {
    const h = harness({ agent: (req) => {
      if (req.label.endsWith(':implement')) h.run.pause()
      return req.label.endsWith(':review') ? accept : req.label.endsWith(':commitPrep') ? prep : done
    } })
    await h.run.run()
    expect(h.state().status).toBe('paused')
    expect(h.state().current).toBe('checks')
    expect(h.events.map((e) => e.type)).toContain('run_paused')
    await h.run.run()
    expect(h.state().result).toBe('success')
  })

  it('stop interrupts the running node; resuming re-runs it', async () => {
    let hang = true
    const h = harness({
      agent: (req) => req.label.endsWith(':review') ? accept : req.label.endsWith(':commitPrep') ? prep : done,
      check: () => hang ? 'hang' : { exitCode: 0, output: 'ok' }
    })
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

  it('sends commit issues back to commit prep', async () => {
    let preps = 0
    const h = harness({
      agent: (req) => {
        if (req.label.endsWith(':commitPrep')) return ++preps === 1 ? { structured: { commitMessage: 'msg', excluded: [] } } : { structured: { commitMessage: 'msg', excluded: [{ path: 'debug.log', reason: 'local log' }] } }
        return req.label.endsWith(':review') ? accept : done
      },
      status: () => parsePorcelain('M  src/a.ts\0?? debug.log\0')
    })
    await h.run.run()
    expect(h.state().result).toBe('success')
    const second = h.requests.filter((r) => r.label.endsWith(':commitPrep'))[1]
    expect(second.prompt).toContain('debug.log is untracked')
  })

  it('gates continue on approval and take the fail edge on rejection', async () => {
    const gated: MachineDefinition = {
      ...MACHINE,
      id: 'gated',
      start: 'approve',
      nodes: { approve: { type: 'gate', question: 'Proceed?' }, yes: { type: 'end', result: 'success' }, no: { type: 'end', result: 'failure' } },
      edges: [['approve', 'yes', 'ok'], ['approve', 'no', 'fail']]
    }
    const approved = harness({ agent: () => done }, gated)
    await approved.run.run()
    await approved.run.answer(approved.run.pendingEscalation()!.id, { action: 'continue', text: 'go', by: 'user' })
    await waitFor(() => approved.run.isFinal())
    expect(approved.state().result).toBe('success')

    const rejected = harness({ agent: () => done }, gated)
    await rejected.run.run()
    await rejected.run.answer(rejected.run.pendingEscalation()!.id, { action: 'reject', text: 'no', by: 'user' })
    await waitFor(() => rejected.run.isFinal())
    expect(rejected.state().result).toBe('failure')
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
