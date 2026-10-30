/**
 * Pipeline machine definitions and run state (plan §2, §3, §4). The definition
 * types live in `src/shared/pipelineMachine.ts` (the renderer uses them too).
 */

export type {
  AgentStep, CheckStep, CommitStep, EscalationTo, GateStep, GroupStep, IfStep, JsonSchema, LoopStep,
  MachineDefinition, ParamDefinition, ParamType, RepeatStep, Step, StepType
} from '../../../shared/pipelineMachine'

// ── Run state ─────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'pausing' | 'paused' | 'waiting' | 'stopped' | 'finished' | 'failed'

export type Outcome = 'ok' | 'fail'

export interface NodeVisit {
  node: string
  visit: number
  outcome: Outcome | 'interrupted' | null
  startedAt: string
  finishedAt: string | null
  /** CLI session of an agent node (for `continue:` and resume after stop). */
  sessionId: string | null
  costUsd: number | null
  error: string | null
  /** Attempts the visit made while its CLI was unavailable (the error is the last one, until an attempt gets through). */
  retries?: number
  /** Cut off by an unavailable CLI or a usage limit: the next attempt continues this record instead of adding one. */
  pendingRetry?: boolean
}

/** A step's CLI is temporarily unavailable; the engine retries it every minute for a while. */
export interface UnavailableState {
  node: string
  cli: string
  /** The first failure: the retries end, with an escalation, a fixed time after it. */
  since: string
  attempts: number
  lastError: string
}

export interface Escalation {
  id: string
  /** The step (or, for `limit`, the loop/commit block) that raised it. */
  node: string
  /**
   * `step`: a step asked for a decision (`escalateIf`, or a failed check outside any loop);
   * `gate`: a gate asks for approval; `limit`: a loop used up its iterations;
   * `engine`: the engine could not run the step (agent crash, unusable output, …).
   */
  kind: 'step' | 'gate' | 'limit' | 'engine'
  /** `agent`: the plan's Orchestrator when the plan lets it answer this kind, the Strategist otherwise. */
  to: 'user' | 'agent'
  message: string
  /** The step visit whose output explains the escalation (for `pipeline_output`). */
  source?: { step: string; visit: number }
  raisedAt: string
  answer: EscalationAnswer | null
  /** What the plan's Orchestrator did with it, when it was asked. */
  orchestrator?: OrchestratorHandling
}

/** The plan's Orchestrator on an escalation: it is deciding, it answered, or it passed it on to the Strategist. */
export interface OrchestratorHandling {
  status: 'deciding' | 'answered' | 'escalated' | 'shadow' | 'failed'
  /** The Orchestrator call (numbered with the plan's decisions); absent when AIDE passed it on without one. */
  decision?: number
  reason?: string
  /** For escalated / shadow: what it proposes the Strategist answers. */
  proposal?: string
  /** For shadow: the answer it would have given. */
  answer?: { action: EscalationAnswer['action']; text: string }
}

/** Who took a decision or added an instruction. */
export type Actor = 'user' | 'strategist' | 'orchestrator'

export interface EscalationAnswer {
  /**
   * continue: go on after the step (gate: approve; limit: leave the loop as if it passed);
   * retry: run the step again (limit: one more iteration); reject: reject a gate; stop: end the run.   */
  action: 'continue' | 'retry' | 'reject' | 'stop'
  text: string
  by: Actor
  at: string
  /** Params changed by this answer for the rest of the run (e.g. the stage id after a split). */
  params?: Record<string, unknown>
}

export interface Amendment {
  /** The step that was running (or next) when the instruction was given. */
  node: string | null
  text: string
  by: Actor
  at: string
}

export interface LoopFeedback {
  /** The step that asked for another iteration. */
  from: string
  /** The iteration this feedback leads into. */
  iteration: number
  reason: string
  details: string
}

/** The plan task a run works on. */
export interface PlanTaskLink {
  plan: string
  task: string
}

export interface RunState {
  runId: string
  machineId: string
  projectPath: string
  /** The plan task this run does; absent for a run outside any plan. */
  planTask?: PlanTaskLink | null
  /** Started by the plan's autopilot: its end goes to the autopilot, not to the Strategist. */
  planAuto?: boolean
  /**
   * 2: escalations go to "agent" and decisions are by "strategist" or "orchestrator" (the plan's).
   * Older runs said "orchestrator" for the Strategist; the store translates them on load.
   */
  actors?: 2
  status: RunStatus
  /** Leaf step to execute next (or currently executing / interrupted). */
  current: string | null
  /** Executions per leaf step (numbers transcripts and logs). */
  visits: Record<string, number>
  /** Current iteration per entered loop / commit block. */
  iterations: Record<string, number>
  /** Iterations granted beyond the limit by "retry" answers, per loop. */
  bonus: Record<string, number>
  /** Why each loop is on its current iteration (shown to the agents inside it). */
  feedback: Record<string, LoopFeedback>
  /** `history.length` when each loop's current iteration started (what ran in this iteration). */
  iterationStart?: Record<string, number>
  /** Instructions added while the run was going (`pipeline_amend`), shown to every later step. */
  amendments?: Amendment[]
  /** Set while the run waits for a CLI usage limit to reset; the run resumes by itself then. */
  limitResumeAt?: string | null
  /** The CLI whose usage limit the run waits for (set with limitResumeAt). */
  limitCli?: string | null
  /** Set while a step's CLI is retried because it is unavailable; kept after the escalation that ends the retries
   *  (its retry gets one attempt), cleared when an attempt gets through or the run is resumed by hand. */
  unavailable?: UnavailableState | null
  outputs: Record<string, unknown>
  history: NodeVisit[]
  escalations: Escalation[]
  sessions: Record<string, string>
  startCommit: string | null
  result: 'success' | 'failure' | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}
