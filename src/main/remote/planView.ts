import type { AutopilotState, JournalEntry, PlanAttention, PlanSnapshot, PlanTask } from '../../shared/plan'
import { planProgress } from '../../shared/plan'

/**
 * The remote pipeline page's view of the project's plans: the active plan's tasks,
 * each with its execution history (the Orchestrator's calls and the runs, in order),
 * and what the plan waits for. The step visits of a run are loaded when the page
 * opens it (`plan-run-visits`), so a state change does not read every run from disk.
 */

export type RemoteTaskHistoryItem =
  | { kind: 'decision'; at: string; startedAt: string; decision: number; verdict: 'next' | 'wake' | 'answer' | 'escalate'; reason: string; proposal?: string; handoff?: string; costUsd: number | null; shadow?: boolean; escalation?: { kind: string; node: string; action?: string } }
  | { kind: 'run'; at: string; runId: string; result: string; commits: string[]; costUsd: number }
  | { kind: 'attention'; at: string; attentionKind: PlanAttention['kind']; reason: string; decision?: number }

export interface RemotePlanTask extends Pick<PlanTask, 'id' | 'title' | 'status' | 'reason' | 'phase' | 'after' | 'machine' | 'spec' | 'acceptance' | 'checkpoint'> {
  live: boolean
  history: RemoteTaskHistoryItem[]
}

export interface RemotePlanView {
  plans: Array<{ id: string; title: string | null; state: string | null; done: number; total: number; active: boolean; error: string | null }>
  active: null | {
    id: string
    title: string
    goal: string | null
    state: string
    revision: number
    done: number
    total: number
    orchestratorCli: string | null
    shadow: boolean
    status: AutopilotState['status']
    /** The Orchestrator call in progress. */
    deciding: number | null
    /** The run of the task in progress. */
    runId: string | null
    attention: PlanAttention | null
    pendingDecision: AutopilotState['pending']
    unreviewed: number
    tasks: RemotePlanTask[]
    followups: Array<{ id: string; text: string; from: string }>
    notes: Array<{ at: string; text: string }>
  }
}

/** What the terminal page needs for its Pipeline button. */
export interface RemotePlanBrief {
  title: string
  needsAttention: boolean
}

const QUIET_ATTENTIONS: ReadonlySet<PlanAttention['kind']> = new Set(['paused', 'outside_run'])

function historyItem(entry: JournalEntry): { task: string; item: RemoteTaskHistoryItem } | null {
  switch (entry.kind) {
    case 'decision': {
      const { kind, task, at, startedAt, decision, verdict, reason, proposal, handoff, costUsd, shadow, escalation } = entry
      return { task, item: { kind, at, startedAt, decision, verdict, reason, proposal, handoff, costUsd, shadow, ...(escalation ? { escalation: { kind: escalation.kind, node: escalation.node, ...(escalation.action ? { action: escalation.action } : {}) } } : {}) } }
    }
    case 'run': {
      const { kind, task, at, runId, result, commits, costUsd } = entry
      return { task, item: { kind, at, runId, result, commits, costUsd } }
    }
    case 'attention':
      if (!entry.attention.task) return null
      return { task: entry.attention.task, item: { kind: 'attention', at: entry.at, attentionKind: entry.attention.kind, reason: entry.attention.reason, decision: entry.attention.decision } }
    case 'note':
      return null
  }
}

export function buildRemotePlanView(snapshot: PlanSnapshot, options: { brief: true }): RemotePlanBrief | null
export function buildRemotePlanView(snapshot: PlanSnapshot, options?: { brief?: boolean }): RemotePlanView | RemotePlanBrief | null
export function buildRemotePlanView(snapshot: PlanSnapshot, options: { brief?: boolean } = {}): RemotePlanView | RemotePlanBrief | null {
  if (snapshot.plans.length === 0) return null
  const entry = snapshot.plans.find((p) => p.id === snapshot.activeId)
  const plan = entry?.plan ?? null
  const auto = snapshot.autopilot
  if (options.brief) {
    const attention = auto?.attention
    return { title: plan?.title ?? 'Plans', needsAttention: !!attention && !QUIET_ATTENTIONS.has(attention.kind) && auto?.status !== 'finished' }
  }
  const plans = snapshot.plans.map((p) => ({
    id: p.id,
    title: p.plan?.title ?? null,
    state: p.plan?.state ?? null,
    ...(p.plan ? planProgress(p.plan) : { done: 0, total: 0 }),
    active: p.id === snapshot.activeId,
    error: p.error
  }))
  if (!plan) return { plans, active: null }

  const history = new Map<string, RemoteTaskHistoryItem[]>()
  for (const journal of snapshot.journal) {
    const found = historyItem(journal)
    if (found) history.set(found.task, [...(history.get(found.task) ?? []), found.item])
  }
  const working = auto?.status === 'running' ? auto.task : null
  return {
    plans,
    active: {
      id: plan.id,
      title: plan.title,
      goal: plan.goal ?? null,
      state: plan.state,
      revision: plan.revision,
      ...planProgress(plan),
      orchestratorCli: plan.orchestrator?.cli ?? null,
      shadow: plan.orchestrator?.shadow === true,
      status: auto?.status ?? 'idle',
      deciding: auto?.answering ? auto.answering.decision : auto?.status === 'deciding' && auto.decisions > 0 ? auto.decisions : null,
      runId: auto?.status === 'running' ? auto.runId : null,
      attention: auto?.attention ?? null,
      pendingDecision: auto?.pending ?? null,
      unreviewed: auto?.unreviewed ?? 0,
      tasks: plan.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        reason: task.reason,
        phase: task.phase,
        after: task.after,
        machine: task.machine,
        spec: task.spec,
        acceptance: task.acceptance,
        checkpoint: task.checkpoint,
        live: task.id === working,
        history: history.get(task.id) ?? []
      })),
      followups: plan.followups.map((f) => ({ id: f.id, text: f.text, from: f.from })),
      notes: snapshot.journal.flatMap((j) => (j.kind === 'note' ? [{ at: j.at, text: j.text }] : [])).slice(-20)
    }
  }
}
