import { app, BrowserWindow } from 'electron'
import { viewerService } from '../viewer/viewerService'
import { readFileSync } from 'fs'
import { join, relative, sep } from 'path'
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
import { commitIndex, commitsSince, headSha, stagedDiff, status, workingDiff } from './git'
import { checkRepos, resolveGitSetup } from './gitConfig'
import { ShadowStore } from './shadow'
import { PlanService } from './plan/planService'
import { tabCacheTtl } from './promptCache'
import { smokeTestMachine } from './smoke'
import { TaskService } from '../tasks/taskService'
import { isTrackerPath } from '../tasks/taskStore'
import { ptyRegistry } from '../pty/registry'
import { AgentMessagingService } from '../agents/agentMessaging'
import { addFsChangeObserver } from '../filetree/watcher'
import { projectFeatures } from '../config/features'
import { featureBusyReason } from './featureBusy'
import { PLAN_RUN_OFF_TEXT, featureOffText, toolFeature, type FeatureName } from '../../shared/features'

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
  deps: (projectPath) => ({
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
    git: { workingDiff, stagedDiff, status, headSha, commitIndex, checkRepos },
    shadow: new ShadowStore(getProjectUserPath(projectPath, 'shadow')),
    accountPool: poolHandles
  }),
  gitSetup: (projectPath) => resolveGitSetup(projectPath)
})

/** Run views (the desktop pipeline tab, the remote pipeline page) read and control runs through this. */
export const pipelineView = new PipelineViewService(pipelineManager)

/** Plans of the open projects; the MCP tools, the plan tab and the remote page work through this. */
export const planService = new PlanService(pipelineManager, {
  userDir: (projectPath) => getProjectUserPath(projectPath, 'plans'),
  headSha,
  commitsSince,
  // Plans run through pipelines: with pipelines off the autopilot cannot start (§10 of the tracker implementation doc).
  runRefusal: (projectPath) => projectFeatures(projectPath).pipelines ? null : PLAN_RUN_OFF_TEXT
})

/**
 * Why `feature` cannot be turned off in `projectPath` now, or null: pipelines while a run
 * is running or the plan autopilot is working, plans while the autopilot is working.
 */
export function featureBusy(projectPath: string, feature: FeatureName): string | null {
  const run = pipelineManager.activeRun(projectPath)
  return featureBusyReason(projectPath, feature, {
    run: run ? { runId: run.runId, status: run.state.status } : null,
    autopilotPlan: planService.autopilotWorking(projectPath)
  })
}

/** The task trackers of the open projects; the MCP tools and the tasks tab work through this. */
export const taskService = new TaskService({
  userDir: (projectPath) => getProjectUserPath(projectPath, 'tasks'),
  liveTab,
  runActive: (projectPath) => pipelineManager.activeRun(projectPath) !== null
})

/** Inter-agent discovery and messaging across local and peer AIDE windows. */
export const agentMessaging = new AgentMessagingService({
  managers: () => ptyRegistry.values(),
  agentsEnabled: (projectPath) => projectFeatures(projectPath).agents,
  tabTasks: (projectPath) => projectFeatures(projectPath).tracker ? taskService.tabTasks(projectPath) : {},
  runtimeDir,
  localPort: () => pipelineServer.getPort()
})

/** Whether a tab id names a terminal tab open in this AIDE. */
function liveTab(tabId: string): boolean {
  for (const mgr of ptyRegistry.values()) if (mgr.getTabs().some((tab) => tab.tabId === tabId)) return true
  return false
}

/** The tracker part of the server instructions for a session that starts; its tracker tail counts from now. */
function trackerOrientation(projectPath: string, connectionId: string): string {
  try {
    const text = taskService.orientation(projectPath)
    taskService.beginConnection(projectPath, connectionId)
    return text
  } catch (err) {
    logEvent('task-orientation-failed', { projectPath, message: err instanceof Error ? err.message : String(err) }, 'warn')
    return ''
  }
}

function taskGuide(): string {
  return readFileSync(join(__dirname, '../../resources/docs/task-guide.md'), 'utf8')
}

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
  agentMessaging.attach()
  try {
    launcherPath = writeLauncher(runtimeDir(), process.execPath, shimPath())
    await pipelineServer.start({
      runtimeDir: runtimeDir(),
      serverName: 'aide',
      serverVersion: app.getVersion(),
      agentHandlers: {
        list: () => agentMessaging.listLocal(),
        send: (req) => agentMessaging.deliverLocal(req)
      },
      // A feature switched off in Settings leaves its part out; with the tracker off no tail starts.
      instructions: (context) => {
        const features = projectFeatures(context.projectPath)
        return serverInstructions(workInstruction(), features.tracker ? trackerOrientation(context.projectPath, context.connectionId) : '', features)
      },
      // The switches of the asking project, read for every request (a client reads the list at initialize).
      unavailableTool: (name, context) => {
        const feature = toolFeature(name)
        return feature && !projectFeatures(context.projectPath)[feature] ? featureOffText(feature) : null
      },
      tools: (context) => {
        const features = projectFeatures(context.projectPath)
        return buildPipelineTools(() => ({
          aideVersion: app.getVersion(),
          launcherPath,
          manager: pipelineManager,
          authoringGuide,
          smoke: (projectPath, machineId, pingAgents) => smokeTestMachine(pipelineManager, projectPath, machineId, pingAgents),
          plans: planService,
          planGuide,
          tasks: taskService,
          taskGuide,
          liveTab,
          toolbarGuide,
          workInstruction,
          cacheTtl: tabCacheTtl,
          features,
          viewShow: (projectPath, tabId, args) => viewerService.show(projectPath, tabId, args),
          agents: {
            list: (projectPath, tabId, scope) => agentMessaging.listAgents(projectPath, tabId, scope),
            send: (projectPath, tabId, to, message) => agentMessaging.sendMessage(projectPath, tabId, to, message)
          }
        }))
      }
    })
    logEvent('pipeline-server-started', { port: pipelineServer.getPort() })
    // CLI tabs get AIDE's MCP server at launch, with the paths of this AIDE.
    const launch = shimLaunch(process.execPath, shimPath(), runtimeDir())
    setLaunchMcpProvider((tool, tabId, projectPath) => {
      if (!pipelineServer.isRunning()) return []
      const eagerTools = buildPipelineTools(() => ({
        aideVersion: app.getVersion(),
        launcherPath,
        features: projectFeatures(projectPath)
      })).map((t) => t.name)
      return aideMcpServers(tool, tabId, projectPath, launch, eagerTools)
    })
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
  // A write of the service comes back through the FS watcher as a second 'changed': the
  // window hears of a change only when what a view shows differs from the last notice.
  let tasksKey: string | null = null
  const onTasksChanged = (path: string): void => {
    if (path !== projectPath) return
    let key: string | null = null
    try {
      key = taskService.changeKey(projectPath)
    } catch (err) {
      logEvent('task-change-key-failed', { projectPath, message: err instanceof Error ? err.message : String(err) }, 'warn')
    }
    if (key !== null && key === tasksKey) return
    tasksKey = key
    send('tasks:changed', projectPath)
  }
  taskService.on('changed', onTasksChanged)
  // The FS watcher skips dot paths only: changes under aide/tasks/ reach it, the lease file does not.
  // aide/config.json may carry the project layer of the feature switches (put there by hand):
  // the window reads its switches again, as it does after Settings saves them.
  const stopTaskWatch = addFsChangeObserver((path, fullPath) => {
    if (path !== projectPath) return
    const inProject = relative(projectPath, fullPath)
    if (isTrackerPath(inProject)) taskService.notifyDiskChange(projectPath)
    if (inProject.split(sep).join('/') === 'aide/config.json') send('features:changed', projectPath)
  })
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
    taskService.off('changed', onTasksChanged)
    stopTaskWatch()
    taskService.forget(projectPath)
    planService.forget(projectPath)
    pipelineManager.forget(projectPath)
    orchestrators.forgetProject(projectPath)
    pipelineServer.unregisterProject(projectPath)
  }
}
