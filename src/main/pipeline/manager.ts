import { EventEmitter } from 'events'
import type { HistoryEntry } from '../pty/cliTools/types'
import { PipelineRun, type EngineDeps } from './engine/runner'
import { RunStore, newRunId } from './engine/runStore'
import { loadLibrary, readRole, roleExists, validateParams, type LibraryEntry } from './engine/library'
import { validateMachine, type ValidationResult } from './engine/validate'
import type { EscalationAnswer, MachineDefinition, RunState } from './engine/types'
import { pipelineEvents, type PipelineEventType } from './events'

/**
 * Owns pipeline runs per project: the machine library, the single active run,
 * recovery after an AIDE restart, and the bridge from engine events to the
 * orchestrator feed and the UI.
 *
 * Emits:
 *   'state'      (projectPath, snapshot)                 on every run state change
 *   'transcript' (projectPath, runId, node, visit, entry) streamed agent transcript entries
 *   'event'      (projectPath, runId, type, data)        pipeline events
 */

export interface ManagerEnvironment {
  runsRoot(projectPath: string): string
  libraryDirs(projectPath: string): Array<{ dir: string; source: 'shared' | 'personal' }>
  headlessClis(): string[]
  /** Engine dependencies except `emit`, `onStateChange`, `onTranscript`, `readRole`, which the manager supplies. */
  deps(projectPath: string): Pick<EngineDeps, 'startAgent' | 'runCheck' | 'git'>
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
        const event = pipelineEvents.emit(projectPath, runId, type, data)
        try { store.appendEvent(runId, event as unknown as Record<string, unknown>) } catch { /* run dir removed */ }
        this.emit('event', projectPath, runId, type, data)
      },
      onStateChange: (state: RunState) => {
        const run = this.active.get(projectPath)
        if (run && run.runId === state.runId) this.emit('state', projectPath, this.toSnapshot(projectPath, run))
      },
      onTranscript: (runId: string, node: string, visit: number, entry: HistoryEntry) => {
        this.emit('transcript', projectPath, runId, node, visit, entry)
      }
    }
  }

  /** Start a run. Returns the run id and non-fatal warnings, or throws with a readable message. */
  async start(projectPath: string, machineId: string, params: Record<string, unknown>): Promise<{ runId: string; warnings: string[] }> {
    const current = this.active.get(projectPath)
    if (current && !current.isFinal()) throw new Error(`Run ${current.runId} is still ${current.state.status}. Finish, stop or abandon it first.`)
    const entry = this.library(projectPath).find((e) => e.machine.id === machineId)
    if (!entry) throw new Error(`Unknown machine "${machineId}". Call pipeline_list for the available machines.`)
    const validation = this.validate(entry)
    if (validation.errors.length) throw new Error(`Machine "${machineId}" is invalid:\n- ${validation.errors.join('\n- ')}`)
    const paramErrors = validateParams(entry.machine.params, params)
    if (paramErrors.length) throw new Error(`Invalid params:\n- ${paramErrors.join('\n- ')}`)

    const warnings = [...validation.warnings]
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
      if (state.status === 'running' || state.status === 'pausing') {
        // The process that ran it is gone; an in-flight visit counts as interrupted.
        const last = state.history[state.history.length - 1]
        if (last && !last.finishedAt) { last.outcome = 'interrupted'; last.finishedAt = new Date().toISOString(); state.visits[last.node] = Math.max(0, (state.visits[last.node] ?? 1) - 1) }
        state.status = 'paused'
        store.saveState(state)
      }
      const run = new PipelineRun(stored, params, state, store, this.engineDeps(projectPath, store))
      this.active.set(projectPath, run)
      return this.toSnapshot(projectPath, run)
    }
    return null
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
    void run.run()
  }

  abandon(projectPath: string, reason: string, runId?: string): void {
    const run = this.require(projectPath, runId)
    if (run.state.status === 'running' || run.state.status === 'pausing') throw new Error('Stop the run before abandoning it.')
    run.abandon(reason)
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

  report(projectPath: string, runId: string): unknown {
    const active = this.active.get(projectPath)
    if (active && active.runId === runId && !active.isFinal()) return { ...active.buildReport(), note: 'The run has not ended; this is an interim report.' }
    return this.store(projectPath).readReport(runId)
  }

  transcript(projectPath: string, runId: string, node: string, visit: number): HistoryEntry[] {
    return this.store(projectPath).readTranscript(runId, node, visit)
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
