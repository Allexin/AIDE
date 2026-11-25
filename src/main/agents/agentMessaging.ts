import http from 'http'
import { basename } from 'path'
import { logEvent } from '../diagnostics'
import type { CliTool, AgentDeliverOutcome, AgentDeliverSender } from '../pty/cliTools/types'
import type { SessionTabInfo } from '../pty/ptyManager'
import { tabActivity } from '../pty/tabActivity'
import { listProjectRuntimes, projectRuntimeKey, type ProjectRuntime } from '../pipeline/server/runtimeFiles'

/**
 * Inter-agent messaging across interactive CLI tabs in the current project and
 * across all open AIDE windows / processes on this machine.
 *
 * Discovery reuses `<runtimeDir>/projects/*.json` written by `PipelineServer`:
 * peer AIDE processes are queried over localhost using their per-process token.
 * Delivery calls `CliTool.deliverMessage` when provided, otherwise falls back
 * to PTY bracketed paste (`PtyManager.submitText`), refusing when the user has
 * unsent text in the target tab's input box and queuing until idle when busy.
 */

export type AgentStatus = 'idle' | 'busy' | 'starting'

export interface AgentInfo {
  /** Globally unique address across all open AIDE windows: `<projectKey>:<tabId>`. */
  id: string
  tabId: string
  projectPath: string
  projectName: string
  sameProject: boolean
  toolId: string
  toolName: string
  title: string
  status: AgentStatus
  hasUserDraft: boolean
  isSelf: boolean
  task?: { id: string; title: string }
}

export interface AgentSendResult {
  status: AgentDeliverOutcome['status']
  to: string
  reason?: string
}

export interface AgentDeliverRequest {
  targetProjectPath: string
  tabId: string
  from: AgentDeliverSender
  message: string
}

/** Minimal slice of PtyManager needed by AgentMessagingService (easy to fake in tests). */
export interface AgentPtyManager {
  getProjectPath(): string
  getTabs(): SessionTabInfo[]
  getTabTool(tabId: string): CliTool | null
  isTabReady(tabId: string): boolean
  submitText(tabId: string, text: string): Promise<boolean>
}

export interface AgentActivitySource {
  isIdle(tabId: string): boolean
  hasUserDraft(tabId: string): boolean
  on(event: 'idle' | 'forget', listener: (tabId: string) => void): unknown
  off(event: 'idle' | 'forget', listener: (tabId: string) => void): unknown
}

export interface AgentMessagingDeps {
  managers: () => Iterable<AgentPtyManager>
  agentsEnabled: (projectPath: string) => boolean
  tabTasks?: (projectPath: string) => Record<string, { id: string; title: string }>
  runtimeDir: () => string
  localPort?: () => number
  activity?: AgentActivitySource
  isAlive?: (pid: number) => boolean
  fetchRemoteAgents?: (runtime: ProjectRuntime) => Promise<AgentInfo[]>
  sendRemoteMessage?: (runtime: ProjectRuntime, req: AgentDeliverRequest) => Promise<AgentSendResult>
}

const PEER_TIMEOUT_MS = 3000
const MAX_MESSAGE_CHARS = 64 * 1024

function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function formatAgentId(projectPath: string, tabId: string): string {
  return `${projectRuntimeKey(projectPath)}:${tabId}`
}

export function parseAgentTarget(to: string, callerProjectPath: string): { projectKey: string; tabId: string } | null {
  const trimmed = to.trim()
  if (!trimmed) return null
  const colon = trimmed.indexOf(':')
  if (colon !== -1) {
    const projectKey = trimmed.slice(0, colon).trim()
    const tabId = trimmed.slice(colon + 1).trim()
    if (!projectKey || !tabId) return null
    return { projectKey, tabId }
  }
  return { projectKey: projectRuntimeKey(callerProjectPath), tabId: trimmed }
}

export function formatAgentMessage(from: AgentDeliverSender, message: string): string {
  const who = from.title ? `"${from.title}"` : (from.toolName ?? 'agent')
  const meta = [from.toolName, `project: ${from.projectName}`, `from: ${from.id}`].filter(Boolean).join(', ')
  const replyNote = from.tabId
    ? `To reply, use AIDE MCP agent_send with to="${from.id}". If this message does not require a reply, do not reply.`
    : 'If this message does not require a reply, do not reply.'
  return `[Message from agent ${who} (${meta})]:\n${message.trim()}\n(${replyNote})`
}

function peerRequest(
  runtime: ProjectRuntime,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null
    const headers: Record<string, string | number> = {
      'x-aide-token': runtime.token,
      'x-aide-project': runtime.projectPath
    }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    const req = http.request({ host: '127.0.0.1', port: runtime.port, path, method, headers, timeout: PEER_TIMEOUT_MS }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('timeout', () => { req.destroy(new Error('Peer request timed out')) })
    req.on('error', reject)
    if (payload) req.end(payload)
    else req.end()
  })
}

async function defaultFetchRemoteAgents(runtime: ProjectRuntime): Promise<AgentInfo[]> {
  const res = await peerRequest(runtime, 'GET', '/agents')
  if (res.status !== 200) return []
  const parsed = JSON.parse(res.text) as { agents?: AgentInfo[] }
  return Array.isArray(parsed.agents) ? parsed.agents : []
}

async function defaultSendRemoteMessage(runtime: ProjectRuntime, req: AgentDeliverRequest): Promise<AgentSendResult> {
  const res = await peerRequest(runtime, 'POST', '/agents/message', req)
  if (res.status === 200) {
    return JSON.parse(res.text) as AgentSendResult
  }
  return { status: 'failed', to: formatAgentId(req.targetProjectPath, req.tabId), reason: `Target AIDE instance returned HTTP ${res.status}.` }
}

export class AgentMessagingService {
  private readonly pending = new Map<string, { projectPath: string; messages: string[] }>()
  private readonly activity: AgentActivitySource
  private readonly isAlive: (pid: number) => boolean
  private readonly fetchRemote: (runtime: ProjectRuntime) => Promise<AgentInfo[]>
  private readonly sendRemote: (runtime: ProjectRuntime, req: AgentDeliverRequest) => Promise<AgentSendResult>

  constructor(private readonly deps: AgentMessagingDeps) {
    this.activity = deps.activity ?? tabActivity
    this.isAlive = deps.isAlive ?? defaultIsAlive
    this.fetchRemote = deps.fetchRemoteAgents ?? defaultFetchRemoteAgents
    this.sendRemote = deps.sendRemoteMessage ?? defaultSendRemoteMessage
  }

  /** Subscribe to tab idle / close events so queued messages flush automatically. */
  attach(): () => void {
    const onIdle = (tabId: string): void => { void this.flush(tabId) }
    const onForget = (tabId: string): void => { this.pending.delete(tabId) }
    this.activity.on('idle', onIdle)
    this.activity.on('forget', onForget)
    return () => {
      this.activity.off('idle', onIdle)
      this.activity.off('forget', onForget)
    }
  }

  /** List all agent tabs open in this AIDE process (for local queries and GET /agents). */
  listLocal(callerProjectPath?: string, callerTabId?: string | null): AgentInfo[] {
    const result: AgentInfo[] = []
    for (const mgr of this.deps.managers()) {
      const projectPath = mgr.getProjectPath()
      if (!this.deps.agentsEnabled(projectPath)) continue
      const projectName = basename(projectPath) || projectPath
      const tasks = this.deps.tabTasks?.(projectPath) ?? {}
      const isSame = callerProjectPath !== undefined && samePath(projectPath, callerProjectPath)
      for (const tab of mgr.getTabs()) {
        if (tab.toolId === 'plain-shell') continue
        const ready = mgr.isTabReady(tab.tabId)
        const status: AgentStatus = !ready ? 'starting' : this.activity.isIdle(tab.tabId) ? 'idle' : 'busy'
        const task = tasks[tab.tabId]
        result.push({
          id: formatAgentId(projectPath, tab.tabId),
          tabId: tab.tabId,
          projectPath,
          projectName,
          sameProject: isSame,
          toolId: tab.toolId,
          toolName: tab.toolName,
          title: tab.title?.trim() || tab.toolName,
          status,
          hasUserDraft: this.activity.hasUserDraft(tab.tabId),
          isSelf: isSame && !!callerTabId && tab.tabId === callerTabId,
          ...(task ? { task } : {})
        })
      }
    }
    return result
  }

  /** List agents for an MCP caller (`scope`: 'project' by default, or 'all' across the machine). */
  async listAgents(callerProjectPath: string, callerTabId: string | null, scope: 'project' | 'all' = 'project'): Promise<AgentInfo[]> {
    const local = this.listLocal(callerProjectPath, callerTabId)
    if (scope === 'project') {
      return local.filter((agent) => agent.sameProject)
    }

    const localKeys = new Set<string>()
    for (const mgr of this.deps.managers()) localKeys.add(projectRuntimeKey(mgr.getProjectPath()))
    const localPort = this.deps.localPort?.() ?? 0

    // Query each peer AIDE process once (deduplicated by port).
    const peerByPort = new Map<number, ProjectRuntime>()
    for (const runtime of listProjectRuntimes(this.deps.runtimeDir(), this.isAlive)) {
      if (runtime.pid === process.pid || (localPort > 0 && runtime.port === localPort)) continue
      if (localKeys.has(projectRuntimeKey(runtime.projectPath))) continue
      if (!peerByPort.has(runtime.port)) peerByPort.set(runtime.port, runtime)
    }

    if (peerByPort.size === 0) return local

    const settled = await Promise.allSettled(
      Array.from(peerByPort.values()).map((runtime) => this.fetchRemote(runtime))
    )
    const remote: AgentInfo[] = []
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        for (const agent of entry.value) {
          remote.push({ ...agent, sameProject: false, isSelf: false })
        }
      } else {
        logEvent('agent-peer-list-failed', { message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }, 'warn')
      }
    }
    return [...local, ...remote]
  }

  /** Send a message from an MCP caller to a local or cross-process agent tab. */
  async sendMessage(
    callerProjectPath: string,
    callerTabId: string | null,
    to: string,
    message: string
  ): Promise<AgentSendResult> {
    if (!message.trim()) {
      return { status: 'rejected', to, reason: 'Message must not be empty.' }
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return { status: 'rejected', to, reason: `Message is too long (maximum ${MAX_MESSAGE_CHARS} characters).` }
    }
    const target = parseAgentTarget(to, callerProjectPath)
    if (!target) {
      return { status: 'rejected', to, reason: 'Invalid target agent id.' }
    }

    const from = this.describeSender(callerProjectPath, callerTabId)
    const canonicalLocal = this.findLocalManagerByKey(target.projectKey)
    if (canonicalLocal) {
      return this.deliverLocal({
        targetProjectPath: canonicalLocal.getProjectPath(),
        tabId: target.tabId,
        from,
        message
      })
    }

    const peer = listProjectRuntimes(this.deps.runtimeDir(), this.isAlive)
      .find((r) => projectRuntimeKey(r.projectPath) === target.projectKey)
    if (!peer) {
      return { status: 'rejected', to, reason: `Target agent "${to}" was not found in any running AIDE window.` }
    }

    try {
      return await this.sendRemote(peer, {
        targetProjectPath: peer.projectPath,
        tabId: target.tabId,
        from,
        message
      })
    } catch (err) {
      logEvent('agent-peer-send-failed', { to, message: err instanceof Error ? err.message : String(err) }, 'warn')
      return { status: 'failed', to, reason: `Could not reach target AIDE instance: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** Deliver a message to a tab owned by this AIDE process (local call or POST /agents/message). */
  async deliverLocal(req: AgentDeliverRequest): Promise<AgentSendResult> {
    const to = formatAgentId(req.targetProjectPath, req.tabId)
    if (!this.deps.agentsEnabled(req.targetProjectPath)) {
      return { status: 'rejected', to, reason: 'Agent messaging is turned off in Settings for the target project.' }
    }
    const mgr = this.findLocalManagerByPath(req.targetProjectPath)
    if (!mgr) {
      return { status: 'rejected', to, reason: 'Target project is not open in this AIDE window.' }
    }
    const tab = mgr.getTabs().find((t) => t.tabId === req.tabId)
    if (!tab || tab.toolId === 'plain-shell') {
      return { status: 'rejected', to, reason: `Target agent tab "${req.tabId}" was not found.` }
    }
    if (req.from.tabId && req.from.tabId === req.tabId && samePath(req.from.projectPath, req.targetProjectPath)) {
      return { status: 'rejected', to, reason: 'Cannot send a message to yourself.' }
    }

    const formattedText = formatAgentMessage(req.from, req.message)
    const deliverToPty = (text: string): Promise<AgentDeliverOutcome> => this.deliverViaPty(mgr, tab.tabId, text)

    const tool = mgr.getTabTool(tab.tabId)
    let outcome: AgentDeliverOutcome
    if (tool?.deliverMessage) {
      outcome = await tool.deliverMessage({
        tabId: tab.tabId,
        sessionId: tab.sessionId,
        projectPath: req.targetProjectPath,
        message: req.message,
        formattedText,
        from: req.from,
        deliverToPty
      })
    } else {
      outcome = await deliverToPty(formattedText)
    }

    return { status: outcome.status, to, ...(outcome.reason ? { reason: outcome.reason } : {}) }
  }

  private async deliverViaPty(mgr: AgentPtyManager, tabId: string, text: string): Promise<AgentDeliverOutcome> {
    if (!mgr.getTabs().some((t) => t.tabId === tabId)) {
      return { status: 'failed', reason: 'Target agent tab is closed.' }
    }
    if (this.activity.hasUserDraft(tabId)) {
      return { status: 'rejected', reason: 'The target tab has unsent text in its input box. Wait for the user to finish first.' }
    }
    if (mgr.isTabReady(tabId) && this.activity.isIdle(tabId)) {
      const sent = await mgr.submitText(tabId, text)
      return sent ? { status: 'delivered' } : { status: 'failed', reason: 'Target agent tab is closed.' }
    }

    const existing = this.pending.get(tabId)
    if (existing) existing.messages.push(text)
    else this.pending.set(tabId, { projectPath: mgr.getProjectPath(), messages: [text] })
    return {
      status: 'queued',
      reason: !mgr.isTabReady(tabId)
        ? 'Target agent is still starting; message is queued and will be delivered once ready.'
        : 'Target agent is currently busy; message is queued and will be delivered once it becomes idle.'
    }
  }

  private async flush(tabId: string): Promise<void> {
    const entry = this.pending.get(tabId)
    if (!entry || entry.messages.length === 0) return
    if (!this.activity.isIdle(tabId)) return
    // If the user started typing a draft while the agent was busy, hold off until they finish.
    if (this.activity.hasUserDraft(tabId)) return

    const mgr = this.findLocalManagerByPath(entry.projectPath)
    if (!mgr || !mgr.getTabs().some((t) => t.tabId === tabId)) {
      this.pending.delete(tabId)
      return
    }
    if (!mgr.isTabReady(tabId)) return

    const batch = entry.messages.splice(0)
    this.pending.delete(tabId)
    try {
      await mgr.submitText(tabId, batch.join('\n\n'))
    } catch (err) {
      logEvent('agent-message-flush-failed', { tabId, message: err instanceof Error ? err.message : String(err) }, 'warn')
    }
  }

  private describeSender(projectPath: string, tabId: string | null): AgentDeliverSender {
    const projectName = basename(projectPath) || projectPath
    const mgr = this.findLocalManagerByPath(projectPath)
    const tab = tabId ? mgr?.getTabs().find((t) => t.tabId === tabId) : undefined
    return {
      id: tabId ? formatAgentId(projectPath, tabId) : projectRuntimeKey(projectPath),
      projectName,
      projectPath,
      tabId,
      toolId: tab?.toolId ?? null,
      toolName: tab?.toolName ?? null,
      title: tab?.title?.trim() || tab?.toolName || null
    }
  }

  private findLocalManagerByKey(projectKey: string): AgentPtyManager | null {
    for (const mgr of this.deps.managers()) {
      if (projectRuntimeKey(mgr.getProjectPath()) === projectKey) return mgr
    }
    return null
  }

  private findLocalManagerByPath(projectPath: string): AgentPtyManager | null {
    for (const mgr of this.deps.managers()) {
      if (samePath(mgr.getProjectPath(), projectPath)) return mgr
    }
    return null
  }
}
