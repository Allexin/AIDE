import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AutopilotState, DecisionRecord, JournalEntry, PlanFile, PlanListEntry } from '../../../shared/plan'
import type { AgentInputRecord } from '../../../shared/pipelineMachine'
import { planProblems, serializePlan } from './planFile'

/**
 * Plans on disk:
 *   <project>/aide/plans/<id>.json          the plan, committed
 *   <userDir>/active.json                   which plan is active for this user
 *   <userDir>/<id>/autopilot.json           autopilot state
 *   <userDir>/<id>/journal.jsonl            decisions, runs, attentions, notes
 *   <userDir>/<id>/decisions/<n>/           each Orchestrator call: what it was sent, its transcript, its answer
 *
 * Every read goes to the file, so an edit made by hand or by another AIDE on a
 * shared folder is seen at once.
 */

export const PLANS_DIR = 'aide/plans'

/** Project-relative path of a plan file, with forward slashes. */
export function planRelativePath(planId: string): string {
  return `${PLANS_DIR}/${planId}.json`
}

/** A change to a plan file is not part of a run's work. */
export function isPlanPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(`${PLANS_DIR}/`)
}

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, path)
}

export class PlanStore {
  constructor(private readonly projectPath: string, private readonly userDir: string) {}

  private plansDir(): string {
    return join(this.projectPath, 'aide', 'plans')
  }

  private planPath(id: string): string {
    return join(this.plansDir(), `${id}.json`)
  }

  private planUserDir(id: string): string {
    const dir = join(this.userDir, id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  list(): PlanListEntry[] {
    if (!existsSync(this.plansDir())) return []
    return readdirSync(this.plansDir()).filter((n) => n.endsWith('.json')).sort().map((name) => {
      const id = name.slice(0, -'.json'.length)
      const file = planRelativePath(id)
      try {
        return { id, file, plan: this.read(id), error: null }
      } catch (err) {
        return { id, file, plan: null, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  exists(id: string): boolean {
    return existsSync(this.planPath(id))
  }

  /** The plan; throws with a readable message when it is missing or invalid. */
  read(id: string): PlanFile {
    const path = this.planPath(id)
    if (!existsSync(path)) throw new Error(`Unknown plan "${id}". Call plan_list for the plans of this project.`)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`${planRelativePath(id)} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix the file (a merge conflict?).`)
    }
    const problems = planProblems(parsed)
    if (!problems.length && (parsed as PlanFile).id !== id) problems.push(`"id" is "${(parsed as PlanFile).id}" but the file is ${id}.json`)
    if (problems.length) throw new Error(`${planRelativePath(id)} is invalid:\n- ${problems.join('\n- ')}`)
    return parsed as PlanFile
  }

  write(plan: PlanFile): void {
    mkdirSync(this.plansDir(), { recursive: true })
    writeAtomic(this.planPath(plan.id), serializePlan(plan))
  }

  activeId(): string | null {
    try {
      const value = (JSON.parse(readFileSync(join(this.userDir, 'active.json'), 'utf8')) as { planId?: unknown }).planId
      return typeof value === 'string' ? value : null
    } catch {
      return null
    }
  }

  setActive(id: string | null): void {
    mkdirSync(this.userDir, { recursive: true })
    writeAtomic(join(this.userDir, 'active.json'), JSON.stringify({ planId: id }))
  }

  readAutopilot(id: string): AutopilotState | null {
    try {
      return JSON.parse(readFileSync(join(this.userDir, id, 'autopilot.json'), 'utf8')) as AutopilotState
    } catch {
      return null
    }
  }

  writeAutopilot(state: AutopilotState): void {
    writeAtomic(join(this.planUserDir(state.planId), 'autopilot.json'), JSON.stringify(state, null, 2))
  }

  appendJournal(id: string, entry: JournalEntry): void {
    appendFileSync(join(this.planUserDir(id), 'journal.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
  }

  readJournal(id: string): JournalEntry[] {
    const path = join(this.userDir, id, 'journal.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as JournalEntry] } catch { return [] }
    })
  }

  /** The run directory of one Orchestrator call. */
  decisionDir(id: string, decision: number): string {
    const dir = join(this.planUserDir(id), 'decisions', String(decision))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  appendDecisionTranscript(id: string, decision: number, entry: unknown): void {
    appendFileSync(join(this.decisionDir(id, decision), 'transcript.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
  }

  /** What the Orchestrator was sent, one record per CLI invocation. */
  appendDecisionInput(id: string, decision: number, input: AgentInputRecord): void {
    appendFileSync(join(this.decisionDir(id, decision), 'input.jsonl'), JSON.stringify(input) + '\n', 'utf8')
  }

  writeDecision(id: string, decision: number, value: unknown): void {
    writeFileSync(join(this.decisionDir(id, decision), 'decision.json'), JSON.stringify(value, null, 2), 'utf8')
  }

  private readJsonl(path: string): unknown[] {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as unknown] } catch { return [] }
    })
  }

  readDecisionRecord(id: string, decision: number): DecisionRecord {
    const dir = join(this.userDir, id, 'decisions', String(decision))
    let value: unknown = null
    try { value = JSON.parse(readFileSync(join(dir, 'decision.json'), 'utf8')) } catch { /* no answer yet, or none usable */ }
    return { entries: this.readJsonl(join(dir, 'transcript.jsonl')), inputs: this.readJsonl(join(dir, 'input.jsonl')), decision: value }
  }
}
