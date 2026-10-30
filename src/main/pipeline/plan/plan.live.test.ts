import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PipelineManager } from '../manager'
import { claudeHeadless } from '../headless/claudeHeadless'
import { runShellCommand } from '../processRunner'
import { commitIndex, commitsSince, git, headSha, stagedDiff, stagePaths, status, workingDiff } from '../git'
import { getSessionsDir } from '../../pty/cliTools/claudeCodeScanner'
import { createTinyWorkspace, TINY_FEATURE, type TinyWorkspace } from '../testing/tinyFeature'
import { pipelineEvents } from '../events'
import { PlanService } from './planService'
import type { PlanFile } from '../../../shared/plan'

// End-to-end: real autopilot, real Orchestrator and step agents (Claude Code, haiku), real git.
// Opt in: AIDE_LIVE_PIPELINE=1 npx vitest run plan.live
const live = process.env.AIDE_LIVE_PIPELINE === '1'
if (live) vi.setConfig({ testTimeout: 1_200_000 })

describe.skipIf(!live)('plan autopilot end to end (live)', () => {
  let ws: TinyWorkspace
  beforeAll(async () => { ws = await createTinyWorkspace('aide-live-plan-', true) })
  afterAll(() => {
    rmSync(getSessionsDir(ws.repo), { recursive: true, force: true })
    rmSync(ws.root, { recursive: true, force: true })
  })

  it('walks a plan: each task is decided, run, reviewed and committed with its status', async () => {
    const manager = new PipelineManager({
      runsRoot: () => ws.runsRoot,
      libraryDirs: () => [{ dir: ws.machineDir, source: 'shared' }],
      headlessClis: () => ['claude-code'],
      deps: () => ({
        startAgent: ({ cli: _cli, ...options }) => claudeHeadless.run({ ...options, env: process.env, maxBudgetUsd: 1 }),
        runCheck: ({ commandLine, cwd, timeoutMs, label, onOutput }) => runShellCommand({ commandLine, cwd, timeoutMs, label, onStdoutLine: (l) => onOutput(l + '\n'), onStderr: onOutput }),
        git: { workingDiff, stagedDiff, status, headSha, commitIndex }
      })
    })
    const plans = new PlanService(manager, { userDir: () => join(ws.root, 'plans-user'), stage: stagePaths, headSha, commitsSince })
    plans.create(ws.repo, {
      id: 'greet',
      title: 'Greeting',
      goal: 'A greeting file, then a note about it',
      orchestrator: { cli: 'claude-code', model: 'haiku', effort: 'low', prompt: 'Go on when the last step succeeded. Fill taskSpec from the next task\'s acceptance, word for word.' },
      tasks: [
        { id: 'greeting', title: 'Greeting file', machine: TINY_FEATURE.id, acceptance: ['Create a file greeting.txt in the repository root containing exactly the text: hello pipeline'] },
        { id: 'note', title: 'Note file', machine: TINY_FEATURE.id, after: ['greeting'], acceptance: ['Create a file note.txt in the repository root containing exactly the text: greeting added. Do not change greeting.txt.'] }
      ]
    })
    plans.approve(ws.repo, 'greet')
    plans.activate(ws.repo, 'greet')
    await plans.run(ws.repo)

    const describeState = (): string => JSON.stringify({ auto: plans.snapshot(ws.repo).autopilot, events: pipelineEvents.since(ws.repo, null, 0).filter((e) => e.type === 'escalation').map((e) => e.data.message) })
    const deadline = Date.now() + 1_100_000
    for (;;) {
      const auto = plans.snapshot(ws.repo).autopilot
      if (auto?.status === 'held' || auto?.status === 'finished') break
      if (pipelineEvents.since(ws.repo, null, 0).some((e) => e.type === 'escalation') && manager.activeRun(ws.repo)?.pendingEscalation()) break
      if (Date.now() > deadline) throw new Error(`timed out: ${describeState()}`)
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(plans.snapshot(ws.repo).autopilot?.status, describeState()).toBe('finished')

    const file = JSON.parse(readFileSync(join(ws.repo, 'aide', 'plans', 'greet.json'), 'utf8')) as PlanFile
    expect(file.tasks.map((t) => t.status)).toEqual(['done', 'done'])
    expect(file.state).toBe('done')
    expect(readFileSync(join(ws.repo, 'greeting.txt'), 'utf8').trim()).toBe('hello pipeline')
    expect(readFileSync(join(ws.repo, 'note.txt'), 'utf8')).toContain('greeting added')

    // Each task is one commit, carrying its trailer and its own status change.
    const log = await git(ws.repo, ['log', '--format=%(trailers:key=Plan-Task,valueonly)', '-n', '2'])
    expect(log.stdout.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['greet/note', 'greet/greeting'])
    const inFirst = await git(ws.repo, ['show', 'HEAD~1:aide/plans/greet.json'])
    expect((JSON.parse(inFirst.stdout) as PlanFile).tasks.map((t) => t.status)).toEqual(['done', 'pending'])

    // The Strategist heard only the end, and every Orchestrator call kept its transcript and answer.
    expect(pipelineEvents.since(ws.repo, null, 0).filter((e) => e.type === 'plan_attention').map((e) => e.data.kind)).toEqual(['finished'])
    const record = plans.decisionRecord(ws.repo, 'greet', 1)
    expect(record.entries.length).toBeGreaterThan(0)
    expect(record.decision).toMatchObject({ verdict: 'next' })
  })
})
