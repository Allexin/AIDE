import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '../../pty/cliTools/types'
import type { AgentInputRecord } from '../../../shared/pipelineMachine'
import type { MachineDefinition, RunState } from './types'

/**
 * On-disk layout of a run (plan §7):
 *
 * <runsRoot>/<runId>/
 *   machine.json      snapshot of the definition at start (+ machineDir)
 *   params.json
 *   state.json        written atomically after every transition
 *   events.jsonl      append-only event log
 *   nodes/<node>-<visit>/        run dir handed to the agent CLI (schema, last message)
 *   nodes/<node>-<visit>.jsonl   normalized transcript of that visit
 *   nodes/<node>-<visit>.input.jsonl  what the agent was sent, per CLI invocation
 *   outputs/<node>-<visit>.json  output of that visit (agent JSON, check exit code + log tail, commit result)
 *   checks/<node>-<visit>.log    output of a check node
 *   report.json
 */

export interface StoredMachine {
  machine: MachineDefinition
  /** Directory the machine file was loaded from (role paths are relative to it). */
  machineDir: string
}

export class RunStore {
  constructor(readonly runsRoot: string) {}

  dir(runId: string): string {
    return join(this.runsRoot, runId)
  }

  exists(runId: string): boolean {
    return existsSync(this.dir(runId))
  }

  create(state: RunState, stored: StoredMachine, params: Record<string, unknown>): void {
    const dir = this.dir(state.runId)
    mkdirSync(join(dir, 'nodes'), { recursive: true })
    mkdirSync(join(dir, 'checks'), { recursive: true })
    writeFileSync(join(dir, 'machine.json'), JSON.stringify(stored, null, 2), 'utf8')
    writeFileSync(join(dir, 'params.json'), JSON.stringify(params, null, 2), 'utf8')
    this.saveState(state)
  }

  /** Params changed by an escalation answer. */
  writeParams(runId: string, params: Record<string, unknown>): void {
    writeFileSync(join(this.dir(runId), 'params.json'), JSON.stringify(params, null, 2), 'utf8')
  }

  /** Replace the machine snapshot (`pipeline_reload`). */
  writeMachine(runId: string, stored: StoredMachine): void {
    writeFileSync(join(this.dir(runId), 'machine.json'), JSON.stringify(stored, null, 2), 'utf8')
  }

  saveState(state: RunState): void {
    const path = join(this.dir(state.runId), 'state.json')
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(temp, path)
  }

  appendEvent(runId: string, event: Record<string, unknown>): void {
    appendFileSync(join(this.dir(runId), 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8')
  }

  /** Id of the last event logged for a run (0 when none). */
  lastEventId(runId: string): number {
    const path = join(this.dir(runId), 'events.jsonl')
    if (!existsSync(path)) return 0
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return Number((JSON.parse(lines[i]) as { id?: unknown }).id) || 0 } catch { /* torn last line */ }
    }
    return 0
  }

  nodeRunDir(runId: string, node: string, visit: number): string {
    const dir = join(this.dir(runId), 'nodes', `${node}-${visit}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** An input too large for the prompt, saved for the agent to read; returns its path. */
  writeInputFile(runId: string, node: string, visit: number, name: string, text: string): string {
    const dir = join(this.nodeRunDir(runId, node, visit), 'inputs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${name}.txt`)
    writeFileSync(path, text, 'utf8')
    return path
  }

  /** What an agent was sent, one record per CLI invocation of the visit. */
  appendAgentInput(runId: string, node: string, visit: number, input: AgentInputRecord): void {
    appendFileSync(join(this.dir(runId), 'nodes', `${node}-${visit}.input.jsonl`), JSON.stringify(input) + '\n', 'utf8')
  }

  readAgentInputs(runId: string, node: string, visit: number): AgentInputRecord[] {
    const path = join(this.dir(runId), 'nodes', `${node}-${visit}.input.jsonl`)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as AgentInputRecord] } catch { return [] }
    })
  }

  appendTranscript(runId: string, node: string, visit: number, entry: HistoryEntry): void {
    appendFileSync(join(this.dir(runId), 'nodes', `${node}-${visit}.jsonl`), JSON.stringify(entry) + '\n', 'utf8')
  }

  readTranscript(runId: string, node: string, visit: number): HistoryEntry[] {
    const path = join(this.dir(runId), 'nodes', `${node}-${visit}.jsonl`)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as HistoryEntry] } catch { return [] }
    })
  }

  writeOutput(runId: string, node: string, visit: number, output: unknown): void {
    const dir = join(this.dir(runId), 'outputs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${node}-${visit}.json`), JSON.stringify(output ?? null, null, 2), 'utf8')
  }

  readOutput(runId: string, node: string, visit: number): unknown {
    const path = join(this.dir(runId), 'outputs', `${node}-${visit}.json`)
    if (!existsSync(path)) return undefined
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
  }

  appendCheckLog(runId: string, node: string, visit: number, text: string): void {
    appendFileSync(join(this.dir(runId), 'checks', `${node}-${visit}.log`), text, 'utf8')
  }

  checkLogPath(runId: string, node: string, visit: number): string {
    return join(this.dir(runId), 'checks', `${node}-${visit}.log`)
  }

  readCheckLog(runId: string, node: string, visit: number): string {
    const path = this.checkLogPath(runId, node, visit)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  writeReport(runId: string, report: unknown): void {
    writeFileSync(join(this.dir(runId), 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  }

  readReport(runId: string): unknown {
    const path = join(this.dir(runId), 'report.json')
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  }

  load(runId: string): { state: RunState; stored: StoredMachine; params: Record<string, unknown> } | null {
    const dir = this.dir(runId)
    try {
      return {
        state: currentActors(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RunState),
        stored: JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8')) as StoredMachine,
        params: JSON.parse(readFileSync(join(dir, 'params.json'), 'utf8')) as Record<string, unknown>
      }
    } catch {
      return null
    }
  }

  /** Run ids, newest first. */
  list(): string[] {
    if (!existsSync(this.runsRoot)) return []
    return readdirSync(this.runsRoot).filter((name) => existsSync(join(this.runsRoot, name, 'state.json'))).sort().reverse()
  }
}

export function newRunId(machineId: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${stamp}-${machineId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/**
 * A run from before the plan's Orchestrator could answer escalations said
 * "orchestrator" for the Strategist: its escalations go to "agent" and its
 * decisions are the Strategist's.
 */
export function currentActors(state: RunState): RunState {
  if (state.actors === 2) return state
  const legacy = state as unknown as { escalations?: Array<{ to: string; answer: { by: string } | null }>; amendments?: Array<{ by: string }> }
  for (const e of legacy.escalations ?? []) {
    if (e.to === 'orchestrator') e.to = 'agent'
    if (e.answer?.by === 'orchestrator') e.answer.by = 'strategist'
  }
  for (const a of legacy.amendments ?? []) if (a.by === 'orchestrator') a.by = 'strategist'
  state.actors = 2
  return state
}
