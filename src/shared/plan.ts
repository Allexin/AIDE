/**
 * Plan files (`aide/plans/<id>.json`) and the autopilot's state, shared with the
 * renderer. See docs/plan-mode-spec.md.
 */

export type PlanState = 'draft' | 'approved' | 'done' | 'dropped'
export type PlanTaskStatus = 'pending' | 'done' | 'blocked' | 'dropped'

export interface PlanTask {
  id: string
  title: string
  status: PlanTaskStatus
  /** Why it is blocked or dropped. */
  reason?: string
  /** Groups tasks in views; tasks of a phase need not be adjacent. */
  phase?: string
  /** Tasks that must be done or dropped first. */
  after?: string[]
  /** The machine that does this task under the autopilot. */
  machine?: string
  /** Machine params fixed by the plan; the Orchestrator fills the rest. */
  params?: Record<string, unknown>
  /** Where the task is described, e.g. `docs/x.md#csp`. */
  spec?: string
  acceptance?: string[]
  /** The Strategist is woken after this task, whatever the Orchestrator would say. */
  checkpoint?: boolean
}

export interface PlanFollowup {
  id: string
  text: string
  /** The task whose run found it. */
  from: string
  at: string
}

export interface PlanOrchestrator {
  cli: string
  model?: string
  effort?: string
  /** What to check and when to wake the Strategist. */
  prompt: string
  /** Tasks in a row without the Strategist before it is woken anyway (default 5). */
  maxUnreviewed?: number
  /** Decisions are shown to the Strategist instead of being carried out. */
  shadow?: boolean
  /**
   * Kinds of escalation inside a plan step that the Orchestrator answers before the
   * Strategist sees them; it may still pass one on. Absent: all go to the Strategist.
   */
  escalations?: EscalationKind[]
}

export type EscalationKind = 'step' | 'gate' | 'limit' | 'engine'
export const ESCALATION_KINDS: readonly EscalationKind[] = ['step', 'gate', 'limit', 'engine']

export interface PlanFile {
  id: string
  title: string
  goal?: string
  /** Where the intent of the whole plan is described: the Orchestrator reads it for the big picture. */
  spec?: string
  state: PlanState
  /** Counts edits by the Strategist and the user. */
  revision: number
  orchestrator?: PlanOrchestrator
  tasks: PlanTask[]
  followups: PlanFollowup[]
}

export type AutopilotStatus = 'idle' | 'deciding' | 'running' | 'held' | 'finished'

export type AttentionKind = 'run_failed' | 'wake' | 'checkpoint' | 'review_due' | 'no_machine' | 'stuck' | 'finished' | 'shadow' | 'orchestrator_failed' | 'paused' | 'outside_run'

export interface PlanAttention {
  kind: AttentionKind
  reason: string
  proposal?: string
  task?: string
  /** The Orchestrator call behind it, when there was one. */
  decision?: number
  at: string
}

export interface OrchestratorDecision {
  verdict: 'next' | 'wake'
  reason: string
  proposal: string
  handoff: string
  params: Record<string, unknown>
}

/** The Orchestrator on an escalation inside a plan step. */
export interface EscalationDecision {
  verdict: 'answer' | 'escalate'
  /** For answer: one of the escalation's actions except stop. */
  action: 'continue' | 'retry' | 'reject' | null
  /** For answer: what every later step of the run reads; for retry, the instruction the step works by. */
  text: string
  reason: string
  /** For escalate: what it proposes the Strategist answers. */
  proposal: string
}

export interface AutopilotState {
  planId: string
  status: AutopilotStatus
  /** The task of the current or last run. */
  task: string | null
  runId: string | null
  /** The commit the last plan step ended on; commits after it were made outside the plan. */
  lastCommit: string | null
  /** Tasks ended since the Strategist last acted. */
  unreviewed: number
  attention: PlanAttention | null
  /** A shadow decision waiting for `plan_run`, and the revision it was made on. */
  pending: { task: string; decision: OrchestratorDecision; revision: number } | null
  decisions: number
  /** The Orchestrator call on an escalation of the running step, while it decides. */
  answering?: { decision: number; node: string; kind: EscalationKind } | null
  /** Id of the last plan event, so numbering continues after an AIDE restart. */
  lastEventId: number
  updatedAt: string
}

export type JournalEntry =
  | { kind: 'decision'; at: string; startedAt: string; decision: number; task: string; verdict: 'next' | 'wake' | 'answer' | 'escalate'; reason: string; proposal?: string; handoff?: string; costUsd: number | null; shadow?: boolean
      /** An answer to an escalation inside the task's run, rather than a decision between tasks. */
      escalation?: { runId: string; id: string; kind: EscalationKind; node: string; action?: string; text?: string } }
  | { kind: 'run'; at: string; task: string; runId: string; result: string; commits: string[]; costUsd: number }
  | { kind: 'attention'; at: string; attention: PlanAttention }
  | { kind: 'note'; at: string; text: string }

/** A plan as views see it: the file, or why it cannot be read. */
export interface PlanListEntry {
  id: string
  file: string
  plan: PlanFile | null
  error: string | null
}

export interface PlanSnapshot {
  plans: PlanListEntry[]
  activeId: string | null
  autopilot: AutopilotState | null
  journal: JournalEntry[]
}

/** One step visit of a run, for the history of a task. */
export interface RunVisitInfo {
  node: string
  visit: number
  type: string
  /** It has a transcript and an input. */
  agent: boolean
  cli: string | null
  outcome: string | null
  startedAt: string
  finishedAt: string | null
  costUsd: number | null
  error: string | null
}

/** What one Orchestrator call recorded. */
export interface DecisionRecord {
  entries: unknown[]
  inputs: unknown[]
  decision: unknown
}

/** Done and dropped tasks count as finished. */
export function planProgress(plan: Pick<PlanFile, 'tasks'>): { done: number; total: number } {
  const live = plan.tasks.filter((t) => t.status !== 'dropped')
  return { done: live.filter((t) => t.status === 'done').length, total: live.length }
}

/** Who an escalation of a run waits for, as views say it. */
export function escalationAudience(e: { to: string; orchestrator?: { status: string; answer?: { action: string } } }): string {
  if (e.to === 'user') return 'the user'
  switch (e.orchestrator?.status) {
    case 'deciding': return 'the Orchestrator, deciding now'
    case 'shadow': return `the Strategist; the Orchestrator would answer ${e.orchestrator.answer?.action ?? '?'}`
    case 'escalated': return 'the Strategist, passed on by the Orchestrator'
    case 'failed': return 'the Strategist; the Orchestrator could not answer'
    default: return 'the Strategist'
  }
}
