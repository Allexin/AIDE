/**
 * Pipeline machine definitions (plan §2, §3), shared by the main-process engine
 * and the renderer's run view.
 *
 * A machine is a **tree of steps** executed top to bottom. There are no
 * arbitrary jumps: control only moves to the next step, into a block, or back to
 * the start of an enclosing loop.
 *
 *   agent  — a headless CLI does the work of its role (leaf)
 *   check  — AIDE runs a shell command; inside a loop a failure repeats the loop (leaf)
 *   gate   — the user or the orchestrator approves; rejecting inside a loop repeats it (leaf)
 *   repeat — starts an enclosing loop over (leaf; usually inside an `if`)
 *   commit — a prep agent stages and writes the message, AIDE reviews and commits;
 *            review problems go back to the prep agent (block with built-in retry)
 *   loop   — runs its steps again until a pass completes without a repeat request
 *   group  — a titled sequence (a phase of the pipeline)
 *   if     — runs `then` or `else` depending on a condition
 *
 * Conditions are `<ref> == <literal>` or `<ref> != <literal>`, e.g.
 * `outputs.review.verdict != 'accept'`.
 */

export type JsonSchema = Record<string, unknown>

export type ParamType = 'string' | 'string[]' | 'path' | 'glob[]' | 'number' | 'boolean'

export interface ParamDefinition {
  type: ParamType
  description?: string
  /** Defaults to true. */
  required?: boolean
}

interface StepBase {
  /** Unique across the whole machine; used in `outputs.<id>` references. */
  id: string
  /** One line telling the other agents what this step does (pipeline context). */
  summary?: string
}

export interface AgentStep extends StepBase {
  type: 'agent'
  /** Role file, relative to the machine's directory (e.g. `roles/implementer.md`). */
  role: string
  /** CliTool id; falls back to machine defaults. */
  cli?: string
  model?: string
  /** Reasoning effort, e.g. "high" (Claude Code: low…max; Codex: low…ultra, per model). Default: the CLI's own default. */
  effort?: string
  permissions?: 'read-only' | 'write'
  /**
   * `keep` (default): every visit of this step continues its own previous session.
   * `new`: a fresh session every visit. `continue:<agent step>`: continue that step's session.
   */
  session?: string
  /** Task text; may reference `{{params.x}}` / `{{outputs.step.field}}`. */
  task?: string
  /**
   * References included in the prompt: `params.x`, `outputs.step.field`, `run.diff`,
   * `run.stagedDiff`, `run.changedFiles`. The `run.*` file refs accept path filters:
   * `{ "ref": "run.diff", "exclude": ["Source/Scenarios/**\/*.txt"] }`.
   */
  inputs?: Array<string | AgentInput>
  /** Name of a schema in `schemas` or a built-in (implementerReport, reviewVerdict, commitPrep, commitReview). */
  output?: string
  timeoutMin?: number
  /** Ends this iteration of the enclosing loop and starts the next one when true. */
  repeatIf?: string
  /** Which enclosing loop `repeatIf` repeats; defaults to the innermost one. */
  repeatLoop?: string
  /** Hands the run to the agents or the user when true (e.g. the implementer reports `plan_wrong`). */
  escalateIf?: string
  escalateMessage?: string
  escalateTo?: EscalationTo
}

/**
 * Who a decision of a run goes to. `agent`: the agents that manage the run — the
 * plan's Orchestrator when the plan lets it answer, the Strategist otherwise.
 * `orchestrator` is the name of `agent` in machines written for engine 5 or older.
 */
export type EscalationTo = 'agent' | 'user' | 'orchestrator'

/** An input with a path filter; filters apply to `run.diff`, `run.stagedDiff` and `run.changedFiles`. */
export interface AgentInput {
  ref: string
  /** Globs over repo-relative paths: only matching files are kept. */
  include?: string[]
  /** Globs over repo-relative paths: matching files are dropped. */
  exclude?: string[]
}

export function inputRef(input: string | AgentInput): string {
  return typeof input === 'string' ? input : input.ref
}

/** What an agent CLI was sent, one record per invocation (kept per visit for the run view). */
export interface AgentInputRecord {
  at: string
  /** task: the step's prompt; retry: invalid output sent back; continuation: an earlier attempt resumed; review: the commit reviewer. */
  kind: 'task' | 'retry' | 'continuation' | 'review'
  cli: string
  model: string | null
  effort: string | null
  permissions: 'read-only' | 'write'
  /** The CLI session continued, or null for a fresh one. */
  resumeSessionId: string | null
  /** The user message. */
  prompt: string
  /** Role, pipeline context and output contract, appended to the CLI's system prompt. */
  systemAppend: string
}

export interface CheckStep extends StepBase {
  type: 'check'
  command: string
  timeoutMin?: number
  /** Which enclosing loop a failure repeats; defaults to the innermost one. */
  repeatLoop?: string
}

export interface GateStep extends StepBase {
  type: 'gate'
  question: string
  to?: EscalationTo
  /** Which enclosing loop a rejection repeats; defaults to the innermost one. */
  repeatLoop?: string
}

/** Starts an enclosing loop over, like `continue` in code. Usually placed inside an `if`. */
export interface RepeatStep extends StepBase {
  type: 'repeat'
  /** Id of the enclosing loop to start over. */
  loop: string
  /** Why — shown to the agents of the next iteration together with the previous step's output. */
  reason?: string
}

export interface CommitStep extends StepBase {
  type: 'commit'
  /** Agent that stages the change and outputs `commitMessage` + `excluded`. */
  prep: AgentStep
  review: 'algorithmic' | 'agent'
  /** Reviewer for `review: 'agent'`. */
  reviewer?: { role: string; cli?: string; model?: string; effort?: string; timeoutMin?: number }
  /** Prep → review attempts before `onLimit`. Default 3. */
  maxAttempts?: number
  onLimit?: 'escalate' | 'fail'
}

export interface LoopStep extends StepBase {
  type: 'loop'
  name?: string
  maxIterations: number
  /** What happens when the last allowed iteration still asks to repeat. Default `escalate`. */
  onLimit?: 'escalate' | 'fail'
  steps: Step[]
}

export interface GroupStep extends StepBase {
  type: 'group'
  name?: string
  steps: Step[]
}

export interface IfStep extends StepBase {
  type: 'if'
  condition: string
  then: Step[]
  else?: Step[]
}

export type Step = AgentStep | CheckStep | GateStep | RepeatStep | CommitStep | LoopStep | GroupStep | IfStep
export type StepType = Step['type']

export interface MachineDefinition {
  id: string
  name: string
  /** Written for the orchestrator: when to use this machine, what it needs, what it produces. */
  description: string
  /**
   * The AIDE pipeline engine version this machine (and its role files) was
   * written or last reviewed for. Starting an older one is refused until it is
   * reviewed, because engine changes can alter how it behaves.
   */
  engineVersion?: number
  params?: Record<string, ParamDefinition>
  defaults?: { cli?: string; model?: string; effort?: string; timeoutMin?: number }
  /** Named output schemas referenced by agent steps. */
  schemas?: Record<string, JsonSchema>
  steps: Step[]
}

export const STEP_TYPES: readonly StepType[] = ['agent', 'check', 'gate', 'repeat', 'commit', 'loop', 'group', 'if']

/** Child step lists of a block, in display order (`if`: then, else). */
export function childLists(step: Step): Step[][] {
  switch (step.type) {
    case 'loop':
    case 'group': return [Array.isArray(step.steps) ? step.steps : []]
    case 'if': return [Array.isArray(step.then) ? step.then : [], Array.isArray(step.else) ? step.else : []]
    case 'commit': return step.prep && typeof step.prep === 'object' ? [[step.prep]] : [[]]
    default: return []
  }
}

/** Depth-first walk in document order; `ancestors` are the enclosing blocks, outermost first. */
export function walkSteps(steps: Step[], visit: (step: Step, ancestors: Step[]) => void, ancestors: Step[] = []): void {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object') continue
    visit(step, ancestors)
    for (const list of childLists(step)) walkSteps(list, visit, [...ancestors, step])
  }
}

/** CLI tool ids the machine runs: agent steps and commit reviewers, falling back to the machine default. */
export function machineClis(machine: Pick<MachineDefinition, 'steps' | 'defaults'>): string[] {
  const ids = new Set<string>()
  const fallback = machine.defaults?.cli
  walkSteps(machine.steps, (step) => {
    const cli = step.type === 'agent' ? step.cli ?? fallback : step.type === 'commit' && step.review === 'agent' ? step.reviewer?.cli ?? fallback : undefined
    if (cli) ids.add(cli)
  })
  return [...ids]
}

/** The display title of a block. */
export function blockTitle(step: Step): string {
  if ((step.type === 'loop' || step.type === 'group') && step.name) return step.name
  return step.id
}
