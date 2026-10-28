import { EventEmitter } from 'events'
import type { HistoryEntry } from '../pty/cliTools/types'
import { PipelineRun, compactEscalation, type EngineDeps, type RunReport } from './engine/runner'
import { RunStore, newRunId } from './engine/runStore'
import { loadLibrary, readRole, roleExists, validateParams, type LibraryEntry } from './engine/library'
import { validateMachine, type ValidationResult } from './engine/validate'
import { outdatedMessage } from './engine/compat'
import type { EscalationAnswer, MachineDefinition, RunState } from './engine/types'
import type { AgentInputRecord } from '../../shared/pipelineMachine'
import { pipelineEvents, type PipelineEventType } from './events'

/**
 * Owns pipeline runs per project: the machine library, the single active run,
 * recovery after an AIDE restart, and the bridge from engine events to the
 * orchestrator feed and the UI.
 *
 * Emits:
 *   'state'      (projectPath, snapshot)                 on every run state change
 *   'transcript' (projectPath, runId, node, visit, entry) streamed agent transcript entries
 *   'event'      (projectPath, runId, type, data, id, observed)  pipeline events (id: the event id in the feed;
 *                observed: an orchestrator was waiting for events when it was emitted)
 */

export interface ManagerEnvironment {
  runsRoot(projectPath: string): string
  libraryDirs(projectPath: string): Array<{ dir: string; source: 'shared' | 'personal' }>
  headlessClis(): string[]
  /** Engine dependencies except `emit`, `onStateChange`, `onTranscript`, `readRole`, which the manager supplies. */
  deps(projectPath: string): Pick<EngineDeps, 'startAgent' | 'runCheck' | 'git' | 'accountPool'>
}

export interface RunSnapshot {
  runId: string
  projectPath: string
  machine: MachineDefinition
  state: RunState
}

export interface MachineInfo {
  id: string
  name: string
  description: string
  params: MachineDefinition['params']
  source: 'shared' | 'personal'
  file: string
  validation: ValidationResult
}

export class PipelineManager extends EventEmitter {
  private readonly active = new Map<string, PipelineRun>()

  constructor(private readonly env: ManagerEnvironment) {
    super()
  }

  private store(projectPath: string): RunStore {
    return new RunStore(this.env.runsRoot(projectPath))
  }

  private library(projectPath: string): LibraryEntry[] {
    return loadLibrary(this.env.libraryDirs(projectPath)).machines
  }

  machineEntry(projectPath: string, machineId: string): LibraryEntry | null {
    return this.library(projectPath).find((e) => e.machine.id === machineId) ?? null
  }

  validate(entry: LibraryEntry): ValidationResult {
    return validateMachine(entry.machine, { headlessClis: this.env.headlessClis(), roleExists: (role) => roleExists(entry.machineDir, role) })
  }

  listMachines(projectPath: string): { machines: MachineInfo[]; errors: Array<{ file: string; error: string }> } {
    const library = loadLibrary(this.env.libraryDirs(projectPath))
    return {
      machines: library.machines.map((entry) => ({
        id: entry.machine.id,
        name: entry.machine.name,
        description: entry.machine.description,
        params: entry.machine.params,
        source: entry.source,
        file: entry.file,
        validation: this.validate(entry)
      })),
      errors: library.errors
    }
  }

  activeRun(projectPath: string): PipelineRun | null {
    return this.active.get(projectPath) ?? null
  }

  snapshot(projectPath: string): RunSnapshot | null {
    const run = this.active.get(projectPath)
    return run ? this.toSnapshot(projectPath, run) : null
  }

  private toSnapshot(projectPath: string, run: PipelineRun): RunSnapshot {
    return { runId: run.runId, projectPath, machine: run.definition, state: run.state }
  }

  private engineDeps(projectPath: string, store: RunStore): EngineDeps {
    return {
      ...this.env.deps(projectPath),
      readRole,
      emit: (runId: string, type: PipelineEventType, data: Record<string, unknown>) => {
        const observed = pipelineEvents.hasObserver(projectPath)
        const event = pipelineEvents.emit(projectPath, runId, type, data)
        try { store.appendEvent(runId, event as unknown as Record<string, unknown>) } catch { /* run dir removed */ }
        this.emit('event', projectPath, runId, type, data, event.id, observed)
      },
      onStateChange: (state: RunState) => {
        const run = this.active.get(projectPath)
        if (run && run.runId === state.runId) this.emit('state', projectPath, this.toSnapshot(projectPath, run))
      },
      onTranscript: (runId: string, node: string, visit: number, entry: HistoryEntry) => {
        this.emit('transcript', projectPath, runId, node, visit, entry)
      },
      onCheckOutput: (runId: string, node: string, visit: number, text: string) => {
        this.emit('check-output', projectPath, runId, node, visit, text)
      }
    }
  }

  /** Start a run. Returns the run id and non-fatal warnings, or throws with a readable message. */
  async start(projectPath: string, machineId: string, params: Record<string, unknown>, options: { acceptOutdated?: boolean } = {}): Promise<{ runId: string; warnings: string[] }> {
    const current = this.active.get(projectPath)
    if (current && !current.isFinal()) throw new Error(`Run ${current.runId} is still ${current.state.status}. Finish, stop or abandon it first.`)
    const entry = this.library(projectPath).find((e) => e.machine.id === machineId)
    if (!entry) throw new Error(`Unknown machine "${machineId}". Call pipeline_list for the available machines.`)
    const validation = this.validate(entry)
    if (validation.errors.length) throw new Error(`Machine "${machineId}" is invalid:\n- ${validation.errors.join('\n- ')}`)
    const paramErrors = validateParams(entry.machine.params, params)
    if (paramErrors.length) throw new Error(`Invalid params:\n- ${paramErrors.join('\n- ')}`)
    const outdated = outdatedMessage(entry.machine)
    if (outdated && !options.acceptOutdated) throw new Error(outdated)

    // The outdated warning was the reason for acceptOutdated; repeating it adds nothing.
    const warnings = validation.warnings.filter((w) => !outdated || !w.startsWith('Written for engine'))
    if (outdated) warnings.push(`Started although "${machineId}" was written for an older pipeline engine (acceptOutdated).`)
    const deps = this.env.deps(projectPath)
    const dirty = await deps.git.status(projectPath).catch(() => [])
    if (dirty.length) warnings.push(`The working tree has ${dirty.length} uncommitted change(s); they will mix into this run's diff and commits.`)

    const store = this.store(projectPath)
    const run = PipelineRun.create({ machine: entry.machine, machineDir: entry.machineDir }, params, newRunId(machineId), projectPath, store, this.engineDeps(projectPath, store))
    this.active.set(projectPath, run)
    this.emit('state', projectPath, this.toSnapshot(projectPath, run))
    void run.run()
    return { runId: run.runId, warnings }
  }

  /** After an AIDE restart: reattach the newest unfinished run, paused. */
  recover(projectPath: string): RunSnapshot | null {
    if (this.active.has(projectPath)) return this.snapshot(projectPath)
    const store = this.store(projectPath)
    for (const runId of store.list()) {
      const loaded = store.load(runId)
      if (!loaded) continue
      const { state, stored, params } = loaded
      if (state.status === 'finished' || state.status === 'failed') return null
      const wasExecuting = state.status === 'running' || state.status === 'pausing'
      if (wasExecuting) {
        // The process that ran it is gone; an in-flight visit counts as interrupted.
        const last = state.history[state.history.length - 1]
        if (last && !last.finishedAt) {
          last.outcome = 'interrupted'
          last.finishedAt = new Date().toISOString()
          state.visits[last.node] = Math.max(0, (state.visits[last.node] ?? 1) - 1)
          // Retrying an unavailable CLI: the retry after the restart goes on with this record.
          if (state.unavailable?.node === last.node) last.pendingRetry = true
        }
        state.status = 'paused'
        store.saveState(state)
      }
      const deps = this.engineDeps(projectPath, store)
      const run = new PipelineRun(stored, params, state, store, deps)
      this.active.set(projectPath, run)
      // Event ids continue where the previous AIDE instance stopped, so an orchestrator
      // that resumes waiting with its last `since` gets the next events, not old ids.
      pipelineEvents.seed(projectPath, store.lastEventId(runId) + 1)
      // Re-announce what needs the orchestrator: a waiter from before the restart lost its call.
      const pending = run.pendingEscalation()
      if (wasExecuting && state.unavailable && !pending) {
        // It was retrying a CLI that was unavailable: keep retrying, in the same window
        // (an attempt after the window ends raises the escalation).
        void run.run()
      } else if (pending) deps.emit(runId, 'escalation', { ...compactEscalation(pending), summary: `AIDE restarted; still waiting for a decision at ${pending.node}` })
      else if (state.status === 'stopped' && state.limitResumeAt) {
        run.scheduleLimitResume()
        const quiet = !!state.limitCli && !!deps.accountPool?.(state.limitCli)
        deps.emit(runId, 'run_stopped', { next: state.current, reason: 'usage_limit', cli: state.limitCli ?? null, resumeAt: state.limitResumeAt, ...(quiet ? { quiet } : {}), summary: `AIDE restarted; the run waits for a CLI usage limit and resumes by itself at ${state.limitResumeAt} (or pipeline_resume)` })
      } else if (state.status === 'paused' || state.status === 'stopped') {
        deps.emit(runId, state.status === 'paused' ? 'run_paused' : 'run_stopped', {
          next: state.current,
          summary: `AIDE restarted; the run is ${state.status}${wasExecuting ? ` (interrupted during ${state.current ?? 'a step'})` : ''} — continue with pipeline_resume`
        })
      }
      return this.toSnapshot(projectPath, run)
    }
    return null
  }

  /** Before AIDE kills child processes on quit. */
  prepareShutdown(): void {
    for (const run of this.active.values()) run.markInterrupting()
  }

  forget(projectPath: string): void {
    const run = this.active.get(projectPath)
    if (run && (run.state.status === 'running' || run.state.status === 'pausing')) {
      // Closing the project: interrupt so state is saved consistently; it resumes as paused next time.
      void run.stop()
    }
    this.active.delete(projectPath)
  }

  private require(projectPath: string, runId?: string): PipelineRun {
    const run = this.active.get(projectPath)
    if (!run || (runId && run.runId !== runId)) throw new Error(runId ? `Run ${runId} is not the active run of this project.` : 'No active run in this project.')
    return run
  }

  pause(projectPath: string, runId?: string): void { this.require(projectPath, runId).pause() }

  async stop(projectPath: string, runId?: string): Promise<void> { await this.require(projectPath, runId).stop() }

  resume(projectPath: string, runId?: string): void {
    const run = this.require(projectPath, runId)
    if (run.state.status === 'waiting') throw new Error('The run is waiting for an escalation answer; use pipeline_answer.')
    if (run.isFinal()) throw new Error('The run has already ended.')
    void run.resume()
  }

  /** Record an event that happened to the run from outside the engine (the account pool). */
  announce(projectPath: string, type: PipelineEventType, data: Record<string, unknown>, runId?: string): void {
    this.require(projectPath, runId).announce(type, data)
  }

  /** Move the automatic resume of a run that waits for a usage limit; false when it does not wait for one. */
  setLimitResume(projectPath: string, at: string, summary: string, runId?: string): boolean {
    return this.require(projectPath, runId).setLimitResume(at, summary)
  }

  /** End a run for good. Returns the uncommitted changes left in the working tree (the run's partial work, and anything else uncommitted). */
  async abandon(projectPath: string, reason: string, runId?: string): Promise<string[]> {
    const run = this.require(projectPath, runId)
    if (run.state.status === 'running' || run.state.status === 'pausing') throw new Error('Stop the run before abandoning it.')
    run.abandon(reason)
    const changes = await this.env.deps(projectPath).git.status(projectPath).catch(() => [])
    return changes.map((c) => `${c.path} (${c.kind})`)
  }

  /**
   * Re-read the active run's machine file (`pipeline_reload`): later steps use the
   * edited definition. Role files need no reload — they are read at every visit.
   */
  reload(projectPath: string, runId?: string): string[] {
    const run = this.require(projectPath, runId)
    const entry = this.machineEntry(projectPath, run.definition.id)
    if (!entry) return [`The machine "${run.definition.id}" is no longer in the library.`]
    const validation = this.validate(entry)
    if (validation.errors.length) return validation.errors.map((e) => `Invalid: ${e}`)
    return run.reload({ machine: entry.machine, machineDir: entry.machineDir })
  }

  /** Add an instruction to the active run (`pipeline_amend`). */
  async amend(projectPath: string, text: string, by: 'user' | 'orchestrator', runId?: string): Promise<'restarted' | 'noted'> {
    if (!text.trim()) throw new Error('The instruction is empty.')
    return this.require(projectPath, runId).amend(text.trim(), by)
  }

  async answer(projectPath: string, escalationId: string, answer: Omit<EscalationAnswer, 'at'>, runId?: string): Promise<void> {
    const problem = await this.require(projectPath, runId).answer(escalationId, answer)
    if (problem) throw new Error(problem)
  }

  /** State of the active run, or of a finished run read from disk. */
  runState(projectPath: string, runId?: string): RunState | null {
    const active = this.active.get(projectPath)
    if (active && (!runId || active.runId === runId)) return active.state
    if (!runId) return null
    return this.store(projectPath).load(runId)?.state ?? null
  }

  report(projectPath: string, runId: string): (RunReport & { reason?: string | null; note?: string }) | null {
    const active = this.active.get(projectPath)
    if (active && active.runId === runId && !active.isFinal()) return { ...active.buildReport(), note: 'The run has not ended; this is an interim report.' }
    return this.store(projectPath).readReport(runId) as RunReport | null
  }

  /** The output of one step visit (default: its last visit) of the active or a stored run. */
  output(projectPath: string, step: string, visit?: number, runId?: string): { runId: string; step: string; visit: number; output: unknown } | null {
    const state = this.runState(projectPath, runId)
    if (!state) return null
    const visits = state.history.filter((h) => h.node === step)
    const chosen = visit ?? visits[visits.length - 1]?.visit
    if (chosen === undefined) return null
    const store = this.store(projectPath)
    let output = store.readOutput(state.runId, step, chosen)
    if (output === undefined && chosen === visits[visits.length - 1]?.visit) output = state.outputs[step]
    if (output === undefined) {
      const log = store.readCheckLog(state.runId, step, chosen)
      if (log) output = { log }
    }
    return output === undefined ? null : { runId: state.runId, step, visit: chosen, output }
  }

  transcript(projectPath: string, runId: string, node: string, visit: number): HistoryEntry[] {
    return this.store(projectPath).readTranscript(runId, node, visit)
  }

  agentInputs(projectPath: string, runId: string, node: string, visit: number): AgentInputRecord[] {
    return this.store(projectPath).readAgentInputs(runId, node, visit)
  }

  checkLog(projectPath: string, runId: string, node: string, visit: number): string {
    return this.store(projectPath).readCheckLog(runId, node, visit)
  }

  runs(projectPath: string): Array<{ runId: string; machineId: string; status: string; result: string | null }> {
    const store = this.store(projectPath)
    return store.list().slice(0, 50).flatMap((runId) => {
      const state = store.load(runId)?.state
      return state ? [{ runId, machineId: state.machineId, status: state.status, result: state.result }] : []
    })
  }
}
