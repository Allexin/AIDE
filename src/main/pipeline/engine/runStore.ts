import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '../../pty/cliTools/types'
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

  create(state: RunState, stored: StoredMachine, params: Record<string, unknown>): void {
    const dir = this.dir(state.runId)
    mkdirSync(join(dir, 'nodes'), { recursive: true })
    mkdirSync(join(dir, 'checks'), { recursive: true })
    writeFileSync(join(dir, 'machine.json'), JSON.stringify(stored, null, 2), 'utf8')
    writeFileSync(join(dir, 'params.json'), JSON.stringify(params, null, 2), 'utf8')
    this.saveState(state)
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

  nodeRunDir(runId: string, node: string, visit: number): string {
    const dir = join(this.dir(runId), 'nodes', `${node}-${visit}`)
    mkdirSync(dir, { recursive: true })
    return dir
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

  appendCheckLog(runId: string, node: string, visit: number, text: string): void {
    appendFileSync(join(this.dir(runId), 'checks', `${node}-${visit}.log`), text, 'utf8')
  }

  readCheckLog(runId: string, node: string, visit: number): string {
    const path = join(this.dir(runId), 'checks', `${node}-${visit}.log`)
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
        state: JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RunState,
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
