import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logEvent } from '../diagnostics'
import { pipelineServer } from './server/pipelineServer'
import { shimLaunch, writeLauncher, type ShimLaunch } from './server/runtimeFiles'
import { buildPipelineTools, ORCHESTRATOR_RULES } from './mcp/tools'
import { orchestrators, type OrchestratorConnection } from './orchestrators'

/**
 * Pipeline bootstrap for the main process: the local pipeline server, the
 * agent-facing shim/launcher, the orchestration doc, and per-project wiring.
 * See docs/pipeline-orchestration-plan.md §1A.
 */

export const ORCHESTRATION_DOC = '.aide/docs/orchestration-mcp.md'

let launcherPath = ''

function runtimeDir(): string {
  return join(app.getPath('userData'), 'runtime')
}

/** The shim must live outside app.asar so a plain Node-mode process can execute it. */
function shimPath(): string {
  return join(__dirname, '../../resources/mcp/aide-mcp.cjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export async function startPipelineServer(): Promise<void> {
  try {
    launcherPath = writeLauncher(runtimeDir(), process.execPath, shimPath())
    await pipelineServer.start({
      runtimeDir: runtimeDir(),
      serverName: 'aide',
      serverVersion: app.getVersion(),
      instructions: ORCHESTRATOR_RULES.join(' ') + ` Call pipeline_hello first. Reference: ${ORCHESTRATION_DOC}`,
      tools: () => buildPipelineTools(() => ({ aideVersion: app.getVersion(), launcherPath, docPath: ORCHESTRATION_DOC }))
    })
    logEvent('pipeline-server-started', { port: pipelineServer.getPort() })
  } catch (err) {
    // Orchestration becomes unavailable; the editor itself is unaffected.
    logEvent('pipeline-server-start-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
  }
}

export async function stopPipelineServer(): Promise<void> {
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

/** Wire a newly opened project: discovery file, doc, orchestrator notifications to its window. */
export function attachPipelineProject(projectPath: string, win: BrowserWindow): () => void {
  pipelineServer.registerProject(projectPath)
  try { deployOrchestrationDoc(projectPath) } catch (err) {
    logEvent('orchestration-doc-deploy-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
  }
  const onConnected = (connection: OrchestratorConnection): void => {
    if (connection.projectPath === projectPath && !win.isDestroyed()) win.webContents.send('pipeline:orchestrator-connected', connection)
  }
  orchestrators.on('connected', onConnected)
  return () => {
    orchestrators.off('connected', onConnected)
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
