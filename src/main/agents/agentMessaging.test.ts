import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { CliTool } from '../pty/cliTools/types'
import type { SessionTabInfo } from '../pty/ptyManager'
import { PipelineServer } from '../pipeline/server/pipelineServer'
import {
  AgentMessagingService,
  formatAgentId,
  formatAgentMessage,
  parseAgentTarget,
  type AgentActivitySource,
  type AgentPtyManager
} from './agentMessaging'

vi.mock('../diagnostics', () => ({ logEvent: vi.fn() }))

class FakeActivity extends EventEmitter implements AgentActivitySource {
  idle = new Set<string>()
  drafts = new Set<string>()

  isIdle(tabId: string): boolean { return this.idle.has(tabId) }
  hasUserDraft(tabId: string): boolean { return this.drafts.has(tabId) }

  setIdle(tabId: string): void {
    this.idle.add(tabId)
    this.emit('idle', tabId)
  }

  setBusy(tabId: string): void {
    this.idle.delete(tabId)
  }

  forget(tabId: string): void {
    this.idle.delete(tabId)
    this.drafts.delete(tabId)
    this.emit('forget', tabId)
  }
}

interface FakeTab extends SessionTabInfo {
  ready?: boolean
  tool?: Partial<CliTool>
}

class FakePtyManager implements AgentPtyManager {
  submitted: Array<{ tabId: string; text: string }> = []
  tabs: FakeTab[]

  constructor(private readonly projectPath: string, tabs: FakeTab[]) {
    this.tabs = tabs
  }

  getProjectPath(): string { return this.projectPath }
  getTabs(): SessionTabInfo[] {
    return this.tabs.map(({ tabId, sessionId, title, toolId, toolName }) => ({ tabId, sessionId, title, toolId, toolName }))
  }
  getTabTool(tabId: string): CliTool | null {
    return (this.tabs.find((t) => t.tabId === tabId)?.tool as CliTool | undefined) ?? null
  }
  isTabReady(tabId: string): boolean {
    const tab = this.tabs.find((t) => t.tabId === tabId)
    return !!tab && tab.ready !== false
  }
  async submitText(tabId: string, text: string): Promise<boolean> {
    if (!this.tabs.some((t) => t.tabId === tabId)) return false
    this.submitted.push({ tabId, text })
    return true
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'aide-agent-msg-'))
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }))

describe('AgentMessagingService (local)', () => {
  let activity: FakeActivity
  let mgrA: FakePtyManager
  let mgrB: FakePtyManager
  let enabled: Record<string, boolean>
  let service: AgentMessagingService
  let detach: () => void

  const projA = join(tempRoot, 'alpha')
  const projB = join(tempRoot, 'beta')
  const runtimeDir = join(tempRoot, 'runtime-local')

  beforeEach(() => {
    activity = new FakeActivity()
    activity.idle.add('tab-1')
    activity.idle.add('tab-2')
    activity.idle.add('tab-4')

    mgrA = new FakePtyManager(projA, [
      { tabId: 'tab-1', sessionId: 's1', title: 'Backend work', toolId: 'claude-code', toolName: 'Claude Code' },
      { tabId: 'tab-2', sessionId: 's2', title: 'Frontend work', toolId: 'codex', toolName: 'Codex' },
      { tabId: 'tab-3', sessionId: null, title: 'PowerShell', toolId: 'plain-shell', toolName: 'Plain Shell' }
    ])
    mgrB = new FakePtyManager(projB, [
      { tabId: 'tab-4', sessionId: 's4', title: 'Docs', toolId: 'antigravity', toolName: 'Google Antigravity' }
    ])
    enabled = { [projA]: true, [projB]: true }

    service = new AgentMessagingService({
      managers: () => [mgrA, mgrB],
      agentsEnabled: (p) => enabled[p] ?? true,
      tabTasks: (p): Record<string, { id: string; title: string }> => p === projA ? { 'tab-1': { id: 'api-fix', title: 'Fix API' } } : {},
      runtimeDir: () => runtimeDir,
      activity
    })
    detach = service.attach()
  })

  it('lists agents in current project by default, excludes plain-shell, and includes task & draft info', async () => {
    activity.drafts.add('tab-2')
    const projectOnly = await service.listAgents(projA, 'tab-1', 'project')
    expect(projectOnly).toHaveLength(2)
    expect(projectOnly.map((a) => a.tabId)).toEqual(['tab-1', 'tab-2'])
    expect(projectOnly[0]).toMatchObject({
      id: formatAgentId(projA, 'tab-1'),
      projectName: 'alpha',
      sameProject: true,
      isSelf: true,
      status: 'idle',
      hasUserDraft: false,
      task: { id: 'api-fix', title: 'Fix API' }
    })
    expect(projectOnly[1]).toMatchObject({
      isSelf: false,
      hasUserDraft: true
    })

    const all = await service.listAgents(projA, 'tab-1', 'all')
    expect(all.map((a) => a.tabId)).toEqual(['tab-1', 'tab-2', 'tab-4'])
    expect(all[2]).toMatchObject({ projectName: 'beta', sameProject: false, isSelf: false })

    // Turning off agents in projB hides its tabs from scope: 'all'
    enabled[projB] = false
    const filtered = await service.listAgents(projA, 'tab-1', 'all')
    expect(filtered.map((a) => a.tabId)).toEqual(['tab-1', 'tab-2'])
    detach()
  })

  it('delivers immediately to an idle tab (accepting full id or bare tabId) with sender header and no-reply hint', async () => {
    const res = await service.sendMessage(projA, 'tab-1', 'tab-2', 'Schema is updated.')
    expect(res).toEqual({ status: 'delivered', to: formatAgentId(projA, 'tab-2') })
    expect(mgrA.submitted).toHaveLength(1)
    expect(mgrA.submitted[0].tabId).toBe('tab-2')
    expect(mgrA.submitted[0].text).toContain('Backend work')
    expect(mgrA.submitted[0].text).toContain('Schema is updated.')
    expect(mgrA.submitted[0].text).toContain(`to="${formatAgentId(projA, 'tab-1')}"`)
    expect(mgrA.submitted[0].text).toContain('If this message does not require a reply, do not reply.')
    detach()
  })

  it('refuses delivery when the target tab has unsent user text in its input box', async () => {
    activity.drafts.add('tab-2')
    const res = await service.sendMessage(projA, 'tab-1', formatAgentId(projA, 'tab-2'), 'Ping')
    expect(res.status).toBe('rejected')
    expect(res.reason).toContain('unsent text')
    expect(mgrA.submitted).toHaveLength(0)
    detach()
  })

  it('queues messages while busy, holds if user starts typing, and flushes combined batch once idle with empty input', async () => {
    activity.setBusy('tab-2')
    const r1 = await service.sendMessage(projA, 'tab-1', 'tab-2', 'First update')
    const r2 = await service.sendMessage(projA, 'tab-1', 'tab-2', 'Second update')
    expect(r1.status).toBe('queued')
    expect(r2.status).toBe('queued')
    expect(mgrA.submitted).toHaveLength(0)

    // User started typing while tab was busy — becoming idle must NOT clobber their draft
    activity.drafts.add('tab-2')
    activity.setIdle('tab-2')
    await Promise.resolve()
    expect(mgrA.submitted).toHaveLength(0)

    // User finishes and submits -> next idle flushes both queued messages together
    activity.drafts.delete('tab-2')
    activity.setBusy('tab-2')
    activity.setIdle('tab-2')
    await new Promise((r) => setTimeout(r, 10))
    expect(mgrA.submitted).toHaveLength(1)
    expect(mgrA.submitted[0].text).toContain('First update')
    expect(mgrA.submitted[0].text).toContain('Second update')
    detach()
  })

  it('rejects self-send, plain-shell, and disabled target project', async () => {
    expect((await service.sendMessage(projA, 'tab-1', 'tab-1', 'Hi me')).status).toBe('rejected')
    expect((await service.sendMessage(projA, 'tab-1', 'tab-3', 'Hi shell')).status).toBe('rejected')
    enabled[projB] = false
    const disabled = await service.sendMessage(projA, 'tab-1', formatAgentId(projB, 'tab-4'), 'Hi beta')
    expect(disabled.status).toBe('rejected')
    expect(disabled.reason).toContain('turned off in Settings')
    detach()
  })

  it('invokes CliTool.deliverMessage when present instead of writing directly to PTY', async () => {
    const customDeliver = vi.fn().mockResolvedValue({ status: 'delivered' as const })
    mgrA.tabs[1].tool = { deliverMessage: customDeliver }

    const res = await service.sendMessage(projA, 'tab-1', 'tab-2', 'Native test')
    expect(res.status).toBe('delivered')
    expect(customDeliver).toHaveBeenCalledTimes(1)
    expect(customDeliver.mock.calls[0][0]).toMatchObject({
      tabId: 'tab-2',
      sessionId: 's2',
      projectPath: projA,
      message: 'Native test'
    })
    expect(mgrA.submitted).toHaveLength(0)
    detach()
  })

  it('parses full and bare agent targets and formats messages cleanly', () => {
    expect(parseAgentTarget('abc123:tab-9', projA)).toEqual({ projectKey: 'abc123', tabId: 'tab-9' })
    expect(parseAgentTarget('tab-2', projA)).toEqual({ projectKey: formatAgentId(projA, 'x').split(':')[0], tabId: 'tab-2' })
    expect(parseAgentTarget('', projA)).toBeNull()
    expect(formatAgentMessage({
      id: 'k:tab-1', projectName: 'alpha', projectPath: projA, tabId: 'tab-1', toolId: 'codex', toolName: 'Codex', title: 'Review'
    }, 'Done')).toContain('[Message from agent "Review" (Codex, project: alpha, from: k:tab-1)]:')
  })
})

describe('AgentMessagingService (cross-process over PipelineServer HTTP)', () => {
  it('lists and delivers messages between two separate PipelineServer instances via discovery files', async () => {
    const runtimeDir = join(tempRoot, 'runtime-p2p')
    const proj1 = join(tempRoot, 'peer-1')
    const proj2 = join(tempRoot, 'peer-2')
    mkdirSync(proj1, { recursive: true })
    mkdirSync(proj2, { recursive: true })

    const act1 = new FakeActivity()
    act1.idle.add('tab-1')
    const mgr1 = new FakePtyManager(proj1, [
      { tabId: 'tab-1', sessionId: 's1', title: 'Peer 1 Agent', toolId: 'claude-code', toolName: 'Claude Code' }
    ])
    const srv1 = new PipelineServer()
    const svc1 = new AgentMessagingService({
      managers: () => [mgr1],
      agentsEnabled: () => true,
      runtimeDir: () => runtimeDir,
      localPort: () => srv1.getPort(),
      activity: act1,
      isAlive: () => true
    })

    const act2 = new FakeActivity()
    act2.idle.add('tab-1')
    const mgr2 = new FakePtyManager(proj2, [
      { tabId: 'tab-1', sessionId: 's2', title: 'Peer 2 Agent', toolId: 'antigravity', toolName: 'Google Antigravity' }
    ])
    const srv2 = new PipelineServer()
    const svc2 = new AgentMessagingService({
      managers: () => [mgr2],
      agentsEnabled: () => true,
      runtimeDir: () => runtimeDir,
      localPort: () => srv2.getPort(),
      activity: act2,
      isAlive: () => true
    })

    srv1.registerProject(proj1)
    srv2.registerProject(proj2)
    await srv1.start({
      runtimeDir, serverName: 'aide', serverVersion: 't', instructions: '', tools: () => [],
      agentHandlers: { list: () => svc1.listLocal(), send: (req) => svc1.deliverLocal(req) }
    })
    await srv2.start({
      runtimeDir, serverName: 'aide', serverVersion: 't', instructions: '', tools: () => [],
      agentHandlers: { list: () => svc2.listLocal(), send: (req) => svc2.deliverLocal(req) }
    })

    try {
      // Simulate two distinct OS processes by not skipping same-pid when ports differ:
      // Wait — in the same test process runtime.pid === process.pid, so listAgents skips
      // runtime.pid === process.pid unless we check port! Let's verify cross-process works
      // when pid differs by writing peer-2's runtime with a synthetic live pid.
      const { writeFileSync } = await import('fs')
      const { projectRuntimeKey } = await import('../pipeline/server/runtimeFiles')
      const peer2File = join(runtimeDir, 'projects', `${projectRuntimeKey(proj2)}.json`)
      const { readFileSync } = await import('fs')
      const peer2Info = JSON.parse(readFileSync(peer2File, 'utf8')) as Record<string, unknown>
      writeFileSync(peer2File, JSON.stringify({ ...peer2Info, pid: process.pid + 99999 }), 'utf8')

      const all = await svc1.listAgents(proj1, 'tab-1', 'all')
      expect(all).toHaveLength(2)
      const peerAgent = all.find((a) => a.projectName === 'peer-2')!
      expect(peerAgent).toBeDefined()
      expect(peerAgent.sameProject).toBe(false)
      expect(peerAgent.title).toBe('Peer 2 Agent')

      const sendRes = await svc1.sendMessage(proj1, 'tab-1', peerAgent.id, 'Hello across processes!')
      expect(sendRes).toEqual({ status: 'delivered', to: peerAgent.id })
      expect(mgr2.submitted).toHaveLength(1)
      expect(mgr2.submitted[0].text).toContain('Hello across processes!')
      expect(mgr2.submitted[0].text).toContain('Peer 1 Agent')
    } finally {
      await srv1.stop()
      await srv2.stop()
    }
  })
})
