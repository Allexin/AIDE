import type { HistoryEntry } from '../pty/cliTools/types'
import type { AgentInputRecord } from '../../shared/pipelineMachine'
import type { EscalationAnswer } from './engine/types'
import type { PipelineManager, RunSnapshot } from './manager'

/**
 * What a run view (the desktop pipeline tab, the remote pipeline page) reads and
 * does, keyed by the project path, independent of the transport. Control and
 * answer return a readable error instead of throwing, for showing next to the
 * button that caused it.
 */

export type RunControl = 'pause' | 'stop' | 'resume' | 'abandon'
export type AnswerAction = EscalationAnswer['action']

export interface RunViewListener {
  onState?(snapshot: RunSnapshot): void
  onTranscript?(runId: string, node: string, visit: number, entry: HistoryEntry): void
  onCheckOutput?(runId: string, node: string, visit: number, text: string): void
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class PipelineViewService {
  constructor(private readonly manager: PipelineManager) {}

  snapshot(projectPath: string): RunSnapshot | null {
    return this.manager.snapshot(projectPath)
  }

  async control(projectPath: string, action: RunControl): Promise<string | null> {
    try {
      if (action === 'pause') this.manager.pause(projectPath)
      else if (action === 'stop') await this.manager.stop(projectPath)
      else if (action === 'resume') this.manager.resume(projectPath)
      else await this.manager.abandon(projectPath, 'abandoned by the user')
      return null
    } catch (err) {
      return message(err)
    }
  }

  async answer(projectPath: string, escalationId: string, action: AnswerAction, text: string): Promise<string | null> {
    try {
      await this.manager.answer(projectPath, escalationId, { action, text, by: 'user' })
      return null
    } catch (err) {
      return message(err)
    }
  }

  transcript(projectPath: string, runId: string, node: string, visit: number): HistoryEntry[] {
    return this.manager.transcript(projectPath, runId, node, visit)
  }

  agentInputs(projectPath: string, runId: string, node: string, visit: number): AgentInputRecord[] {
    return this.manager.agentInputs(projectPath, runId, node, visit)
  }

  checkLog(projectPath: string, runId: string, node: string, visit: number): string {
    return this.manager.checkLog(projectPath, runId, node, visit)
  }

  report(projectPath: string, runId: string): ReturnType<PipelineManager['report']> {
    return this.manager.report(projectPath, runId)
  }

  /** The output of one step visit, or null when it has none (yet). */
  output(projectPath: string, runId: string, node: string, visit: number): unknown {
    return this.manager.output(projectPath, node, visit, runId)?.output ?? null
  }

  /**
   * Run state changes, live transcript entries and check output of the
   * project's runs. Entries and output are written to the run directory before
   * they are announced, so subscribing and then reading `transcript()` or
   * `checkLog()` misses and repeats nothing.
   */
  subscribe(projectPath: string, listener: RunViewListener): () => void {
    const onState = (path: string, snapshot: RunSnapshot): void => { if (path === projectPath) listener.onState?.(snapshot) }
    const onTranscript = (path: string, runId: string, node: string, visit: number, entry: HistoryEntry): void => {
      if (path === projectPath) listener.onTranscript?.(runId, node, visit, entry)
    }
    const onCheckOutput = (path: string, runId: string, node: string, visit: number, text: string): void => {
      if (path === projectPath) listener.onCheckOutput?.(runId, node, visit, text)
    }
    this.manager.on('state', onState)
    this.manager.on('transcript', onTranscript)
    this.manager.on('check-output', onCheckOutput)
    return () => {
      this.manager.off('state', onState)
      this.manager.off('transcript', onTranscript)
      this.manager.off('check-output', onCheckOutput)
    }
  }
}
