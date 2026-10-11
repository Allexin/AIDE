import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { PipelineServer } from './server/pipelineServer'
import { buildPipelineTools } from './mcp/tools'
import { PipelineManager } from './manager'
import { claudeHeadless } from './headless/claudeHeadless'
import { resolveExecutable } from './headless/common'
import { runProcess, runShellCommand } from './processRunner'
import { commitIndex, git, headSha, stagedDiff, status, workingDiff } from './git'
import { pipelineEvents } from './events'
import { getSessionsDir } from '../pty/cliTools/claudeCodeScanner'
import { TINY_TASK, createTinyWorkspace, type TinyWorkspace } from './testing/tinyFeature'

// Phase 3 acceptance: a real agent CLI acts as the orchestrator over MCP —
// lists machines, starts a run, waits for its events and reads the report —
// while the real engine runs real agents, checks and git underneath.
// Opt in: AIDE_LIVE_ORCHESTRATOR=1 npx vitest run orchestrator.live
const live = process.env.AIDE_LIVE_ORCHESTRATOR === '1'
if (live) vi.setConfig({ testTimeout: 1_200_000 })

const SHIM = resolve(__dirname, '../../../resources/mcp/aide-mcp.cjs')

const ORCHESTRATOR_PROMPT = [
  'You are the orchestrator of AIDE pipelines in this project. Use only the tools of the "aide" MCP server.',
  '1. Call pipeline_hello.',
  '2. Call pipeline_list and pick the machine for small changes.',
  `3. Start it with pipeline_start, params: {"taskSpec": "${TINY_TASK}"} and wait 240; it returns the run's next event.`,
  '4. If the event is an escalation, answer it with pipeline_answer action "stop". If it is a timeout, call pipeline_wait with the run id and timeoutSec 240. Repeat until you have run_finished or run_failed.',
  '5. The end event carries a report. Reply with one line: RESULT=<success|failure> COMMIT=<sha of the commit or none>.'
].join('\n')

describe.skipIf(!live)('orchestrator over MCP (live)', () => {
  let ws: TinyWorkspace
  let server: PipelineServer
  let manager: PipelineManager

  beforeEach(async () => {
    ws = await createTinyWorkspace('aide-live-orch-', true)
    manager = new PipelineManager({
      runsRoot: () => ws.runsRoot,
      libraryDirs: (projectPath) => [{ dir: join(projectPath, 'aide', 'pipelines'), source: 'shared' }],
      headlessClis: () => ['claude-code'],
      deps: () => ({
        startAgent: ({ cli: _cli, ...options }) => claudeHeadless.run({ ...options, env: process.env, maxBudgetUsd: 1 }),
        runCheck: ({ commandLine, cwd, timeoutMs, label, onOutput }) => runShellCommand({ commandLine, cwd, timeoutMs, label, onStdoutLine: (l) => onOutput(l + '\n'), onStderr: onOutput }),
        git: { workingDiff, stagedDiff, status, headSha, commitIndex }
      })
    })
    server = new PipelineServer()
    server.registerProject(ws.repo)
    await server.start({
      runtimeDir: join(ws.root, 'runtime'),
      serverName: 'aide',
      serverVersion: 'live',
      instructions: 'AIDE pipeline server (live test).',
      tools: () => buildPipelineTools(() => ({ aideVersion: 'live', launcherPath: 'aide-pipeline', docPath: '.aide/docs/orchestration-mcp.md', manager }))
    })
  })

  afterEach(async () => {
    await server.stop()
    pipelineEvents.reset(ws.repo)
    rmSync(getSessionsDir(ws.repo), { recursive: true, force: true })
    rmSync(ws.root, { recursive: true, force: true })
  })

  async function expectCommitted(output: string): Promise<void> {
    const runs = manager.runs(ws.repo)
    expect(runs[0], `orchestrator output:\n${output}`).toMatchObject({ status: 'finished', result: 'success' })
    expect(readFileSync(join(ws.repo, 'greeting.txt'), 'utf8').trim()).toBe('hello pipeline')
    const sha = (await git(ws.repo, ['rev-parse', 'HEAD'])).stdout.trim()
    expect(output).toContain('RESULT=success')
    expect(output).toContain(sha.slice(0, 7))
  }

  const mcpLaunch = (): { command: string; args: string[]; env: Record<string, string> } => ({
    command: process.execPath, args: [SHIM, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', AIDE_RUNTIME_DIR: join(ws.root, 'runtime') }
  })

  it('Claude Code orchestrates a run to a commit', async () => {
    const config = JSON.stringify({ mcpServers: { aide: { type: 'stdio', ...mcpLaunch() } } })
    let output = ''
    const result = await runProcess({
      command: resolveExecutable('claude')!,
      args: ['-p', '--model', 'haiku', '--mcp-config', config, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__aide'],
      cwd: ws.repo,
      env: { ...process.env, MCP_TOOL_TIMEOUT: '300000' },
      stdin: ORCHESTRATOR_PROMPT,
      timeoutMs: 1_100_000,
      label: 'live-orchestrator-claude',
      onStdoutLine: (line) => { output += line + '\n' }
    }).done
    expect(result.exitCode, result.stderrTail).toBe(0)
    await expectCommitted(output)
  })

  it('Codex orchestrates a run to a commit', async () => {
    const { command, args, env } = mcpLaunch()
    const toml = (value: string): string => `'${value}'`
    let output = ''
    const result = await runProcess({
      command: resolveExecutable('codex')!,
      args: [
        'exec', '--skip-git-repo-check', '--ignore-user-config', '--color', 'never', '--cd', ws.repo,
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', `mcp_servers.aide.command=${toml(command)}`,
        '-c', `mcp_servers.aide.args=[${args.map(toml).join(', ')}]`,
        '-c', `mcp_servers.aide.env={ ${Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`,
        '-c', 'mcp_servers.aide.tool_timeout_sec=300',
        '-'
      ],
      cwd: ws.repo,
      env: process.env,
      stdin: ORCHESTRATOR_PROMPT,
      timeoutMs: 1_100_000,
      label: 'live-orchestrator-codex',
      onStdoutLine: (line) => { output += line + '\n' }
    }).done
    expect(result.exitCode, result.stderrTail).toBe(0)
    await expectCommitted(output)
  })
})
