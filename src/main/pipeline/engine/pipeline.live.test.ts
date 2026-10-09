import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { PipelineRun, type EngineDeps } from './runner'
import { RunStore } from './runStore'
import { readRole } from './library'
import { validateMachine } from './validate'
import { claudeHeadless } from '../headless/claudeHeadless'
import { runShellCommand } from '../processRunner'
import { commitIndex, git, headSha, stagedDiff, status, workingDiff } from '../git'
import { getSessionsDir } from '../../pty/cliTools/claudeCodeScanner'
import { TINY_FEATURE, TINY_TASK, createTinyWorkspace, type TinyWorkspace } from '../testing/tinyFeature'

// End-to-end: real engine, real Claude Code (haiku), real git, real check command.
// Opt in: AIDE_LIVE_PIPELINE=1 npx vitest run pipeline.live
const live = process.env.AIDE_LIVE_PIPELINE === '1'
if (live) vi.setConfig({ testTimeout: 900_000 })

describe.skipIf(!live)('pipeline end to end (live)', () => {
  let ws: TinyWorkspace

  beforeAll(async () => { ws = await createTinyWorkspace('aide-live-pipeline-') })
  afterAll(() => {
    rmSync(getSessionsDir(ws.repo), { recursive: true, force: true })
    rmSync(ws.root, { recursive: true, force: true })
  })

  it('implements, checks, reviews, prepares and commits', async () => {
    expect(validateMachine(TINY_FEATURE, { headlessClis: ['claude-code'], roleExists: (r) => existsSync(join(ws.machineDir, r)) }).errors).toEqual([])
    const events: string[] = []
    const deps: EngineDeps = {
      startAgent: ({ cli: _cli, ...options }) => claudeHeadless.run({ ...options, env: process.env, maxBudgetUsd: 1 }),
      runCheck: ({ commandLine, cwd, timeoutMs, label, onOutput }) => runShellCommand({ commandLine, cwd, timeoutMs, label, onStdoutLine: (l) => onOutput(l + '\n'), onStderr: onOutput }),
      git: { workingDiff, stagedDiff, status, headSha, commitIndex },
      readRole,
      emit: (_runId, type, data) => { events.push(`${type}${data.node ? `:${String(data.node)}` : ''}`) }
    }
    const run = PipelineRun.create({ machine: TINY_FEATURE, machineDir: ws.machineDir }, { taskSpec: TINY_TASK }, 'live-1', ws.repo, new RunStore(ws.runsRoot), deps)
    await run.run()
    const pending = run.pendingEscalation()
    expect(pending, `escalated: ${pending?.message}\nevents: ${events.join(', ')}\ncommit: ${JSON.stringify(run.state.outputs.commit)}\nprep: ${JSON.stringify(run.state.outputs.commitPrep)}`).toBeNull()
    expect(run.state.result).toBe('success')
    expect(readFileSync(join(ws.repo, 'greeting.txt'), 'utf8').trim()).toBe('hello pipeline')
    const log = await git(ws.repo, ['log', '--format=%s', '-n', '2'])
    expect(log.stdout.trim().split('\n')).toHaveLength(2)
    expect((await status(ws.repo)).filter((c) => c.path === 'greeting.txt')).toEqual([])
    expect(events).toContain('commit_done:commit')
  })
})
