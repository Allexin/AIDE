import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PipelineRun, type EngineDeps } from './runner'
import { RunStore } from './runStore'
import { readRole } from './library'
import { validateMachine } from './validate'
import type { MachineDefinition } from './types'
import { claudeHeadless } from '../headless/claudeHeadless'
import { runShellCommand } from '../processRunner'
import { commitIndex, git, headSha, stagedDiff, status, workingDiff } from '../git'
import { getSessionsDir } from '../../pty/cliTools/claudeCodeScanner'

// End-to-end: real engine, real Claude Code (haiku), real git, real check command.
// Opt in: AIDE_LIVE_PIPELINE=1 npx vitest run pipeline.live
const live = process.env.AIDE_LIVE_PIPELINE === '1'
if (live) vi.setConfig({ testTimeout: 900_000 })

const MACHINE: MachineDefinition = {
  id: 'tiny-feature',
  name: 'Tiny feature',
  description: 'Live test machine.',
  params: { taskSpec: { type: 'string' } },
  defaults: { cli: 'claude-code', model: 'haiku', timeoutMin: 10 },
  start: 'implement',
  nodes: {
    implement: { type: 'agent', summary: 'implements the task', role: 'roles/implementer.md', output: 'implementerReport', inputs: ['params.taskSpec'] },
    checks: { type: 'check', command: 'node check.js' },
    review: { type: 'agent', summary: 'a separate reviewer checks the diff against the task', role: 'roles/reviewer.md', permissions: 'read-only', output: 'reviewVerdict', inputs: ['params.taskSpec', 'run.diff'], maxVisits: 2, onLimit: 'stuck' },
    fix: { type: 'agent', summary: 'fixes failed checks or review findings', role: 'roles/implementer.md', session: 'continue:implement', output: 'implementerReport', inputs: ['outputs.checks.output', 'outputs.review.blocking'] },
    commitPrep: { type: 'agent', summary: 'stages the change and writes the commit message', role: 'roles/commit-prep.md', session: 'continue:implement', output: 'commitPrep', inputs: ['outputs.commit.issues'], maxVisits: 2, onLimit: 'stuck' },
    commit: { type: 'commit', prep: 'commitPrep', review: 'algorithmic' },
    stuck: { type: 'escalate', message: 'did not converge' },
    done: { type: 'end', result: 'success' },
    failed: { type: 'end', result: 'failure' }
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
    ['stuck', 'failed', 'default']
  ]
}

describe.skipIf(!live)('pipeline end to end (live)', () => {
  let repo = ''
  let machineDir = ''
  let runsRoot = ''

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'aide-live-pipeline-'))
    repo = join(root, 'repo')
    machineDir = join(root, 'pipelines')
    runsRoot = join(root, 'runs')
    mkdirSync(repo)
    mkdirSync(join(machineDir, 'roles'), { recursive: true })
    writeFileSync(join(machineDir, 'roles', 'implementer.md'), 'You are the implementer. Implement exactly the task. Keep changes minimal.')
    writeFileSync(join(machineDir, 'roles', 'reviewer.md'), 'You are the reviewer. Accept when the diff does what the task says; list blocking findings otherwise. Never modify files.')
    writeFileSync(join(machineDir, 'roles', 'commit-prep.md'), 'Stage exactly the files of your change with git add, and write a commit message. Do not commit.')
    writeFileSync(join(repo, 'check.js'), "const fs = require('fs'); const ok = fs.existsSync('greeting.txt') && fs.readFileSync('greeting.txt', 'utf8').trim() === 'hello pipeline'; console.log(ok ? 'greeting ok' : 'greeting.txt missing or wrong'); process.exit(ok ? 0 : 1)\n")
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'user.name', 'Test'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-q', '-m', 'init'])
  })

  afterAll(() => {
    rmSync(getSessionsDir(repo), { recursive: true, force: true })
    rmSync(join(repo, '..'), { recursive: true, force: true })
  })

  it('implements, checks, reviews, prepares and commits', async () => {
    expect(validateMachine(MACHINE, { headlessClis: ['claude-code'], roleExists: (r) => existsSync(join(machineDir, r)) }).errors).toEqual([])
    const events: string[] = []
    const deps: EngineDeps = {
      startAgent: ({ cli: _cli, ...options }) => claudeHeadless.run({ ...options, env: process.env, maxBudgetUsd: 1 }),
      runCheck: ({ commandLine, cwd, timeoutMs, label, onOutput }) => runShellCommand({ commandLine, cwd, timeoutMs, label, onStdoutLine: (l) => onOutput(l + '\n'), onStderr: onOutput }),
      git: { workingDiff, stagedDiff, status, headSha, commitIndex },
      readRole,
      emit: (_runId, type, data) => { events.push(`${type}${data.node ? `:${String(data.node)}` : ''}`) }
    }
    const run = PipelineRun.create({ machine: MACHINE, machineDir }, { taskSpec: 'Create a file greeting.txt in the repository root containing exactly the text: hello pipeline' }, 'live-1', repo, new RunStore(runsRoot), deps)
    await run.run()
    const pending = run.pendingEscalation()
    expect(pending, `escalated: ${pending?.message}\nevents: ${events.join(', ')}\ncommit: ${JSON.stringify(run.state.outputs.commit)}\nprep: ${JSON.stringify(run.state.outputs.commitPrep)}`).toBeNull()
    expect(run.state.result).toBe('success')
    expect(readFileSync(join(repo, 'greeting.txt'), 'utf8').trim()).toBe('hello pipeline')
    const log = await git(repo, ['log', '--format=%s', '-n', '2'])
    expect(log.stdout.trim().split('\n')).toHaveLength(2)
    expect((await status(repo)).filter((c) => c.path === 'greeting.txt')).toEqual([])
    expect(events).toContain('commit_done:commit')
  })
})
