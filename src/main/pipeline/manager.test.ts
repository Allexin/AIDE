import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { PipelineManager, type ManagerEnvironment } from './manager'
import { McpServer } from './mcp/protocol'
import { buildPipelineTools } from './mcp/tools'
import { validateMachine } from './engine/validate'
import { RunStore } from './engine/runStore'
import type { MachineDefinition } from './engine/types'
import type { HeadlessResult } from './headless/types'
import { NO_GIT_DIFF, commitIndex, git, headSha, parsePorcelain, stagedDiff, status, workingDiff } from './git'
import { resolveGitSetup } from './gitConfig'
import { orchestrators } from './orchestrators'
import { pipelineEvents } from './events'
import { ENGINE_VERSION } from './engine/compat'

const root = mkdtempSync(join(tmpdir(), 'aide-manager-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const GUIDE = resolve(__dirname, '../../../resources/docs/pipeline-authoring.md')

function guideExample(section = '5\\. Example: code feature'): MachineDefinition {
  const text = readFileSync(GUIDE, 'utf8').replace(/\r\n/g, '\n')
  const block = new RegExp(`## ${section}[\\s\\S]*?\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(text)
  if (!block) throw new Error(`example "${section}" not found in the authoring guide`)
  return JSON.parse(block[1]) as MachineDefinition
}

function project(name: string, machine: MachineDefinition): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'aide', 'pipelines', 'roles'), { recursive: true })
  writeFileSync(join(dir, 'aide', 'pipelines', `${machine.id}.json`), JSON.stringify(machine, null, 2))
  for (const role of ['implementer', 'code-reviewer', 'commit-prep']) writeFileSync(join(dir, 'aide', 'pipelines', 'roles', `${role}.md`), `${role} role`)
  return dir
}

function environment(agent: (label: string) => Partial<HeadlessResult>): ManagerEnvironment {
  let sessions = 0
  return {
    runsRoot: (p) => join(p, '.aide', 'runs'),
    libraryDirs: (p) => [{ dir: join(p, 'aide', 'pipelines'), source: 'shared' }],
    headlessClis: () => ['claude-code', 'codex'],
    deps: () => ({
      startAgent: (request) => {
        const sessionId = request.resumeSessionId ?? `s-${++sessions}`
        const result: HeadlessResult = { ok: true, sessionId, structured: null, finalText: null, costUsd: 0.02, warnings: [], error: null, ...agent(request.label) }
        return { result: Promise.resolve(result), cancel: async () => {} }
      },
      runCheck: (options) => {
        options.onOutput('ok\n')
        return { pid: 1, done: Promise.resolve({ exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, stdoutTail: 'ok', stderrTail: '' }), cancel: async () => {} }
      },
      git: {
        workingDiff: async () => '+change',
        stagedDiff: async () => '+change',
        status: async () => parsePorcelain('M  src/a.ts\0'),
        headSha: async () => 'base',
        commitIndex: async (_cwd, message) => ({ sha: 'abc123', files: ['src/a.ts'], message })
      }
    })
  }
}

const happy = (label: string): Partial<HeadlessResult> => {
  if (label.endsWith(':review')) return { structured: { verdict: 'accept', blocking: [], non_blocking: ['nit'], summary: 'fine', pipelineIssues: [] } }
  if (label.endsWith(':commitPrep')) return { structured: { commitMessage: 'Add X', excluded: [], pipelineIssues: [] } }
  return { structured: { status: 'done', summary: 'did X', docsChanged: [], pipelineIssues: [] } }
}

/** Calls a tool; `data` is the JSON on the last line of the text result, when there is one. */
async function call(server: McpServer, projectPath: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data?: Record<string, unknown>; isError?: boolean }> {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { projectPath, connectionId: 'c', tabId: null }) as { result: { content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean } }
  expect(response.result.structuredContent).toBeUndefined()
  const text = response.result.content[0].text
  let data: Record<string, unknown> | undefined
  try { data = JSON.parse(text.split('\n').pop() ?? '') as Record<string, unknown> } catch { data = undefined }
  return { text, data, isError: response.result.isError }
}

async function callWith(server: McpServer, projectPath: string, tabId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { projectPath, connectionId: 'c', tabId }) as { result: { content: Array<{ text: string }> } }
  return response.result.content[0].text
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!condition()) throw new Error('timed out')
}

describe('authoring guide', () => {
  it('its example machines are valid', () => {
    const env = { headlessClis: ['claude-code', 'codex'], roleExists: () => true }
    expect(validateMachine(guideExample(), env)).toEqual({ errors: [], warnings: [] })
    expect(validateMachine(guideExample('6\\. Example: content, then integration'), env)).toEqual({ errors: [], warnings: [] })
  })
})

describe('PipelineManager through the MCP tools', () => {
  it('refuses to start a machine written for an older engine, with what changed; acceptOutdated runs it', async () => {
    const { engineVersion: _current, ...old } = guideExample()
    const dir = project('p0', { ...old, engineVersion: 2 })
    const manager = new PipelineManager(environment(happy))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const list = await call(server, dir, 'pipeline_list', {})
    expect(list.text).toContain(`"outdated":"written for engine 2, AIDE runs ${ENGINE_VERSION}"`)
    const refused = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] } })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('was written for AIDE pipeline engine 2')
    expect(refused.text).toContain('Engine 3:')
    expect(refused.text).not.toContain('Engine 2:')
    expect(refused.text).toContain(`set "engineVersion": ${ENGINE_VERSION}`)
    expect(manager.activeRun(dir)).toBeNull()
    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] }, acceptOutdated: true })
    expect(started.text).toMatch(/Run \S+ started/)
    expect(started.text).toContain('acceptOutdated')
  })

  it('lists, starts, waits for and reports a run', async () => {
    const dir = project('p1', guideExample())
    const manager = new PipelineManager(environment(happy))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'aide-pipeline', manager })))

    const list = await call(server, dir, 'pipeline_list')
    expect(list.data?.machines).toEqual([expect.objectContaining({ id: 'code-feature', valid: true })])

    const missing = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: {} })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('Missing required param "taskSpec"')

    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Add X', acceptance: ['X works'] } })
    expect(started.isError).toBeUndefined()
    const runId = /Run (\S+) started/.exec(started.text)![1]
    expect(started.text).toContain(`events --run ${runId}`)

    // Step progress does not wake the orchestrator: the first event it gets is the end of the run.
    const waited = await call(server, dir, 'pipeline_wait', { runId, since: 0, timeoutSec: 5 })
    // The end-of-run event carries the compact report: no separate pipeline_report call is needed.
    expect(waited.data).toMatchObject({ type: 'run_finished', data: { result: 'success', report: { result: 'success', commits: [{ sha: 'abc123', subject: 'Add X' }] } } })
    await until(() => manager.activeRun(dir)?.isFinal() === true)

    const report = await call(server, dir, 'pipeline_report', { runId })
    expect(report.data).toMatchObject({
      result: 'success',
      nonBlockingFindings: ['nit'],
      commits: [{ sha: 'abc123', subject: 'Add X', files: 1 }],
      visits: { implement: 1, checks: 1, review: 1, commitPrep: 1, commit: 1 },
      loops: { build: 1, commit: 1 },
      checks: [{ step: 'checks', command: expect.any(String), result: 'passed', runs: 1 }],
      summaries: [{ step: 'implement', summary: 'did X' }, { step: 'review', summary: 'fine' }]
    })
    expect(report.data).not.toHaveProperty('params')
    expect(report.text.length).toBeLessThan(800)
    const detailed = await call(server, dir, 'pipeline_report', { runId, detail: true })
    expect(detailed.data?.visits).toHaveLength(5)
    expect(detailed.data).not.toHaveProperty('params')

    const output = await call(server, dir, 'pipeline_output', { step: 'checks', runId })
    expect(output.text).toBe('checks visit 1 exit code 0:\nok\n')
    expect((await call(server, dir, 'pipeline_output', { step: 'review', runId })).text).toContain('"verdict":"accept"')
    expect((await call(server, dir, 'pipeline_runs')).data).toEqual([expect.objectContaining({ runId, status: 'finished' })])
  })

  it('refuses a second active run and answers escalations', async () => {
    const machine = guideExample()
    const dir = project('p2', machine)
    const manager = new PipelineManager(environment((label) => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [], pipelineIssues: [] } } : happy(label)))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] } })
    const runId = /Run (\S+) started/.exec(started.text)![1]
    const event = await call(server, dir, 'pipeline_wait', { runId, timeoutSec: 5 })
    expect(event.data).toMatchObject({ type: 'escalation', data: { node: 'implement', kind: 'step' } })

    const second = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Z', acceptance: [] } })
    expect(second.isError).toBe(true)
    expect(second.text).toContain('still waiting')

    const escalationId = String((event.data?.data as Record<string, unknown>).escalationId)
    const answered = await call(server, dir, 'pipeline_answer', { escalationId, action: 'stop', text: 'agreed, drop it' })
    expect(answered.isError).toBeUndefined()
    await until(() => manager.activeRun(dir)?.isFinal() === true)
    expect(manager.activeRun(dir)?.state.result).toBe('failure')
  })

  it('records an instruction with pipeline_amend; abandon lists what the run left uncommitted', async () => {
    const dir = project('p2b', guideExample())
    const manager = new PipelineManager(environment((label) => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [], pipelineIssues: [] } } : happy(label)))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] }, wait: 5 })
    const amended = await call(server, dir, 'pipeline_amend', { text: 'Keep the old save format.' })
    expect(amended.text).toBe('Instruction recorded; the later steps of the run will see it.')
    expect(manager.activeRun(dir)?.state.amendments).toMatchObject([{ node: 'implement', text: 'Keep the old save format.', by: 'strategist' }])
    const abandoned = await call(server, dir, 'pipeline_stop', { mode: 'abandon', reason: 'test' })
    expect(abandoned.text).toMatch(/^Done: abandon\./)
    expect(manager.activeRun(dir)?.state.result).toBe('failure')
  })

  it('recovers an interrupted run as paused and resumes it', async () => {
    const dir = project('p3', guideExample())
    const env = environment(happy)
    // Simulate a run that was executing "checks" when AIDE died.
    const store = new RunStore(env.runsRoot(dir))
    const first = new PipelineManager(env)
    const { runId } = await first.start(dir, 'code-feature', { taskSpec: 'X', acceptance: [] })
    await until(() => first.activeRun(dir)?.isFinal() === true)
    const loaded = store.load(runId)!
    loaded.state.status = 'running'
    loaded.state.result = null
    loaded.state.finishedAt = null
    loaded.state.current = 'checks'
    loaded.state.history.push({ node: 'checks', visit: 2, outcome: null, startedAt: new Date().toISOString(), finishedAt: null, sessionId: null, costUsd: null, error: null })
    loaded.state.visits.checks = 2
    store.saveState(loaded.state)

    const second = new PipelineManager(env)
    const snapshot = second.recover(dir)
    expect(snapshot?.state.status).toBe('paused')
    expect(snapshot?.state.visits.checks).toBe(1)
    expect(snapshot?.state.history.at(-1)?.outcome).toBe('interrupted')
    second.resume(dir)
    await until(() => second.activeRun(dir)?.isFinal() === true)
    expect(second.activeRun(dir)?.state.result).toBe('success')
  })

  it('acts and waits in one call: start and answer return the next event', async () => {
    const dir = project('p4', guideExample())
    const manager = new PipelineManager(environment((label) => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [], pipelineIssues: [] } } : happy(label)))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const started = await callWith(server, dir, 'tab-1', 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] }, wait: 5 })
    const escalation = JSON.parse(started.split('\n').pop()!) as { type: string; data: { escalationId: string; actions: string[] } }
    expect(escalation).toMatchObject({ type: 'escalation', data: { node: 'implement', actions: ['continue', 'retry', 'stop'] } })
    const answered = await callWith(server, dir, 'tab-1', 'pipeline_answer', { escalationId: escalation.data.escalationId, action: 'continue', text: 'go on', wait: 5 })
    expect(JSON.parse(answered.split('\n').pop()!)).toMatchObject({ type: 'run_finished', data: { report: { result: 'success', decisions: [{ step: 'implement', action: 'continue', text: 'go on' }] } } })
  })

  it('a wait returns early when the user types in the waiting agent\'s tab', async () => {
    const dir = project('p5', guideExample())
    const manager = new PipelineManager(environment(happy))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const waiting = callWith(server, dir, 'tab-9', 'pipeline_wait', { runId: 'no-such-run', timeoutSec: 30 })
    await new Promise((r) => setTimeout(r, 50))
    orchestrators.userInput('tab-other', 'hello\r') // another tab: ignored
    orchestrators.userInput('tab-9', 'hel')         // not submitted yet: ignored
    orchestrators.userInput('tab-9', '\r')
    expect(JSON.parse(await waiting)).toMatchObject({ type: 'user_input' })
  })

  it('after an AIDE restart, a run waiting on an escalation is re-announced with continuing event ids', async () => {
    const dir = project('p6', guideExample())
    const env = environment((label) => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [], pipelineIssues: [] } } : happy(label))
    const first = new PipelineManager(env)
    const { runId } = await first.start(dir, 'code-feature', { taskSpec: 'X', acceptance: [] })
    await until(() => first.activeRun(dir)?.state.status === 'waiting')
    const lastId = pipelineEvents.since(dir, runId, 0).at(-1)!.id
    pipelineEvents.reset(dir) // the event bus lives in memory: AIDE restarted

    const second = new PipelineManager(env)
    expect(second.recover(dir)?.state.status).toBe('waiting')
    const [again] = pipelineEvents.since(dir, runId, lastId)
    expect(again).toMatchObject({ type: 'escalation', data: { node: 'implement', summary: expect.stringContaining('AIDE restarted') } })
    expect(again.id).toBeGreaterThan(lastId)
    await second.answer(dir, String(again.data.escalationId), { action: 'continue', text: 'proceed', by: 'user' })
    await until(() => second.activeRun(dir)?.isFinal() === true)
    expect(second.activeRun(dir)?.state.result).toBe('success')
  })

  it('after an AIDE restart, a run that was retrying an unavailable CLI goes on retrying by itself', async () => {
    vi.useFakeTimers()
    try {
      const dir = project('p7', guideExample())
      const unavailable = { ok: false, error: { code: 'unavailable' as const, message: 'Selected model is at capacity.' } }
      const first = new PipelineManager(environment((label) => label.endsWith(':implement') ? unavailable : happy(label)))
      const { runId } = await first.start(dir, 'code-feature', { taskSpec: 'X', acceptance: [] })
      await vi.advanceTimersByTimeAsync(0)
      expect(first.activeRun(dir)?.state.unavailable).toMatchObject({ node: 'implement', attempts: 1 })
      const lastId = pipelineEvents.since(dir, runId, 0).at(-1)!.id
      pipelineEvents.reset(dir)

      const second = new PipelineManager(environment(happy))
      second.recover(dir)
      await vi.advanceTimersByTimeAsync(0)
      expect(second.activeRun(dir)?.state.result).toBe('success')
      expect(pipelineEvents.since(dir, runId, lastId).some((e) => e.type === 'run_paused')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the git setup of a run', () => {
  /** The test environment with real git reads and the real config resolution; records the agents' prompts. */
  function gitEnvironment(agent: (label: string) => Partial<HeadlessResult>, prompts: Map<string, string>): ManagerEnvironment {
    const env = environment(agent)
    const deps = env.deps
    return {
      ...env,
      deps: (p) => {
        const base = deps(p)
        return {
          ...base,
          startAgent: (request) => { prompts.set(request.label, request.prompt); return base.startAgent(request) },
          git: { workingDiff, stagedDiff, status, headSha, commitIndex }
        }
      },
      gitSetup: (p) => resolveGitSetup(p)
    }
  }

  async function initRepo(dir: string, file: string): Promise<void> {
    mkdirSync(dir, { recursive: true })
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await git(dir, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, file), 'one\n')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'init'])
  }

  it('an invalid git config refuses pipeline_start with the list of problems; pipeline_validate reports them', async () => {
    const dir = project('g1', guideExample())
    await initRepo(join(dir, 'frontend'), 'a.ts')
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: { repos: { 'bad id': 'frontend', api: 'backend', src: 'frontend/src' } } }))
    mkdirSync(join(dir, 'frontend', 'src'))
    const manager = new PipelineManager(gitEnvironment(happy, new Map()))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const refused = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] } })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('The "git" setting in aide/config.json is invalid:')
    expect(refused.text).toContain('- Repo id "bad id" may only contain letters, digits, "_" and "-".')
    expect(refused.text).toContain('- git.repos.api: "backend" does not exist.')
    expect(refused.text).toContain('- git.repos.src: "frontend/src" is inside the repository at "frontend", not its top level')
    expect(manager.activeRun(dir)).toBeNull()
    const validated = await call(server, dir, 'pipeline_validate')
    expect(validated.data?.project).toMatchObject({ git: 'git: invalid config', errors: expect.arrayContaining(['aide/config.json: git.repos.api: "backend" does not exist.']) })
  })

  it('a project whose root is not a repo starts a run; run.diff is a note and the commit step asks', async () => {
    const dir = project('g2', guideExample())
    const prompts = new Map<string, string>()
    const manager = new PipelineManager(gitEnvironment(happy, prompts))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] } })
    expect(started.isError).toBeUndefined()
    expect(started.text).toContain('no-git mode')
    const runId = /Run (\S+) started/.exec(started.text)![1]
    expect(manager.activeRun(dir)?.state.git).toEqual({ mode: 'none' })
    const event = await call(server, dir, 'pipeline_wait', { runId, timeoutSec: 5 })
    expect(event.data).toMatchObject({ type: 'escalation', data: { node: 'commit', kind: 'engine' } })
    expect(String((event.data?.data as Record<string, unknown>).message)).toContain('no-git mode')
    expect(manager.runState(dir)?.history.map((h) => h.node)).toEqual(['implement', 'checks', 'review', 'commitPrep', 'commit'])
    expect(prompts.get('codex:review')).toContain(NO_GIT_DIFF.trim())
    expect((await call(server, dir, 'pipeline_validate')).data?.project).toMatchObject({ git: expect.stringMatching(/^git: none/), errors: [] })
  })

  /** The guide's example with a `repo` on its commit step (and a `repo` param when it is a template). */
  function exampleCommittingIn(repo: string): MachineDefinition {
    const machine = guideExample()
    if (repo.includes('{{')) machine.params = { ...machine.params, repo: { type: 'string' } }
    const commit = machine.steps.find((s) => s.type === 'commit') as Extract<MachineDefinition['steps'][number], { type: 'commit' }>
    commit.repo = repo
    return machine
  }

  it('with several repos, pipeline_start refuses a commit step without repo and names it and the repo ids', async () => {
    const dir = project('g4', guideExample())
    await initRepo(join(dir, 'frontend'), 'a.ts')
    await initRepo(join(dir, 'backend'), 'main.go')
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: { repos: { web: 'frontend', api: 'backend' } } }))
    const manager = new PipelineManager(gitEnvironment(happy, new Map()))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const refused = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] } })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Commit step "commit" must name its repo ("repo": one of web, api).')
    expect(manager.activeRun(dir)).toBeNull()
  })

  it('"repo": "{{params.repo}}" commits in that repo; changes in the other repo do not fail it and are reported', async () => {
    const dir = project('g5', exampleCommittingIn('{{params.repo}}'))
    await initRepo(join(dir, 'frontend'), 'a.ts')
    await initRepo(join(dir, 'backend'), 'main.go')
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: { repos: { web: 'frontend', api: 'backend' } } }))
    writeFileSync(join(dir, 'frontend', 'a.ts'), 'two\n')
    await git(join(dir, 'frontend'), ['add', 'a.ts'])
    writeFileSync(join(dir, 'backend', 'new.go'), 'package main\n')
    const manager = new PipelineManager(gitEnvironment(happy, new Map()))
    const ended = new Promise<string>((resolve) => manager.on('event', (_p, _r, type: string) => { if (['run_finished', 'run_failed', 'escalation'].includes(type)) resolve(type) }))
    const { runId } = await manager.start(dir, 'code-feature', { taskSpec: 'Y', acceptance: [], repo: 'web' })
    expect(manager.activeRun(dir)?.state.commitRepos).toEqual({ commit: 'web' })
    expect(await ended).toBe('run_finished')
    const report = manager.report(dir, runId)!
    expect(report.commits).toMatchObject([{ files: ['frontend/a.ts'], message: 'Add X', repo: 'web' }])
    expect(report.uncommitted).toEqual(['backend/new.go'])
    expect((await git(join(dir, 'frontend'), ['log', '-1', '--format=%s'])).stdout.trim()).toBe('Add X')
    expect((await git(join(dir, 'backend'), ['log', '--format=%s'])).stdout.trim()).toBe('init')
  })

  it('a report asked for while the final one is being written carries the reason the run ended', async () => {
    const dir = project('g7', guideExample())
    const env = environment((label) => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [], pipelineIssues: [] } } : happy(label))
    let hold = false
    let release = (): void => {}
    const manager = new PipelineManager({
      ...env,
      deps: (p) => {
        const base = env.deps(p)
        return { ...base, git: { ...base.git, status: async (scope, repoId) => { if (hold) await new Promise<void>((resolve) => { release = resolve }); return base.git.status(scope, repoId) } } }
      }
    })
    const waiting = new Promise<void>((resolve) => manager.on('event', (_p, _r, type: string) => { if (type === 'escalation') resolve() }))
    const { runId } = await manager.start(dir, 'code-feature', { taskSpec: 'Y', acceptance: [] })
    await waiting

    hold = true
    const abandoning = manager.abandon(dir, 'giving up')
    expect(manager.activeRun(dir)?.isFinal()).toBe(true)
    expect(manager.report(dir, runId)).toMatchObject({ result: 'failure', reason: 'abandoned: giving up', note: expect.stringContaining('being written') })

    hold = false
    release()
    await abandoning
    const final = manager.report(dir, runId)!
    expect(final).toMatchObject({ result: 'failure', reason: 'abandoned: giving up' })
    expect(final.note).toBeUndefined()
  })

  it('a repo id the project does not have refuses the start', async () => {
    const dir = project('g6', exampleCommittingIn('{{params.repo}}'))
    await initRepo(join(dir, 'frontend'), 'a.ts')
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: { repos: { web: 'frontend' } } }))
    const manager = new PipelineManager(gitEnvironment(happy, new Map()))
    await expect(manager.start(dir, 'code-feature', { taskSpec: 'Y', acceptance: [], repo: 'api' })).rejects.toThrow('Commit step "commit": "api" is not a repo of this project (web).')
  })

  it('with git.repos, the dirty-tree warning and the abandon list span every repo', async () => {
    const dir = project('g3', exampleCommittingIn('web'))
    await initRepo(join(dir, 'frontend'), 'a.ts')
    await initRepo(join(dir, 'backend'), 'main.go')
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: { repos: { web: 'frontend', api: 'backend' } } }))
    writeFileSync(join(dir, 'frontend', 'a.ts'), 'two\n')
    writeFileSync(join(dir, 'backend', 'new.go'), 'package main\n')
    const planWrong = (label: string): Partial<HeadlessResult> => label.endsWith(':implement') ? { structured: { status: 'plan_wrong', summary: 'bad idea', docsChanged: [], pipelineIssues: [] } } : happy(label)
    const manager = new PipelineManager(gitEnvironment(planWrong, new Map()))
    const server = new McpServer({ name: 'aide', version: 't', instructions: '' }, () => buildPipelineTools(() => ({ aideVersion: 't', launcherPath: 'l', manager })))
    const started = await call(server, dir, 'pipeline_start', { machine: 'code-feature', params: { taskSpec: 'Y', acceptance: [] }, wait: 5 })
    expect(started.text).toContain('The working tree has 2 uncommitted change(s)')
    expect(manager.activeRun(dir)?.state.git).toMatchObject({ mode: 'git', repos: [{ id: 'web', path: 'frontend' }, { id: 'api', path: 'backend' }], commits: true })
    // A config edit does not change the running run.
    writeFileSync(join(dir, 'aide', 'config.json'), JSON.stringify({ git: false }))
    const abandoned = await call(server, dir, 'pipeline_stop', { mode: 'abandon', reason: 'test' })
    expect(abandoned.text).toContain('Uncommitted changes left in the working tree (2): frontend/a.ts (modified), backend/new.go (untracked)')
  })
})
