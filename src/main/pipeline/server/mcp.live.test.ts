import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { PipelineServer } from './pipelineServer'
import { buildPipelineTools } from '../mcp/tools'
import { orchestrators, type OrchestratorConnection } from '../orchestrators'
import { runProcess } from '../processRunner'
import { resolveExecutable } from '../headless/common'
import { getSessionsDir } from '../../pty/cliTools/claudeCodeScanner'

// Real agent CLIs connect to the pipeline server through the stdio shim and call
// pipeline_hello — the Phase 0 acceptance check for §5.4/§5.5.
// Opt in: AIDE_LIVE_MCP=1 npx vitest run mcp.live
const live = process.env.AIDE_LIVE_MCP === '1'
if (live) vi.setConfig({ testTimeout: 300_000 })

const SHIM = resolve(__dirname, '../../../../resources/mcp/aide-mcp.cjs')
const PROMPT = 'Call the pipeline_hello tool of the "aide" MCP server and reply with the AIDE version it reports. Do nothing else.'

describe.skipIf(!live)('pipeline MCP with real agent CLIs (live)', () => {
  let root = ''
  let runtimeDir = ''
  let project = ''
  const server = new PipelineServer()
  const launch = (): { command: string; args: string[]; env: Record<string, string> } => ({
    // Node stands in for the AIDE executable; ELECTRON_RUN_AS_NODE is what makes AIDE.exe behave like it.
    command: process.execPath,
    args: [SHIM, 'mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1', AIDE_RUNTIME_DIR: runtimeDir }
  })

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aide-live-mcp-'))
    runtimeDir = join(root, 'runtime')
    project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    server.registerProject(project)
    await server.start({
      runtimeDir,
      serverName: 'aide',
      serverVersion: '9.9.9-live',
      instructions: 'AIDE pipeline server (live test).',
      tools: () => buildPipelineTools(() => ({ aideVersion: '9.9.9-live', launcherPath: 'aide-pipeline', docPath: '.aide/docs/orchestration-mcp.md' }))
    })
  })

  afterAll(async () => {
    await server.stop()
    rmSync(getSessionsDir(project), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  function nextConnection(): Promise<OrchestratorConnection> {
    return new Promise((resolveConnection) => orchestrators.once('connected', resolveConnection))
  }

  it('Claude Code connects and completes pipeline_hello', async () => {
    const claude = resolveExecutable('claude')
    expect(claude).toBeTruthy()
    const connected = nextConnection()
    const mcpConfig = JSON.stringify({ mcpServers: { aide: { type: 'stdio', ...launch() } } })
    let output = ''
    const run = runProcess({
      command: claude!,
      args: ['-p', '--model', 'haiku', '--mcp-config', mcpConfig, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__aide__pipeline_hello'],
      cwd: project,
      env: process.env,
      stdin: PROMPT,
      timeoutMs: 240_000,
      label: 'live-mcp-claude',
      onStdoutLine: (line) => { output += line + '\n' }
    })
    const result = await run.done
    expect(result.exitCode).toBe(0)
    const connection = await connected
    expect(connection.projectPath).toBe(project)
    expect(connection.client?.name).toBeTruthy()
    expect(output).toContain('9.9.9-live')
  })

  it('Codex connects and completes pipeline_hello', async () => {
    const codex = resolveExecutable('codex')
    expect(codex).toBeTruthy()
    const connected = nextConnection()
    const { command, args, env } = launch()
    const toml = (value: string): string => `'${value}'` // TOML literal string: no escaping of backslashes
    let output = ''
    const run = runProcess({
      command: codex!,
      args: [
        'exec', '--skip-git-repo-check', '--ignore-user-config', '--color', 'never', '--cd', project,
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', `mcp_servers.aide.command=${toml(command)}`,
        '-c', `mcp_servers.aide.args=[${args.map(toml).join(', ')}]`,
        '-c', `mcp_servers.aide.env={ ${Object.entries(env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`,
        '-'
      ],
      cwd: project,
      env: process.env,
      stdin: PROMPT,
      timeoutMs: 240_000,
      label: 'live-mcp-codex',
      onStdoutLine: (line) => { output += line + '\n' }
    })
    const result = await run.done
    expect(result.exitCode).toBe(0)
    const connection = await connected
    expect(connection.projectPath).toBe(project)
    expect(connection.client?.name).toBeTruthy()
    expect(output).toContain('9.9.9-live')
  })
})
