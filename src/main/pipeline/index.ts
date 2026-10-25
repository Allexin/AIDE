import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logEvent } from '../diagnostics'
import { pipelineServer } from './server/pipelineServer'
import { shimLaunch, writeLauncher, type ShimLaunch } from './server/runtimeFiles'
import { buildPipelineTools, ORCHESTRATOR_RULES } from './mcp/tools'
import { orchestrators, type OrchestratorConnection } from './orchestrators'
import { PipelineManager, type RunSnapshot } from './manager'
import { sharedPipelinesDir } from './engine/library'
import { getProjectUserPath } from '../config/projectUserData'
import { getRegisteredTools, getToolById } from '../pty/cliTools/registry'
import { startHeadless } from './headless'
import { AccountPool } from './accountPool'
import { failedRun } from './headless/common'
import { killAllProcessTreesSync, runShellCommand } from './processRunner'
import { commitIndex, headSha, stagedDiff, status, workingDiff } from './git'
import { smokeTestMachine } from './smoke'
import type { HistoryEntry } from '../pty/cliTools/types'

/**
 * Pipeline bootstrap for the main process: the local pipeline server, the
 * agent-facing shim/launcher, the orchestration doc, and per-project wiring.
 * See docs/pipeline-orchestration-plan.md §1A.
 */

export const ORCHESTRATION_DOC = '.aide/docs/orchestration-mcp.md'

let launcherPath = ''

export const pipelineManager = new PipelineManager({
  runsRoot: (projectPath) => getProjectUserPath(projectPath, 'runs'),
  libraryDirs: (projectPath) => [
    { dir: sharedPipelinesDir(projectPath), source: 'shared' },
    { dir: getProjectUserPath(projectPath, 'pipelines'), source: 'personal' }
  ],
  headlessClis: () => getRegisteredTools().filter((tool) => tool.headless).map((tool) => tool.id),
  deps: () => ({
    startAgent: ({ cli, ...options }) => {
      const tool = getToolById(cli)
      return tool ? startHeadless(tool, options) : failedRun('not_installed', `CLI "${cli}" is not registered in AIDE`)
    },
    runCheck: ({ commandLine, cwd, timeoutMs, label, onOutput }) =>
      runShellCommand({ commandLine, cwd, timeoutMs, label, onStdoutLine: (line) => onOutput(line + '\n'), onStderr: onOutput }),
    git: { workingDiff, stagedDiff, status, headSha, commitIndex }
  })
})

function authoringGuide(): string {
  return readFileSync(join(__dirname, '../../resources/docs/pipeline-authoring.md'), 'utf8')
}

function runtimeDir(): string {
  return join(app.getPath('userData'), 'runtime')
}

/** The shim must live outside app.asar so a plain Node-mode process can execute it. */
function shimPath(): string {
  return join(__dirname, '../../resources/mcp/aide-mcp.cjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export async function startPipelineServer(): Promise<void> {
  new AccountPool(pipelineManager).attach()
  try {
    launcherPath = writeLauncher(runtimeDir(), process.execPath, shimPath())
    await pipelineServer.start({
      runtimeDir: runtimeDir(),
      serverName: 'aide',
      serverVersion: app.getVersion(),
      instructions: ORCHESTRATOR_RULES.join(' ') + ` Call pipeline_hello first. Reference: ${ORCHESTRATION_DOC}`,
      tools: () => buildPipelineTools(() => ({
        aideVersion: app.getVersion(),
        launcherPath,
        docPath: ORCHESTRATION_DOC,
        manager: pipelineManager,
        authoringGuide,
        smoke: (projectPath, machineId, pingAgents) => smokeTestMachine(pipelineManager, projectPath, machineId, pingAgents)
      }))
    })
    logEvent('pipeline-server-started', { port: pipelineServer.getPort() })
  } catch (err) {
    // Orchestration becomes unavailable; the editor itself is unaffected.
    logEvent('pipeline-server-start-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
  }
}

/**
 * On quit: kill running agents and checks synchronously (the process may exit
 * before async work completes), then drop the discovery files. Interrupted runs
 * are recovered as paused when the project opens next time.
 */
export async function stopPipelineServer(): Promise<void> {
  pipelineManager.prepareShutdown()
  killAllProcessTreesSync()
  await pipelineServer.stop()
}

/** Copy the bundled orchestration doc into the project when missing or outdated. */
function deployOrchestrationDoc(projectPath: string): void {
  const bundled = join(__dirname, '../../resources/docs/orchestration-mcp.md')
  if (!existsSync(bundled)) return
  const destination = join(projectPath, ORCHESTRATION_DOC)
  const content = readFileSync(bundled, 'utf8')
  if (existsSync(destination) && readFileSync(destination, 'utf8') === content) return
  mkdirSync(join(projectPath, '.aide', 'docs'), { recursive: true })
  writeFileSync(destination, content, 'utf8')
}

/** Wire a newly opened project: discovery file, doc, run notifications to its window. */
export function attachPipelineProject(projectPath: string, win: BrowserWindow): () => void {
  pipelineServer.registerProject(projectPath)
  try { deployOrchestrationDoc(projectPath) } catch (err) {
    logEvent('orchestration-doc-deploy-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
  }
  const send = (channel: string, payload: unknown): void => { if (!win.isDestroyed()) win.webContents.send(channel, payload) }
  const onState = (path: string, snapshot: RunSnapshot): void => { if (path === projectPath) send('pipeline:run-state', snapshot) }
  const onTranscript = (path: string, runId: string, node: string, visit: number, entry: HistoryEntry): void => {
    if (path === projectPath) send('pipeline:transcript', { runId, node, visit, entry })
  }
  pipelineManager.on('state', onState)
  pipelineManager.on('transcript', onTranscript)
  try { pipelineManager.recover(projectPath) } catch (err) {
    logEvent('pipeline-recover-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
  }

  return () => {
    pipelineManager.off('state', onState)
    pipelineManager.off('transcript', onTranscript)
    pipelineManager.forget(projectPath)
    orchestrators.forgetProject(projectPath)
    pipelineServer.unregisterProject(projectPath)
  }
}

export interface OrchestrationSetup {
  available: boolean
  /** stdio MCP server launch spec to put into the agent's MCP configuration. */
  mcp: ShimLaunch
  /** Shell launcher for the event feed. */
  launcherPath: string
  docPath: string
  connected: OrchestratorConnection[]
}

export function getOrchestrationSetup(projectPath: string): OrchestrationSetup {
  return {
    available: pipelineServer.isRunning(),
    mcp: shimLaunch(process.execPath, shimPath(), runtimeDir()),
    launcherPath,
    docPath: ORCHESTRATION_DOC,
    connected: orchestrators.forProject(projectPath)
  }
}
