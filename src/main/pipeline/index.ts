import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { logEvent } from '../diagnostics'
import { pipelineServer } from './server/pipelineServer'
import { shimLaunch, writeLauncher } from './server/runtimeFiles'
import { AIDE_WORK_INSTRUCTION, buildPipelineTools, serverInstructions } from './mcp/tools'
import { getAppConfig } from '../config/appConfig'
import { orchestrators } from './orchestrators'
import { setLaunchMcpProvider } from '../pty/ptyManager'
import { aideMcpServers } from '../aideMcp/launch'
import { PipelineManager } from './manager'
import { PipelineViewService } from './viewService'
import { sharedPipelinesDir } from './engine/library'
import { getProjectUserPath } from '../config/projectUserData'
import { getRegisteredTools, getToolById } from '../pty/cliTools/registry'
import { startHeadless } from './headless'
import { AccountPool, poolHandles } from './accountPool'
import { EventRelay } from './eventRelay'
import { failedRun } from './headless/common'
import { killAllProcessTreesSync, runShellCommand } from './processRunner'
import { commitIndex, commitsSince, headSha, stagedDiff, stagePaths, status, workingDiff } from './git'
import { PlanService } from './plan/planService'
import { tabCacheTtl } from './promptCache'
import { smokeTestMachine } from './smoke'

/**
 * Pipeline bootstrap for the main process: the local pipeline server, the
 * agent-facing shim/launcher, and per-project wiring.
 * See docs/pipeline-orchestration-plan.md §1A.
 */


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
      if (!tool) return failedRun('not_installed', `CLI "${cli}" is not registered in AIDE`)
      // CLIs without a structured-output mode take the answer as a tool call (see ResultTool).
      const channel = tool.headless?.resultTool && options.outputSchema ? pipelineServer.openResultChannel(options.cwd, options.outputSchema) : null
      if (!channel) return startHeadless(tool, options)
      const run = startHeadless(tool, { ...options, resultTool: channel })
      return { result: run.result.finally(() => channel.close()), cancel: () => run.cancel() }
    },
    runCheck: ({ commandLine, cwd, timeoutMs, label, onOutput }) =>
      runShellCommand({ commandLine, cwd, timeoutMs, label, onStdoutLine: (line) => onOutput(line + '\n'), onStderr: onOutput }),
    git: { workingDiff, stagedDiff, status, headSha, commitIndex },
    accountPool: poolHandles
  })
})

/** Run views (the desktop pipeline tab, the remote pipeline page) read and control runs through this. */
export const pipelineView = new PipelineViewService(pipelineManager)

/** Plans of the open projects; the MCP tools, the plan tab and the remote page work through this. */
export const planService = new PlanService(pipelineManager, {
  userDir: (projectPath) => getProjectUserPath(projectPath, 'plans'),
  stage: stagePaths,
  headSha,
  commitsSince
})

function planGuide(): string {
  return readFileSync(join(__dirname, '../../resources/docs/plan-guide.md'), 'utf8')
}

function authoringGuide(): string {
  return readFileSync(join(__dirname, '../../resources/docs/pipeline-authoring.md'), 'utf8')
}

function toolbarGuide(): string {
  return readFileSync(join(__dirname, '../../resources/docs/toolbar.md'), 'utf8')
}

/** The work instruction in effect: the user's override from Settings, or AIDE's. */
function workInstruction(): string {
  return getAppConfig().agents.workInstructionOverride ?? AIDE_WORK_INSTRUCTION
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
  new EventRelay(pipelineManager).attach()
  try {
    launcherPath = writeLauncher(runtimeDir(), process.execPath, shimPath())
    await pipelineServer.start({
      runtimeDir: runtimeDir(),
      serverName: 'aide',
      serverVersion: app.getVersion(),
      instructions: () => serverInstructions(workInstruction()),
      tools: () => buildPipelineTools(() => ({
        aideVersion: app.getVersion(),
        launcherPath,
        manager: pipelineManager,
        authoringGuide,
        smoke: (projectPath, machineId, pingAgents) => smokeTestMachine(pipelineManager, projectPath, machineId, pingAgents),
        plans: planService,
        planGuide,
        toolbarGuide,
        workInstruction,
        cacheTtl: tabCacheTtl
      }))
    })
    logEvent('pipeline-server-started', { port: pipelineServer.getPort() })
    // CLI tabs get AIDE's MCP server at launch, with the paths of this AIDE.
    const launch = shimLaunch(process.execPath, shimPath(), runtimeDir())
    setLaunchMcpProvider((tool, tabId, projectPath) => pipelineServer.isRunning() ? aideMcpServers(tool, tabId, projectPath, launch) : [])
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
  planService.prepareShutdown()
  pipelineManager.prepareShutdown()
  killAllProcessTreesSync()
  await pipelineServer.stop()
}

/** Wire a newly opened project: discovery file, run notifications to its window. */
export function attachPipelineProject(projectPath: string, win: BrowserWindow): () => void {
  pipelineServer.registerProject(projectPath)
  const send = (channel: string, payload: unknown): void => { if (!win.isDestroyed()) win.webContents.send(channel, payload) }
  const unsubscribe = pipelineView.subscribe(projectPath, {
    onState: (snapshot) => send('pipeline:run-state', snapshot),
    onTranscript: (runId, node, visit, entry) => send('pipeline:transcript', { runId, node, visit, entry })
  })
  const onPlanChanged = (path: string): void => { if (path === projectPath) send('plan:snapshot', planService.snapshot(projectPath)) }
  planService.on('changed', onPlanChanged)
  const onDecisionEntry = (path: string, planId: string, decision: number): void => { if (path === projectPath) send('plan:decision-entry', { planId, decision }) }
  planService.on('decision-entry', onDecisionEntry)
  try {
    pipelineManager.recover(projectPath)
    planService.recover(projectPath)
  } catch (err) {
    logEvent('pipeline-recover-failed', { message: err instanceof Error ? err.message : String(err) }, 'warn')
  }

  return () => {
    unsubscribe()
    planService.off('changed', onPlanChanged)
    planService.off('decision-entry', onDecisionEntry)
    planService.forget(projectPath)
    pipelineManager.forget(projectPath)
    orchestrators.forgetProject(projectPath)
    pipelineServer.unregisterProject(projectPath)
  }
}
