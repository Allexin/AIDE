import { EventEmitter } from 'events'
import type { AttentionKind, AutopilotState, DecisionRecord, EscalationDecision, JournalEntry, OrchestratorDecision, PlanAttention, PlanFile, PlanOrchestrator, PlanSnapshot, PlanTask, RunVisitInfo } from '../../../shared/plan'
import { planProgress } from '../../../shared/plan'
import type { Escalation, OrchestratorHandling, ParamDefinition, PlanTaskLink, RunState } from '../engine/types'
import { compactEscalation } from '../engine/runner'
import { validateParams } from '../engine/library'
import { compactReport } from '../engine/reportView'
import { outputContract, invalidOutputPrompt } from '../engine/context'
import { validateAgainstSchema } from '../engine/schema'
import { clip, pipelineEvents } from '../events'
import type { PipelineManager } from '../manager'
import { applyOps, markDone, newPlan, nextTask, planDetail, type PlanOp } from './planFile'
import { PlanStore, planRelativePath } from './planStore'

/**
 * Plans of the open projects: editing, the active plan, and the autopilot that
 * walks a plan task by task. See docs/plan-mode-spec.md.
 *
 * The autopilot's rule: code can only wake the Strategist, only the Orchestrator
 * (a fresh headless session with no memory of its own) can say continue. It never
 * changes the plan.
 *
 * Emits 'changed' (projectPath) whenever what a plan view shows may have changed,
 * and 'decision-entry' (projectPath, planId, decision, entry) for the transcript of
 * an Orchestrator call as it streams.
 */

export interface PlanEnvironment {
  /** Per-user directory for the plans of this project. */
  userDir(projectPath: string): string
  stage(projectPath: string, paths: string[]): Promise<void>
  headSha(projectPath: string): Promise<string | null>
  commitsSince(projectPath: string, since: string): Promise<string[]>
}

const DEFAULT_MAX_UNREVIEWED = 5
const ORCHESTRATOR_TIMEOUT_MS = 15 * 60_000
const REPORT_CHARS = 20_000
const ESCALATION_MESSAGE_CHARS = 6_000
const SOURCE_OUTPUT_CHARS = 12_000
const JOURNAL_FOR_PROMPT = 12
const JOURNAL_FOR_VIEW = 200

const ORCHESTRATOR_ROLE = [
  'You are the Orchestrator of a plan in AIDE. You wake when a step of the plan ends, in a new session, with no memory of earlier calls; what you need is below, and you may read the project\'s files (the specs the tasks point at) to judge.',
  'You decide one thing: whether the plan can go on to its next task now. Answer "next" to start it, or "wake" to hand over to the Strategist, the agent that owns the plan.',
  'Judge the step against the whole plan, not only the next task: did it meet its acceptance, does what it did or found change what a later task relies on, do the follow-ups show a recurring problem.',
  'You do not change the plan and you do not edit files. If you think the plan should change, answer "wake" and say what you propose in "proposal". The checks and reviewers inside the step already did their work; do not repeat them. When you are in doubt, wake the Strategist: a needless wake costs little, a wrong step costs a lot.',
  'For "next", fill "params" for the machine that does the task (what the plan leaves open), and put what the next step must know from this one in "handoff"; it is your only way to pass anything on. For "wake", set every param to null.'
].join('\n\n')

const ESCALATION_ROLE = [
  'You are the Orchestrator of a plan in AIDE. A run that does a task of the plan stopped for a decision (an escalation), and you answer it before the Strategist, the agent that owns the plan, sees it. You work in a new session with no memory of earlier calls; what you need is below, and you may read the project\'s files (the specs, the step\'s output) to judge.',
  'Answer it yourself ("answer") when the plan, the task\'s spec and acceptance and this plan\'s instructions decide it. Pass it to the Strategist ("escalate") when it needs more: the plan or the task should change, requirements conflict, the user must decide, or you are not sure. A needless escalation costs a little; a wrong answer can cost a whole run.',
  'You cannot stop the run; when you think it should stop, escalate and say so in "proposal". You do not change the plan and you do not edit files.',
  'With "answer", choose one of the escalation\'s actions and write in "text" what every later step of the run reads. For a retry of a step, "text" is the instruction the step works by: concrete, within the task. Never give the step a way out ("if you cannot, report it"): steps take it at once.'
].join('\n\n')

/** Escalations of one step the Orchestrator answers in a run before the next goes to the Strategist. */
const MAX_ORCHESTRATOR_ANSWERS_PER_STEP = 3

function nullable(type: ParamDefinition['type']): Record<string, unknown> {
  if (type === 'string[]' || type === 'glob[]') return { type: ['array', 'null'], items: { type: 'string' } }
  if (type === 'number') return { type: ['number', 'null'] }
  if (type === 'boolean') return { type: ['boolean', 'null'] }
  return { type: ['string', 'null'] }
}

/** The answer's schema (strict, as Codex requires): the params are those the plan leaves open. */
export function decisionSchema(open: Record<string, ParamDefinition>): Record<string, unknown> {
  const properties = Object.fromEntries(Object.entries(open).map(([name, def]) => [name, { ...nullable(def.type), ...(def.description ? { description: def.description } : {}) }]))
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'reason', 'proposal', 'handoff', 'params'],
    properties: {
      verdict: { type: 'string', enum: ['next', 'wake'] },
      reason: { type: 'string', description: 'Why, in a sentence or two.' },
      proposal: { type: 'string', description: 'For wake: what you propose the Strategist does. Otherwise empty.' },
      handoff: { type: 'string', description: 'For next: what the next step must know from this one. Empty when nothing.' },
      params: { type: 'object', additionalProperties: false, required: Object.keys(open), properties }
    }
  }
}

/** The answer's schema for an escalation: the actions are the escalation's, without stop. */
export function escalationSchema(actions: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'action', 'text', 'reason', 'proposal'],
    properties: {
      verdict: { type: 'string', enum: ['answer', 'escalate'] },
      action: { type: ['string', 'null'], enum: [...actions, null], description: 'For answer: the action. For escalate: null.' },
      text: { type: 'string', description: 'For answer: what every later step of the run reads; for a retry, the instruction the step works by. Empty for escalate.' },
      reason: { type: 'string', description: 'Why, in a sentence or two.' },
      proposal: { type: 'string', description: 'For escalate: what you propose the Strategist answers. Otherwise empty.' }
    }
  }
}

/** The instructions every step of a task's run sees: the task as the plan describes it, and the handoff. */
export function taskInstructions(task: PlanTask, handoff: string): string[] {
  const parts = [`This run does the plan task "${task.id}": ${task.title}.`]
  if (task.spec) parts.push(`Described in ${task.spec}.`)
  if (task.acceptance?.length) parts.push(`Acceptance: ${task.acceptance.join('; ')}.`)
  return [parts.join(' '), ...(handoff.trim() ? [`From the previous step of the plan: ${handoff.trim()}`] : [])]
}

function emptyAutopilot(planId: string): AutopilotState {
  return { planId, status: 'idle', task: null, runId: null, lastCommit: null, unreviewed: 0, attention: null, pending: null, decisions: 0, lastEventId: 0, updatedAt: new Date().toISOString() }
}

export class PlanService extends EventEmitter {
  /** The Orchestrator call in progress, per project. */
  private readonly deciding = new Map<string, { cancelled: boolean; cancel(): void }>()
  /** The Orchestrator call on an escalation in progress, per project (one run, one open escalation at a time). */
  private readonly answering = new Map<string, { cancelled: boolean; cancel(): void }>()
  /** Plan steps whose pause was asked for, per project. */
  private readonly pauseAfterStep = new Set<string>()

  constructor(private readonly manager: PipelineManager, private readonly env: PlanEnvironment) {
    super()
    manager.setPlanHooks({
      checkLink: (projectPath, link) => this.checkLink(projectPath, link),
      onOutsideStart: (projectPath) => this.onOutsideStart(projectPath),
      planCommit: (projectPath, link, findings) => this.planCommit(projectPath, link, findings),
      claimEscalation: (projectPath, run, escalation) => this.claimEscalation(projectPath, run, escalation)
    })
    manager.on('event', (projectPath: string, runId: string, type: string, data: Record<string, unknown>) => {
      if (type === 'run_finished' || type === 'run_failed') this.onRunEnded(projectPath, runId, type === 'run_finished', data)
    })
    manager.on('state', (projectPath: string) => this.emit('changed', projectPath))
  }

  private store(projectPath: string): PlanStore {
    return new PlanStore(projectPath, this.env.userDir(projectPath))
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  snapshot(projectPath: string): PlanSnapshot {
    const store = this.store(projectPath)
    const activeId = store.activeId()
    const shown = activeId && store.exists(activeId) ? activeId : null
    return {
      plans: store.list(),
      activeId: shown,
      autopilot: shown ? store.readAutopilot(shown) : null,
      journal: shown ? store.readJournal(shown).slice(-JOURNAL_FOR_VIEW) : []
    }
  }

  list(projectPath: string): Array<{ id: string; title?: string; state?: string; done?: number; total?: number; active: boolean; error?: string }> {
    const store = this.store(projectPath)
    const activeId = store.activeId()
    return store.list().map((entry) => entry.plan
      ? { id: entry.id, title: entry.plan.title, state: entry.plan.state, ...planProgress(entry.plan), active: entry.id === activeId }
      : { id: entry.id, active: entry.id === activeId, error: entry.error ?? 'unreadable' })
  }

  /** The plan, or the active one. */
  private resolveId(projectPath: string, planId?: string): string {
    const id = planId ?? this.store(projectPath).activeId()
    if (!id) throw new Error('No plan is active. Call plan_list, then plan_activate, or pass planId.')
    return id
  }

  get(projectPath: string, planId?: string, taskId?: string): unknown {
    const plan = this.store(projectPath).read(this.resolveId(projectPath, planId))
    if (!taskId) return plan
    const task = plan.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Unknown task "${taskId}" in plan "${plan.id}".`)
    return task
  }

  /** Counts, the next task, what the autopilot is doing: little enough for the Strategist's context. */
  status(projectPath: string, planId?: string): Record<string, unknown> {
    const id = this.resolveId(projectPath, planId)
    const store = this.store(projectPath)
    const plan = store.read(id)
    const auto = store.readAutopilot(id)
    const run = this.manager.activeRun(projectPath)
    const liveRun = run && !run.isFinal() && run.state.planTask?.plan === id ? { runId: run.runId, task: run.state.planTask.task, status: run.state.status, step: run.state.current } : null
    return {
      id,
      title: plan.title,
      state: plan.state,
      revision: plan.revision,
      active: store.activeId() === id,
      ...planProgress(plan),
      next: nextTask(plan)?.id ?? null,
      blocked: plan.tasks.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, reason: t.reason ?? null })),
      followups: plan.followups.length,
      autopilot: auto ? { status: auto.status, task: auto.task, unreviewed: auto.unreviewed, attention: auto.attention, pendingDecision: auto.pending, ...(auto.answering ? { orchestratorAnswering: auto.answering } : {}) } : null,
      run: liveRun
    }
  }

  /**
   * One line for a wait that timed out: enough for the Strategist to see all is
   * well without looking. Null when there is nothing to report on.
   */
  tickLine(projectPath: string): string | null {
    const run = this.manager.activeRun(projectPath)
    const live = run && !run.isFinal() ? run : null
    const runPart = live ? `${live.state.planTask ? live.state.planTask.task : live.definition.id}: ${live.state.current ?? 'starting'} (${live.state.status}), ${Math.round((Date.now() - Date.parse(live.state.startedAt)) / 60_000)} min` : null
    const store = this.store(projectPath)
    const id = store.activeId()
    if (!id || !store.exists(id)) return runPart
    try {
      const plan = store.read(id)
      const { done, total } = planProgress(plan)
      const auto = store.readAutopilot(id)
      return [`Plan ${plan.id} ${done}/${total}`, runPart, auto?.status === 'deciding' ? 'Orchestrator deciding' : null, auto?.answering ? `Orchestrator answering the ${auto.answering.kind} escalation at ${auto.answering.node}` : null].filter(Boolean).join(', ')
    } catch {
      return runPart
    }
  }

  /** The transcript, input and answer of one Orchestrator call. */
  decisionRecord(projectPath: string, planId: string, decision: number): DecisionRecord {
    return this.store(projectPath).readDecisionRecord(planId, decision)
  }

  /** Every step visit of one run of a task. */
  runVisits(projectPath: string, runId: string): RunVisitInfo[] {
    return this.manager.runVisits(projectPath, runId)
  }

  /** A task's past run, for the run view. */
  runSnapshot(projectPath: string, runId: string): ReturnType<PipelineManager['runSnapshot']> {
    return this.manager.runSnapshot(projectPath, runId)
  }

  /** What views do to plans; returns a readable error instead of throwing, for showing next to the button. */
  async control(projectPath: string, action: string, options: { planId?: string; note?: string; redecide?: boolean } = {}): Promise<string | null> {
    try {
      if (action === 'run') await this.run(projectPath, options)
      else if (action === 'pause') this.pause(projectPath, options.planId)
      else if (action === 'approve') this.approve(projectPath, options.planId)
      else if (action === 'activate') this.activate(projectPath, options.planId ?? '')
      else return 'Unknown control.'
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  // ── Editing ───────────────────────────────────────────────────────────────

  create(projectPath: string, input: Record<string, unknown>): PlanFile {
    const plan = newPlan(input)
    const store = this.store(projectPath)
    if (store.exists(plan.id)) throw new Error(`Plan "${plan.id}" already exists; change it with plan_edit.`)
    store.write(plan)
    this.emit('changed', projectPath)
    return plan
  }

  /** The task a live run of this plan works on: it cannot be changed. */
  private lockedTask(projectPath: string, planId: string): string | null {
    const run = this.manager.activeRun(projectPath)
    return run && !run.isFinal() && run.state.planTask?.plan === planId ? run.state.planTask.task : null
  }

  edit(projectPath: string, planId: string | undefined, baseRevision: number, ops: PlanOp[], by: 'strategist' | 'user' = 'strategist'): { revision: number; changed: PlanTask[] } {
    const id = this.resolveId(projectPath, planId)
    const store = this.store(projectPath)
    const plan = store.read(id)
    if (baseRevision !== plan.revision) throw new Error(`The plan is at revision ${plan.revision}, not ${baseRevision}: it changed since you read it. Read it again with plan_get.`)
    const { plan: edited, changed } = applyOps(plan, ops, this.lockedTask(projectPath, id))
    edited.revision = plan.revision + 1
    store.write(edited)
    store.appendJournal(id, { kind: 'note', at: new Date().toISOString(), text: `Revision ${edited.revision} by the ${by}: ${ops.map((op) => op.op).join(', ')}` })
    this.emit('changed', projectPath)
    return { revision: edited.revision, changed: edited.tasks.filter((t) => changed.includes(t.id)) }
  }

  approve(projectPath: string, planId?: string): void {
    const id = this.resolveId(projectPath, planId)
    const store = this.store(projectPath)
    const plan = store.read(id)
    if (plan.state !== 'draft') throw new Error(`The plan is ${plan.state}, not a draft.`)
    store.write({ ...plan, state: 'approved', revision: plan.revision + 1 })
    this.emit('changed', projectPath)
  }

  activate(projectPath: string, planId: string): void {
    const store = this.store(projectPath)
    const plan = store.read(planId)
    if (plan.state !== 'approved') throw new Error(`Plan "${planId}" is ${plan.state}; only an approved plan can be active.`)
    const current = store.activeId()
    if (current && current !== planId) {
      const auto = store.readAutopilot(current)
      if (auto && (auto.status === 'deciding' || auto.status === 'running')) throw new Error(`The autopilot of plan "${current}" is working; plan_pause it first.`)
    }
    store.setActive(planId)
    this.emit('changed', projectPath)
  }

  // ── Runs linked to a task ─────────────────────────────────────────────────

  private checkLink(projectPath: string, link: PlanTaskLink): void {
    const plan = this.store(projectPath).read(link.plan)
    if (!plan.tasks.some((t) => t.id === link.task)) throw new Error(`Plan "${link.plan}" has no task "${link.task}".`)
  }

  private async planCommit(projectPath: string, link: PlanTaskLink, findings: string[]): Promise<() => void> {
    const store = this.store(projectPath)
    const before = store.read(link.plan)
    store.write(markDone(before, link.task, findings))
    await this.env.stage(projectPath, [planRelativePath(link.plan)])
    this.emit('changed', projectPath)
    return () => { store.write(before); this.emit('changed', projectPath) }
  }

  /** A run without the autopilot's knowledge: if the Orchestrator is deciding, its call is dropped and the plan holds. */
  private onOutsideStart(projectPath: string): void {
    const token = this.deciding.get(projectPath)
    if (!token) return
    token.cancel()
    this.deciding.delete(projectPath)
    const store = this.store(projectPath)
    const id = store.activeId()
    const auto = id ? store.readAutopilot(id) : null
    if (!auto) return
    this.saveAutopilot(store, { ...auto, status: 'held', attention: { kind: 'outside_run', reason: 'A run outside the plan started; plan_run continues the plan after it.', at: new Date().toISOString() } })
    this.emit('changed', projectPath)
  }

  private onRunEnded(projectPath: string, runId: string, ok: boolean, data: Record<string, unknown>): void {
    // An Orchestrator answering an escalation of this run has nothing left to answer.
    this.answering.get(projectPath)?.cancel()
    this.answering.delete(projectPath)
    const state = this.manager.runState(projectPath, runId)
    const link = state?.planTask
    if (!link) return
    const report = data.report as { nonBlockingFindings?: string[]; commits?: Array<{ sha: string }>; costUsd?: number } | undefined
    const store = this.store(projectPath)
    try {
      if (ok) {
        const plan = store.read(link.plan)
        // A machine without a commit, or whose last commit step did not run: the status stays in the working tree.
        if (plan.tasks.find((t) => t.id === link.task)?.status !== 'done') store.write(markDone(plan, link.task, report?.nonBlockingFindings ?? []))
      }
      store.appendJournal(link.plan, { kind: 'run', at: new Date().toISOString(), task: link.task, runId, result: ok ? 'success' : 'failure', commits: (report?.commits ?? []).map((c) => c.sha), costUsd: report?.costUsd ?? 0 })
    } catch { /* an unreadable plan file: the autopilot below reports it */ }
    this.emit('changed', projectPath)
    if (state?.planAuto) void this.afterStep(projectPath, link, runId, ok, typeof data.reason === 'string' ? data.reason : null)
  }

  // ── Autopilot ─────────────────────────────────────────────────────────────

  private saveAutopilot(store: PlanStore, state: AutopilotState): AutopilotState {
    const next = { ...state, updatedAt: new Date().toISOString() }
    store.writeAutopilot(next)
    return next
  }

  /** Start or continue the autopilot of the active plan. Throws when it cannot. */
  async run(projectPath: string, options: { planId?: string; note?: string; redecide?: boolean } = {}): Promise<void> {
    const id = this.resolveId(projectPath, options.planId)
    const store = this.store(projectPath)
    if (store.activeId() !== id) throw new Error(`Plan "${id}" is not active; plan_activate it first.`)
    const plan = store.read(id)
    if (plan.state !== 'approved') throw new Error(`Plan "${id}" is ${plan.state}, not approved.`)
    if (!plan.orchestrator) throw new Error(`Plan "${id}" has no orchestrator prompt; add one with plan_edit (op "set").`)
    if (this.deciding.has(projectPath)) throw new Error('The autopilot is already working: the Orchestrator is deciding.')
    const live = this.manager.activeRun(projectPath)
    if (live && !live.isFinal()) throw new Error(`Run ${live.runId} is still ${live.state.status}; the plan continues when it ends${live.state.planAuto ? '' : ' (plan_run then)'}.`)

    const auto = store.readAutopilot(id) ?? emptyAutopilot(id)
    if (options.note?.trim()) store.appendJournal(id, { kind: 'note', at: new Date().toISOString(), text: options.note.trim() })
    this.pauseAfterStep.delete(projectPath)
    // What the plan was holding for has been dealt with: a wait from an older since does not get it again.
    pipelineEvents.resolve(projectPath, (e) => e.runId === `plan:${id}` && e.type === 'plan_attention')
    // The Strategist acted: the count of tasks without it starts over.
    const pending = auto.pending
    this.saveAutopilot(store, { ...auto, unreviewed: 0, attention: null, pending: null, status: 'deciding' })
    this.emit('changed', projectPath)

    const next = nextTask(plan)
    if (pending && !options.redecide && pending.revision === plan.revision && next?.id === pending.task) {
      await this.startStep(projectPath, plan, next, pending.decision)
      return
    }
    void this.decide(projectPath, id)
  }

  /** Hold the plan: at once when the Orchestrator is deciding, after the running step otherwise. */
  pause(projectPath: string, planId?: string): 'held' | 'after_step' | 'not_running' {
    const id = this.resolveId(projectPath, planId)
    const store = this.store(projectPath)
    const auto = store.readAutopilot(id)
    if (!auto || (auto.status !== 'deciding' && auto.status !== 'running')) return 'not_running'
    const token = this.deciding.get(projectPath)
    if (token) {
      token.cancel()
      this.deciding.delete(projectPath)
      this.saveAutopilot(store, { ...auto, status: 'held', attention: { kind: 'paused', reason: 'Paused; plan_run continues.', at: new Date().toISOString() } })
      this.emit('changed', projectPath)
      return 'held'
    }
    this.pauseAfterStep.add(projectPath)
    return 'after_step'
  }

  /** The plan holds and someone must look. `silent`: whoever asked for it already knows. */
  private hold(projectPath: string, planId: string, kind: AttentionKind, reason: string, extra: { proposal?: string; task?: string; decision?: number; silent?: boolean; status?: AutopilotState['status'] } = {}): void {
    const store = this.store(projectPath)
    const auto = store.readAutopilot(planId) ?? emptyAutopilot(planId)
    const attention: PlanAttention = { kind, reason, ...(extra.proposal ? { proposal: extra.proposal } : {}), ...(extra.task ? { task: extra.task } : {}), ...(extra.decision ? { decision: extra.decision } : {}), at: new Date().toISOString() }
    const saved = this.saveAutopilot(store, { ...auto, status: extra.status ?? 'held', attention })
    store.appendJournal(planId, { kind: 'attention', at: attention.at, attention })
    if (!extra.silent) this.announce(projectPath, saved, attention)
    this.emit('changed', projectPath)
  }

  /** Send the attention as an event of the project's feed, with the report of the last run when there is one. */
  private announce(projectPath: string, auto: AutopilotState, attention: PlanAttention): void {
    const report = auto.runId ? this.manager.report(projectPath, auto.runId) : null
    const data: Record<string, unknown> = {
      plan: auto.planId,
      kind: attention.kind,
      reason: clip(attention.reason, 1200),
      ...(attention.proposal ? { proposal: clip(attention.proposal, 800) } : {}),
      ...(attention.task ? { task: attention.task } : {}),
      ...(auto.pending ? { decision: auto.pending } : {}),
      ...(report ? { report: compactReport(report) } : {}),
      summary: `plan ${auto.planId}: ${attention.kind}: ${clip(attention.reason.split('\n')[0], 160)}`
    }
    const observed = pipelineEvents.hasObserver(projectPath)
    const runId = `plan:${auto.planId}`
    const event = pipelineEvents.emit(projectPath, runId, 'plan_attention', data)
    this.saveAutopilot(this.store(projectPath), { ...auto, lastEventId: event.id })
    this.manager.emit('event', projectPath, runId, 'plan_attention', data, event.id, observed)
  }

  private async afterStep(projectPath: string, link: PlanTaskLink, runId: string, ok: boolean, reason: string | null): Promise<void> {
    const store = this.store(projectPath)
    const id = link.plan
    let auto = store.readAutopilot(id) ?? emptyAutopilot(id)
    const head = await this.env.headSha(projectPath).catch(() => null)
    auto = this.saveAutopilot(store, { ...auto, runId, task: link.task, lastCommit: head ?? auto.lastCommit, unreviewed: auto.unreviewed + 1, status: 'deciding' })
    if (!ok) { this.hold(projectPath, id, 'run_failed', `The run of task "${link.task}" failed${reason ? `: ${reason}` : '.'}`, { task: link.task }); return }

    let plan: PlanFile
    try {
      plan = store.read(id)
    } catch (err) {
      this.hold(projectPath, id, 'stuck', err instanceof Error ? err.message : String(err))
      return
    }
    const limit = plan.orchestrator?.maxUnreviewed ?? DEFAULT_MAX_UNREVIEWED
    if (this.pauseAfterStep.delete(projectPath)) { this.hold(projectPath, id, 'paused', `Paused after task "${link.task}"; plan_run continues.`, { task: link.task, silent: true }); return }
    if (plan.tasks.find((t) => t.id === link.task)?.checkpoint) { this.hold(projectPath, id, 'checkpoint', `Checkpoint: task "${link.task}" ended.`, { task: link.task }); return }
    if (auto.unreviewed >= limit && nextTask(plan)) { this.hold(projectPath, id, 'review_due', `${auto.unreviewed} tasks ended since you last acted (limit ${limit}).`, { task: link.task }); return }
    void this.decide(projectPath, id)
  }

  /** Ask the Orchestrator about the next task, or hold when the code already knows it must. */
  private async decide(projectPath: string, id: string): Promise<void> {
    const store = this.store(projectPath)
    let plan: PlanFile
    try {
      plan = store.read(id)
    } catch (err) {
      this.hold(projectPath, id, 'stuck', err instanceof Error ? err.message : String(err))
      return
    }
    const next = nextTask(plan)
    if (!next) {
      const open = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'blocked')
      if (open.length) {
        this.hold(projectPath, id, 'stuck', `No task can start: ${open.map((t) => `${t.id} (${t.status}${t.reason ? `: ${t.reason}` : ''})`).join(', ')}.`)
        return
      }
      store.write({ ...plan, state: 'done' })
      this.hold(projectPath, id, 'finished', 'Every task of the plan is done or dropped.', { status: 'finished' })
      return
    }
    if (!next.machine) { this.hold(projectPath, id, 'no_machine', `Task "${next.id}" has no machine.`, { task: next.id }); return }
    const problem = this.manager.machineProblem(projectPath, next.machine)
    if (problem) { this.hold(projectPath, id, 'no_machine', `Task "${next.id}": ${problem}`, { task: next.id }); return }
    const orchestrator = plan.orchestrator
    if (!orchestrator) { this.hold(projectPath, id, 'orchestrator_failed', 'The plan has no orchestrator prompt.'); return }

    const startedAt = new Date().toISOString()
    const decision = await this.callOrchestrator(projectPath, plan, next, orchestrator)
    if (!decision) return // cancelled
    if ('failure' in decision) { this.hold(projectPath, id, 'orchestrator_failed', decision.failure, { task: next.id, decision: decision.number }); return }

    const at = new Date().toISOString()
    store.appendJournal(id, { kind: 'decision', at, startedAt, decision: decision.number, task: next.id, verdict: decision.verdict, reason: decision.reason, ...(decision.proposal ? { proposal: decision.proposal } : {}), ...(decision.handoff ? { handoff: decision.handoff } : {}), costUsd: decision.costUsd, ...(orchestrator.shadow ? { shadow: true } : {}) })
    if (decision.verdict === 'wake') { this.hold(projectPath, id, 'wake', decision.reason, { proposal: decision.proposal, task: next.id, decision: decision.number }); return }
    if (orchestrator.shadow) {
      const auto = store.readAutopilot(id) ?? emptyAutopilot(id)
      const { costUsd: _cost, number: _number, ...plain } = decision
      this.saveAutopilot(store, { ...auto, pending: { task: next.id, decision: plain, revision: plan.revision } })
      this.hold(projectPath, id, 'shadow', `The Orchestrator would start task "${next.id}": ${decision.reason}`, { task: next.id, decision: decision.number })
      return
    }
    await this.startStep(projectPath, plan, next, decision)
  }

  private async startStep(projectPath: string, plan: PlanFile, task: PlanTask, decision: OrchestratorDecision): Promise<void> {
    const store = this.store(projectPath)
    const given = Object.fromEntries(Object.entries(decision.params).filter(([, value]) => value !== null))
    try {
      await this.manager.start(projectPath, task.machine!, { ...given, ...(task.params ?? {}) }, {
        planTask: { plan: plan.id, task: task.id },
        auto: true,
        instructions: taskInstructions(task, decision.handoff),
        onCreated: (runId) => {
          const auto = store.readAutopilot(plan.id) ?? emptyAutopilot(plan.id)
          this.saveAutopilot(store, { ...auto, status: 'running', task: task.id, runId, attention: null })
        }
      })
      this.emit('changed', projectPath)
    } catch (err) {
      this.hold(projectPath, plan.id, 'no_machine', `Task "${task.id}" could not start: ${err instanceof Error ? err.message : String(err)}`, { task: task.id })
    }
  }

  private async callOrchestrator(projectPath: string, plan: PlanFile, next: PlanTask, config: PlanOrchestrator): Promise<(OrchestratorDecision & { costUsd: number | null; number: number }) | { failure: string; number: number } | null> {
    const store = this.store(projectPath)
    const auto = this.saveAutopilot(store, { ...(store.readAutopilot(plan.id) ?? emptyAutopilot(plan.id)), status: 'deciding' })
    const number = this.nextDecisionNumber(store, plan.id)
    const entry = this.manager.machineEntry(projectPath, next.machine!)
    const fixed = new Set(Object.keys(next.params ?? {}))
    const open = Object.fromEntries(Object.entries(entry?.machine.params ?? {}).filter(([name]) => !fixed.has(name)))
    const schema = decisionSchema(open)
    const systemAppend = [ORCHESTRATOR_ROLE, '## This plan\'s instructions', config.prompt.trim(), '## Output', outputContract('orchestratorDecision', schema)].join('\n\n')
    const prompt = await this.orchestratorPrompt(projectPath, plan, next, auto, entry?.machine.description ?? '')
    const result = await this.consult(projectPath, plan.id, number, config, this.deciding, { prompt, systemAppend, schema, errors: (value) => this.decisionErrors(value, schema, entry?.machine.params, next) })
    if (!result) return null
    if ('failure' in result) return { number, failure: result.failure }
    return { ...(result.structured as OrchestratorDecision), costUsd: result.costUsd, number }
  }

  /** Numbers Orchestrator calls of a plan, between tasks and on escalations alike. */
  private nextDecisionNumber(store: PlanStore, planId: string): number {
    const auto = store.readAutopilot(planId) ?? emptyAutopilot(planId)
    return this.saveAutopilot(store, { ...auto, decisions: auto.decisions + 1 }).decisions
  }

  /**
   * One Orchestrator call: a fresh read-only session, one retry in the same session
   * when the answer does not validate. Null when it was cancelled; `slot` holds its
   * cancel token while it runs.
   */
  private async consult(projectPath: string, planId: string, number: number, config: PlanOrchestrator, slot: Map<string, { cancelled: boolean; cancel(): void }>,
    call: { prompt: string; systemAppend: string; schema: Record<string, unknown>; errors(value: unknown): string[] }): Promise<{ structured: unknown; costUsd: number | null } | { failure: string } | null> {
    const store = this.store(projectPath)
    const { prompt, systemAppend, schema } = call
    const runDir = store.decisionDir(planId, number)
    const plan = { id: planId }
    const start = (text: string, resumeSessionId?: string): ReturnType<PipelineManager['startAgent']> => {
      store.appendDecisionInput(plan.id, number, { at: new Date().toISOString(), kind: resumeSessionId ? 'retry' : 'task', cli: config.cli, model: config.model ?? null, effort: config.effort ?? null, permissions: 'read-only', resumeSessionId: resumeSessionId ?? null, prompt: text, systemAppend })
      return this.manager.startAgent(projectPath, {
        cli: config.cli,
        cwd: projectPath,
        runDir,
        prompt: text,
        systemAppend,
        permissions: 'read-only',
        outputSchema: schema,
        model: config.model,
        effort: config.effort,
        resumeSessionId,
        timeoutMs: ORCHESTRATOR_TIMEOUT_MS,
        label: `${config.cli}:plan-orchestrator`,
        onEntry: (e) => {
          store.appendDecisionTranscript(plan.id, number, e)
          this.emit('decision-entry', projectPath, plan.id, number, e)
        }
      })
    }

    let handle = start(prompt)
    const token = { cancelled: false, cancel: (): void => { token.cancelled = true; void handle.cancel() } }
    slot.set(projectPath, token)
    this.emit('changed', projectPath)
    try {
      let result = await handle.result
      if (token.cancelled) return null
      if (!result.ok) return { failure: `The Orchestrator failed (${result.error?.code}): ${result.error?.message}` }
      let errors = call.errors(result.structured)
      if (errors.length && result.sessionId) {
        handle = start(invalidOutputPrompt(errors), result.sessionId)
        const retried = await handle.result
        if (token.cancelled) return null
        if (!retried.ok) return { failure: `The Orchestrator failed (${retried.error?.code}): ${retried.error?.message}` }
        result = { ...retried, costUsd: (retried.costUsd ?? 0) + (result.costUsd ?? 0) }
        errors = call.errors(result.structured)
      }
      if (errors.length) return { failure: `The Orchestrator's answer is unusable: ${errors.join('; ')}` }
      store.writeDecision(plan.id, number, result.structured)
      return { structured: result.structured, costUsd: result.costUsd }
    } finally {
      if (slot.get(projectPath) === token) slot.delete(projectPath)
      this.emit('changed', projectPath)
    }
  }

  private decisionErrors(value: unknown, schema: Record<string, unknown>, params: Record<string, ParamDefinition> | undefined, next: PlanTask): string[] {
    const errors = validateAgainstSchema(value, schema)
    if (errors.length) return errors
    const decision = value as OrchestratorDecision
    if (decision.verdict !== 'next') return []
    const given = Object.fromEntries(Object.entries(decision.params).filter(([, v]) => v !== null))
    return validateParams(params, { ...given, ...(next.params ?? {}) })
  }

  private async orchestratorPrompt(projectPath: string, plan: PlanFile, next: PlanTask, auto: AutopilotState, machineDescription: string): Promise<string> {
    const store = this.store(projectPath)
    const report = auto.runId ? this.manager.report(projectPath, auto.runId) : null
    const outside = auto.lastCommit ? await this.env.commitsSince(projectPath, auto.lastCommit) : []
    const journal = store.readJournal(plan.id).filter((e) => e.kind !== 'attention').slice(-JOURNAL_FOR_PROMPT).map(journalLine)
    const nextText = [`${next.id}: ${next.title}`, next.spec ? `Spec: ${next.spec}` : '', next.acceptance?.length ? `Acceptance: ${next.acceptance.join('; ')}` : '', `Machine: ${next.machine} — ${machineDescription}`, next.params ? `Params the plan fixes: ${JSON.stringify(next.params)}` : ''].filter(Boolean).join('\n')
    return [
      planHeading(plan),
      `## Tasks\n\n${planDetail(plan, next.id)}`,
      `## Next task\n\n${nextText}`,
      report ? `## Report of the last step\n\n${clip(JSON.stringify(compactReport(report)), REPORT_CHARS)}` : '## Report of the last step\n\nNo step has run yet: the Strategist has just started this plan, so there is no result to check. Instructions about the last step do not apply to this call; decide whether the first task can start, and fill its params.',
      outside.length ? `## Commits made outside the plan since the last step\n\n${outside.join('\n')}` : '',
      journal.length ? `## Journal\n\n${journal.join('\n')}` : ''
    ].filter(Boolean).join('\n\n')
  }

  // ── Escalations inside a plan step ────────────────────────────────────────

  /**
   * Whether the plan's Orchestrator takes an escalation that is being announced:
   * a run the autopilot started, for the agents, of a kind the plan lets it
   * answer, that it has not passed on already. It then answers it or passes it on.
   */
  private claimEscalation(projectPath: string, run: RunState, escalation: Escalation): boolean {
    const link = run.planTask
    if (!run.planAuto || !link || escalation.to !== 'agent') return false
    if (escalation.orchestrator && escalation.orchestrator.status !== 'deciding') return false
    let config: PlanOrchestrator | undefined
    try { config = this.store(projectPath).read(link.plan).orchestrator } catch { return false }
    if (!config?.escalations?.includes(escalation.kind)) return false
    const answered = run.escalations.filter((e) => e.node === escalation.node && e.answer?.by === 'orchestrator').length
    if (answered >= MAX_ORCHESTRATOR_ANSWERS_PER_STEP) {
      // A step that keeps coming back needs more than another answer of the same kind.
      this.manager.setOrchestratorHandling(projectPath, run.runId, escalation.id, { status: 'escalated', reason: `The Orchestrator answered ${answered} escalations of "${escalation.node}" in this run already; AIDE passes this one on.` })
      return false
    }
    if (this.answering.has(projectPath)) return true
    void this.answerEscalation(projectPath, run.runId, link, escalation.id, config)
    return true
  }

  private async answerEscalation(projectPath: string, runId: string, link: PlanTaskLink, escalationId: string, config: PlanOrchestrator): Promise<void> {
    const store = this.store(projectPath)
    const escalation = this.manager.openEscalation(projectPath, runId, escalationId)
    if (!escalation) return
    // Nothing below awaits before consult() takes its slot in `answering`, so a second
    // announcement of the same escalation finds the call in progress.
    const forward = (handling: OrchestratorHandling, summary: string): void => {
      this.manager.setOrchestratorHandling(projectPath, runId, escalationId, handling)
      this.manager.forwardEscalation(projectPath, runId, escalationId, summary)
    }
    let number: number | null = null
    try {
      const plan = store.read(link.plan)
      const task = plan.tasks.find((t) => t.id === link.task)
      if (!task) throw new Error(`Plan "${plan.id}" has no task "${link.task}" any more.`)
      number = this.nextDecisionNumber(store, plan.id)
      this.manager.setOrchestratorHandling(projectPath, runId, escalationId, { status: 'deciding', decision: number })
      this.saveAutopilot(store, { ...(store.readAutopilot(plan.id) ?? emptyAutopilot(plan.id)), answering: { decision: number, node: escalation.node, kind: escalation.kind } })
      const actions = (compactEscalation(escalation).actions as string[]).filter((a) => a !== 'stop')
      const schema = escalationSchema(actions)
      const systemAppend = [ESCALATION_ROLE, '## This plan\'s instructions', config.prompt.trim(), '## Output', outputContract('escalationDecision', schema)].join('\n\n')
      const prompt = this.escalationPrompt(projectPath, plan, task, runId, escalation, actions)
      const startedAt = new Date().toISOString()
      const result = await this.consult(projectPath, plan.id, number, config, this.answering, { prompt, systemAppend, schema, errors: (value) => escalationErrors(value, schema) })
      if (!result) return // the run ended, or AIDE is closing: a restart announces the escalation again
      if (!this.manager.openEscalation(projectPath, runId, escalationId)) {
        store.appendJournal(plan.id, { kind: 'note', at: new Date().toISOString(), text: `The ${escalation.kind} escalation at ${escalation.node} was answered by someone else while the Orchestrator decided (call ${number}).` })
        return
      }
      if ('failure' in result) {
        forward({ status: 'failed', decision: number, reason: result.failure }, `${escalation.kind} escalation at ${escalation.node}: the Orchestrator could not answer it (${clip(result.failure, 120)})`)
        return
      }
      const decision = result.structured as EscalationDecision
      const shadow = decision.verdict === 'answer' && !!config.shadow
      store.appendJournal(plan.id, {
        kind: 'decision', at: new Date().toISOString(), startedAt, decision: number, task: task.id, verdict: decision.verdict, reason: decision.reason,
        ...(decision.proposal ? { proposal: decision.proposal } : {}), costUsd: result.costUsd, ...(shadow ? { shadow: true } : {}),
        escalation: { runId, id: escalationId, kind: escalation.kind, node: escalation.node, ...(decision.action ? { action: decision.action } : {}), ...(decision.text ? { text: decision.text } : {}) }
      })
      this.emit('changed', projectPath)
      if (decision.verdict === 'escalate') {
        forward({ status: 'escalated', decision: number, reason: decision.reason, ...(decision.proposal ? { proposal: decision.proposal } : {}) }, `${escalation.kind} escalation at ${escalation.node}, passed on by the Orchestrator: ${clip(decision.reason, 160)}`)
        return
      }
      const answer = { action: decision.action!, text: decision.text }
      if (shadow) {
        forward({ status: 'shadow', decision: number, reason: decision.reason, answer }, `${escalation.kind} escalation at ${escalation.node}; the Orchestrator would answer ${answer.action} (shadow mode)`)
        return
      }
      this.manager.setOrchestratorHandling(projectPath, runId, escalationId, { status: 'answered', decision: number, reason: decision.reason, answer })
      try {
        await this.manager.answer(projectPath, escalationId, { ...answer, by: 'orchestrator' }, runId)
      } catch (err) {
        // Answered meanwhile, or the answer does not fit: the Strategist decides.
        if (this.manager.openEscalation(projectPath, runId, escalationId)) forward({ status: 'failed', decision: number, reason: err instanceof Error ? err.message : String(err) }, `${escalation.kind} escalation at ${escalation.node}: the Orchestrator's answer was refused`)
      }
    } catch (err) {
      if (this.manager.openEscalation(projectPath, runId, escalationId)) forward({ status: 'failed', ...(number !== null ? { decision: number } : {}), reason: err instanceof Error ? err.message : String(err) }, `${escalation.kind} escalation at ${escalation.node}: the Orchestrator could not answer it`)
    } finally {
      const auto = store.readAutopilot(link.plan)
      if (auto?.answering) this.saveAutopilot(store, { ...auto, answering: null })
      this.emit('changed', projectPath)
    }
  }

  private escalationPrompt(projectPath: string, plan: PlanFile, task: PlanTask, runId: string, escalation: Escalation, actions: string[]): string {
    const store = this.store(projectPath)
    const report = this.manager.report(projectPath, runId)
    const state = this.manager.runState(projectPath, runId)
    const machine = state ? this.manager.machineEntry(projectPath, state.machineId)?.machine : undefined
    const earlier = (state?.escalations ?? []).filter((e) => e.id !== escalation.id).map((e) => `- ${e.kind} at ${e.node}: ${clip(e.message.split('\n')[0], 200)} → ${e.answer ? `${e.answer.action} by the ${e.answer.by}${e.answer.text ? `: ${clip(e.answer.text, 300)}` : ''}` : 'open'}`)
    const source = escalation.source ? this.manager.output(projectPath, escalation.source.step, escalation.source.visit, runId) : null
    const journal = store.readJournal(plan.id).filter((e) => e.kind !== 'attention').slice(-JOURNAL_FOR_PROMPT).map(journalLine)
    const taskText = [`${task.id}: ${task.title}`, task.spec ? `Spec: ${task.spec}` : '', task.acceptance?.length ? `Acceptance: ${task.acceptance.join('; ')}` : '', machine ? `Machine: ${machine.id} — ${machine.description}` : ''].filter(Boolean).join('\n')
    return [
      planHeading(plan),
      `## Tasks\n\n${planDetail(plan, null)}`,
      `## The task this run does\n\n${taskText}`,
      report ? `## The run so far\n\n${clip(JSON.stringify(compactReport(report)), REPORT_CHARS)}` : '',
      earlier.length ? `## Earlier decisions in this run\n\n${earlier.join('\n')}` : '',
      `## The escalation\n\nKind: ${escalation.kind}, at "${escalation.node}". Actions you can choose: ${actions.join(', ')}.\n\n${clip(escalation.message, ESCALATION_MESSAGE_CHARS)}`,
      source ? `## Output of "${source.step}" (visit ${source.visit}), which raised it\n\n${clip(typeof source.output === 'string' ? source.output : JSON.stringify(source.output, null, 2), SOURCE_OUTPUT_CHARS)}` : '',
      journal.length ? `## Journal\n\n${journal.join('\n')}` : ''
    ].filter(Boolean).join('\n\n')
  }

  // ── Project lifecycle ─────────────────────────────────────────────────────

  /** After the project opens (and runs were recovered): pick up where the autopilot was. */
  recover(projectPath: string): void {
    const store = this.store(projectPath)
    const id = store.activeId()
    const auto = id ? store.readAutopilot(id) : null
    if (!id || !auto) return
    if (auto.lastEventId) pipelineEvents.seed(projectPath, auto.lastEventId + 1)
    if (auto.status === 'deciding') { void this.decide(projectPath, id); return }
    if (auto.status === 'held' && auto.attention && auto.attention.kind !== 'paused' && auto.attention.kind !== 'outside_run') {
      this.announce(projectPath, auto, { ...auto.attention, reason: `AIDE restarted; still waiting: ${auto.attention.reason}` })
      return
    }
    if (auto.status === 'running' && auto.runId && auto.task) {
      const run = this.manager.runState(projectPath, auto.runId)
      // It ended while nobody was listening.
      if (run && (run.status === 'finished' || run.status === 'failed')) void this.afterStep(projectPath, { plan: id, task: auto.task }, auto.runId, run.status === 'finished', null)
    }
  }

  /** The project closes or AIDE quits: the call in progress dies, and the autopilot asks again next time. */
  forget(projectPath: string): void {
    this.deciding.get(projectPath)?.cancel()
    this.deciding.delete(projectPath)
    // An answer to an escalation in progress dies too; the escalation is announced again when the run is recovered.
    this.answering.get(projectPath)?.cancel()
    this.answering.delete(projectPath)
    this.pauseAfterStep.delete(projectPath)
  }

  prepareShutdown(): void {
    for (const projectPath of new Set([...this.deciding.keys(), ...this.answering.keys()])) this.forget(projectPath)
  }
}

/** The plan's title, goal and the document of its intent: the big picture of every Orchestrator call. */
function planHeading(plan: PlanFile): string {
  return [`# Plan: ${plan.title}`, plan.goal ? `Goal: ${plan.goal}` : '', plan.spec ? `The intent of the whole plan is described in ${plan.spec}; read it when the decision depends on where the plan is going.` : ''].filter(Boolean).join('\n\n')
}

/** What is wrong with an answer to an escalation beyond its schema. */
function escalationErrors(value: unknown, schema: Record<string, unknown>): string[] {
  const errors = validateAgainstSchema(value, schema)
  if (errors.length) return errors
  const decision = value as EscalationDecision
  if (decision.verdict === 'answer' && !decision.action) return ['"action" is required with verdict "answer".']
  return []
}

function journalLine(entry: JournalEntry): string {
  switch (entry.kind) {
    case 'decision':
      if (entry.escalation) return `${entry.at} answer to the ${entry.escalation.kind} escalation at ${entry.escalation.node} in ${entry.task}: ${entry.verdict}${entry.escalation.action ? ` ${entry.escalation.action}` : ''}${entry.shadow ? ' (shadow)' : ''} — ${clip(entry.reason, 200)}`
      return `${entry.at} decision on ${entry.task}: ${entry.verdict} — ${clip(entry.reason, 200)}${entry.handoff ? ` Handoff: ${clip(entry.handoff, 200)}` : ''}`
    case 'run': return `${entry.at} run of ${entry.task}: ${entry.result}${entry.commits.length ? ` (${entry.commits.map((c) => c.slice(0, 8)).join(', ')})` : ''}`
    case 'note': return `${entry.at} note: ${clip(entry.text, 400)}`
    case 'attention': return `${entry.at} attention: ${entry.attention.kind}`
  }
}
