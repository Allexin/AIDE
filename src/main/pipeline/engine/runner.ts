import { randomUUID } from 'crypto'
import type { HistoryEntry } from '../../pty/cliTools/types'
import type { HeadlessRun, HeadlessRunOptions } from '../headless/types'
import type { ProcessHandle } from '../processRunner'
import type { CommitResult, FileChange } from '../git'
import { checkCommitCoverage } from '../git'
import { clip, type PipelineEventType } from '../events'
import type { AgentStep, CheckStep, CommitStep, Escalation, EscalationAnswer, LoopFeedback, MachineDefinition, NodeVisit, Outcome, RunState } from './types'
import { evaluateCondition, stringifyValue, templateRefs, type Scope } from './expressions'
import { resolveSchema, validateAgainstSchema, BUILTIN_SCHEMAS } from './schema'
import { DEFAULT_TIMEOUT_MIN, buildPipelineContext, buildSystemAppend, buildTaskPrompt, describeCondition, feedbackSections, invalidOutputPrompt, outputContract, stepSummary, stepSwitchPrompt } from './context'
import { MachineTree, blockLimit, type DescendContext, type TreeBlock, type TreeLeaf } from './tree'
import type { RunStore, StoredMachine } from './runStore'
import { compactReport } from './reportView'

/**
 * Deterministic executor of one pipeline run (plan §1, §3, §4).
 *
 * The run walks the machine's step tree top to bottom. A step inside a loop can
 * send control back to the start of an enclosing loop (a failed check, a
 * rejected gate, a `repeatIf`, commit review problems); the loop then starts its
 * next iteration with that feedback, up to its limit. Agent failures (crash,
 * limit, timeout, unusable output) are not part of the flow: they raise an engine
 * escalation that the orchestrator or the user answers with retry or stop.
 */

export interface AgentRequest extends Omit<HeadlessRunOptions, 'env'> {
  cli: string
}

export interface EngineDeps {
  startAgent(request: AgentRequest): HeadlessRun
  runCheck(options: { commandLine: string; cwd: string; timeoutMs: number; label: string; onOutput(text: string): void }): ProcessHandle
  git: {
    workingDiff(cwd: string): Promise<string>
    stagedDiff(cwd: string): Promise<string>
    status(cwd: string): Promise<FileChange[]>
    headSha(cwd: string): Promise<string | null>
    commitIndex(cwd: string, message: string): Promise<CommitResult>
  }
  readRole(machineDir: string, rolePath: string): string
  /** Pipeline event for the orchestrator feed and the UI. */
  emit(runId: string, type: PipelineEventType, data: Record<string, unknown>): void
  onStateChange?(state: RunState): void
  onTranscript?(runId: string, node: string, visit: number, entry: HistoryEntry): void
}

const CHECK_OUTPUT_TAIL = 8000

type NodeResult =
  | { kind: 'done'; outcome: Outcome; output: unknown; sessionId?: string | null; costUsd?: number | null }
  | { kind: 'escalate'; message: string }
  | { kind: 'interrupted' }

export interface RunReport {
  runId: string
  machine: { id: string; name: string }
  params: Record<string, unknown>
  result: 'success' | 'failure' | 'stopped'
  startedAt: string
  finishedAt: string
  startCommit: string | null
  /** Final iteration of every loop / commit block entered. */
  loops: Record<string, number>
  visits: Array<{ node: string; visit: number; outcome: string | null; durationMs: number | null; costUsd: number | null; error: string | null }>
  commits: CommitResult[]
  summaries: Array<{ node: string; summary: string }>
  nonBlockingFindings: string[]
  escalations: Escalation[]
  costUsd: number
}

const ESCALATION_ACTIONS: Record<Escalation['kind'], string[]> = {
  step: ['continue', 'retry', 'stop'],
  gate: ['continue', 'reject', 'stop'],
  limit: ['retry', 'continue', 'stop'],
  engine: ['retry', 'stop']
}

/** What the orchestrator gets about an escalation: the decision to make, not the whole log. */
export function compactEscalation(e: Escalation): Record<string, unknown> {
  return {
    escalationId: e.id,
    node: e.node,
    kind: e.kind,
    to: e.to,
    message: clip(e.message, 1200),
    actions: ESCALATION_ACTIONS[e.kind],
    ...(e.source ? { source: e.source, more: `pipeline_output step "${e.source.step}" visit ${e.source.visit}` } : {}),
    summary: `${e.kind} escalation at ${e.node}: ${clip(e.message.split('\n')[0], 160)}`
  }
}

export class PipelineRun {
  private readonly machine: MachineDefinition
  private readonly machineDir: string
  private readonly tree: MachineTree
  private active: { cancel(): Promise<void> } | null = null
  private loop: Promise<void> | null = null
  private interruptRequested = false
  private readonly commits: CommitResult[] = []

  constructor(
    stored: StoredMachine,
    private readonly params: Record<string, unknown>,
    readonly state: RunState,
    private readonly store: RunStore,
    private readonly deps: EngineDeps
  ) {
    this.machine = stored.machine
    this.machineDir = stored.machineDir
    this.tree = new MachineTree(stored.machine)
    state.iterations ??= {}
    state.bonus ??= {}
    state.feedback ??= {}
  }

  static create(stored: StoredMachine, params: Record<string, unknown>, runId: string, projectPath: string, store: RunStore, deps: EngineDeps): PipelineRun {
    const now = new Date().toISOString()
    const state: RunState = {
      runId,
      machineId: stored.machine.id,
      projectPath,
      status: 'paused',
      current: null,
      visits: {},
      iterations: {},
      bonus: {},
      feedback: {},
      outputs: {},
      history: [],
      escalations: [],
      sessions: {},
      startCommit: null,
      result: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null
    }
    const run = new PipelineRun(stored, params, state, store, deps)
    state.current = run.tree.first(run.descendContext())
    store.create(state, stored, params)
    return run
  }

  get runId(): string { return this.state.runId }

  get definition(): MachineDefinition { return this.machine }

  isActive(): boolean {
    return this.state.status === 'running' || this.state.status === 'pausing' || this.state.status === 'paused' || this.state.status === 'waiting' || this.state.status === 'stopped'
  }

  isFinal(): boolean {
    return this.state.status === 'finished' || this.state.status === 'failed'
  }

  /** Start (or continue after pause/stop) executing. Resolves when the loop yields. */
  async run(): Promise<void> {
    if (this.loop) return this.loop
    if (this.isFinal() || this.state.status === 'waiting') return
    if (this.state.startCommit === null && this.state.history.length === 0) {
      this.state.startCommit = await this.deps.git.headSha(this.state.projectPath).catch(() => null)
    }
    this.setStatus('running')
    this.loop = this.execute().finally(() => { this.loop = null })
    return this.loop
  }

  /** Finish the current step, then stop before the next one. */
  pause(): void {
    if (this.state.status === 'running') this.setStatus('pausing')
  }

  /** Interrupt the current step now; the run can be resumed later from that step. */
  async stop(): Promise<void> {
    if (this.state.status === 'running' || this.state.status === 'pausing') {
      this.interruptRequested = true
      await this.active?.cancel()
      await this.loop
    } else if (this.state.status === 'paused' || this.state.status === 'waiting') {
      this.setStatus('stopped')
      this.deps.emit(this.runId, 'run_stopped', { node: this.state.current, summary: 'run stopped; resume with pipeline_resume' })
    }
  }

  /** AIDE is quitting and kills the running process: treat its result as an interruption, not a failure. */
  markInterrupting(): void {
    if (this.state.status === 'running' || this.state.status === 'pausing') this.interruptRequested = true
  }

  /** End the run for good (after stop or an escalation answered with stop). */
  abandon(reason: string): void {
    if (this.isFinal()) return
    this.finish('failure', `abandoned: ${reason}`)
  }

  pendingEscalation(): Escalation | null {
    return this.state.escalations.find((e) => e.answer === null) ?? null
  }

  async answer(escalationId: string, answer: Omit<EscalationAnswer, 'at'>): Promise<string | null> {
    const escalation = this.state.escalations.find((e) => e.id === escalationId)
    if (!escalation) return `Unknown escalation ${escalationId}.`
    if (escalation.answer) return `Escalation ${escalationId} was already answered.`
    escalation.answer = { ...answer, at: new Date().toISOString() }
    const node = escalation.node
    if (answer.action === 'stop') {
      this.save()
      this.finish('failure', `stopped at escalation: ${answer.text}`)
      return null
    }
    const leaf = this.tree.leaf(node)
    switch (escalation.kind) {
      case 'engine':
        // retry (continue is treated the same): run the failed step again.
        this.state.current = node
        break
      case 'step':
        if (answer.action === 'retry' || !leaf) this.state.current = node
        else this.state.current = this.tree.next(leaf, this.descendContext())
        break
      case 'gate': {
        const approved = answer.action !== 'reject'
        this.state.outputs[node] = { approved, answer: answer.text, by: answer.by }
        this.store.writeOutput(this.runId, node, this.state.visits[node] ?? 1, this.state.outputs[node])
        const visit = [...this.state.history].reverse().find((h) => h.node === node)
        if (visit && !visit.finishedAt) { visit.outcome = approved ? 'ok' : 'fail'; visit.finishedAt = new Date().toISOString() }
        if (!leaf) break
        if (approved) { this.state.current = this.tree.next(leaf, this.descendContext()); break }
        const target = this.repeatTarget(leaf, leaf.step.type === 'gate' ? leaf.step.repeatLoop : undefined)
        if (!target) { this.finish('failure', `the gate "${node}" was rejected: ${answer.text}`); return null }
        this.repeat(target, { from: node, reason: `the gate "${node}" was rejected by the ${answer.by}`, details: answer.text })
        break
      }
      case 'limit': {
        const block = this.tree.blocks.get(node)
        if (!block) break
        if (answer.action === 'retry') {
          this.state.bonus[node] = (this.state.bonus[node] ?? 0) + 1
          this.repeat(block, this.state.feedback[node] ?? { from: node, reason: `the ${answer.by} asked for another iteration`, details: answer.text })
        } else {
          this.state.current = this.tree.next(block, this.descendContext())
        }
        break
      }
    }
    // A repeat may have hit a loop limit and raised a new escalation.
    if (this.isFinal() || this.pendingEscalation()) return null
    if (this.state.current === null) { this.finish('success', null); return null }
    this.setStatus('paused')
    void this.run()
    return null
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  private async execute(): Promise<void> {
    while (this.state.status === 'running' || this.state.status === 'pausing') {
      const id = this.state.current
      if (!id) { this.finish('success', null); return }
      const leaf = this.tree.leaf(id)
      if (!leaf) { this.finish('failure', `unknown step "${id}"`); return }
      const step = leaf.step
      const visits = (this.state.visits[id] ?? 0) + 1
      this.state.visits[id] = visits

      if (step.type === 'gate') {
        this.recordVisit(id, visits, null)
        this.raise({ node: id, kind: 'gate', to: step.to ?? 'orchestrator', message: step.question })
        return
      }
      if (step.type === 'repeat') {
        // The feedback is the output of the step that ran before (usually the one the `if` tested).
        const previous = [...this.state.history].reverse().find((h) => h.finishedAt && h.node !== id)
        this.recordVisit(id, visits, 'ok')
        const target = this.tree.blocks.get(step.loop)
        if (!target) { this.finish('failure', `repeat step "${id}" names no loop "${step.loop}"`); return }
        this.repeat(target, { from: id, reason: step.reason ?? `step "${id}" started "${step.loop}" over`, details: previous ? stringifyValue(this.state.outputs[previous.node]) : '' })
        if (this.state.status !== 'running' && this.state.status !== 'pausing') return
        this.save()
        continue
      }

      const visit: NodeVisit = { node: id, visit: visits, outcome: null, startedAt: new Date().toISOString(), finishedAt: null, sessionId: null, costUsd: null, error: null }
      this.state.history.push(visit)
      this.save()
      this.deps.emit(this.runId, 'node_started', { node: id, visit: visits, type: step.type, summary: `${id} started (visit ${visits})` })

      let result: NodeResult
      try {
        result = step.type === 'agent' ? await this.runAgent(id, step, visit)
          : step.type === 'check' ? await this.runCheck(id, step, visit)
            : await this.runCommit(id, step, visit)
      } catch (err) {
        result = { kind: 'escalate', message: err instanceof Error ? err.message : String(err) }
      }
      this.active = null

      visit.finishedAt = new Date().toISOString()
      if (result.kind === 'interrupted' || this.interruptRequested) {
        this.interruptRequested = false
        visit.outcome = 'interrupted'
        this.state.visits[id] = visits - 1 // an interrupted visit does not count
        this.setStatus('stopped')
        this.deps.emit(this.runId, 'run_stopped', { node: id, visit: visits, summary: `run stopped during ${id}; resume with pipeline_resume` })
        return
      }
      if (result.kind === 'escalate') {
        visit.error = result.message
        this.raiseEngineEscalation(id, result.message, true)
        return
      }

      visit.outcome = result.outcome
      if (result.sessionId) { visit.sessionId = result.sessionId; this.state.sessions[id] = result.sessionId }
      if (result.costUsd !== undefined) visit.costUsd = result.costUsd ?? null
      this.state.outputs[id] = result.output
      this.store.writeOutput(this.runId, id, visits, result.output)
      this.deps.emit(this.runId, 'node_finished', { node: id, visit: visits, outcome: result.outcome, summary: `${id} finished: ${result.outcome}` })
      if (step.type === 'check' && result.outcome === 'fail') this.deps.emit(this.runId, 'check_failed', { node: id, visit: visits, summary: `check ${id} failed (visit ${visits})` })

      this.afterLeaf(leaf, result.outcome, result.output)
      if (this.state.status !== 'running' && this.state.status !== 'pausing') return
      if (this.state.current === null) { this.finish('success', null); return }
      this.save()
      if (this.state.status === 'pausing') {
        this.setStatus('paused')
        this.deps.emit(this.runId, 'run_paused', { next: this.state.current, summary: `run paused before ${this.state.current}; resume with pipeline_resume` })
        return
      }
    }
  }

  /** Where control goes after a leaf completed: an escalation, a loop repeat, or the next step. */
  private afterLeaf(leaf: TreeLeaf, outcome: Outcome, output: unknown): void {
    const step = leaf.step
    const id = leaf.id
    if (step.type === 'agent') {
      if (step.escalateIf && evaluateCondition(step.escalateIf, this.scope({}))) {
        const summary = (output as { summary?: unknown } | null)?.summary
        const message = (step.escalateMessage ?? `Step "${id}" asks for a decision (${describeCondition(step.escalateIf)}).`) + (typeof summary === 'string' && summary ? `\n\n${summary}` : '')
        this.raise({ node: id, kind: 'step', to: step.escalateTo ?? 'orchestrator', message: `${message}\n\nContinue goes on with the next step; retry runs "${id}" again.`, source: { step: id, visit: this.state.visits[id] ?? 1 } })
        return
      }
      if (step.repeatIf && evaluateCondition(step.repeatIf, this.scope({}))) {
        const target = this.repeatTarget(leaf, step.repeatLoop)
        if (target) { this.repeat(target, { from: id, reason: `step "${id}" reported that ${describeCondition(step.repeatIf)}`, details: stringifyValue(output) }); return }
      }
    }
    if (step.type === 'check' && outcome === 'fail') {
      const tail = (output as { output?: string }).output ?? ''
      const target = this.repeatTarget(leaf, step.repeatLoop)
      if (target) this.repeat(target, { from: id, reason: `the check "${id}" (\`${step.command}\`) failed`, details: tail })
      else this.raise({ node: id, kind: 'step', to: 'orchestrator', message: `Check "${id}" (\`${step.command}\`) failed outside any loop. Continue ignores the failure; retry runs the check again.\n\n${tail.slice(-2000)}`, source: { step: id, visit: this.state.visits[id] ?? 1 } })
      return
    }
    if (step.type === 'commit' && outcome === 'fail') {
      const issues = ((output as { issues?: string[] }).issues ?? []).map((issue) => `- ${issue}`).join('\n')
      this.repeat(leaf.parent, { from: id, reason: 'the commit review found problems with the prepared commit', details: issues })
      return
    }
    this.state.current = this.tree.next(leaf, this.descendContext())
  }

  private repeatTarget(leaf: TreeLeaf, loopId: string | undefined): TreeBlock | null {
    if (loopId) return this.tree.blocks.get(loopId) ?? null
    return this.tree.repeatable(leaf)[0] ?? null
  }

  /** Start the next iteration of a loop/commit block, or handle its limit. */
  private repeat(block: TreeBlock, feedback: Omit<LoopFeedback, 'iteration'>): void {
    const next = (this.state.iterations[block.id] ?? 1) + 1
    const limit = blockLimit(block) + (this.state.bonus[block.id] ?? 0)
    this.state.feedback[block.id] = { ...feedback, iteration: next }
    const unit = block.kind === 'commit' ? 'attempt' : 'iteration'
    if (next > limit) {
      const onLimit = block.step?.type === 'loop' || block.step?.type === 'commit' ? block.step.onLimit ?? 'escalate' : 'escalate'
      const message = `${block.kind === 'commit' ? 'Commit' : 'Loop'} "${block.id}" did not pass in ${limit} ${unit}${limit === 1 ? '' : 's'}. The last pass was repeated because ${feedback.reason}.`
      if (onLimit === 'fail') { this.finish('failure', message); return }
      const what = block.kind === 'commit' ? 'commit step' : 'loop'
      const source = this.state.visits[feedback.from] ? { step: feedback.from, visit: this.state.visits[feedback.from] } : undefined
      this.raise({ node: block.id, kind: 'limit', to: 'orchestrator', message: `${message}\n\n${feedback.details.slice(-3000)}\n\nRetry grants one more ${unit}; continue leaves the ${what} as if it passed.`, source })
      return
    }
    this.state.iterations[block.id] = next
    this.clearNested(block)
    this.state.current = this.tree.restart(block, this.descendContext())
    this.deps.emit(this.runId, 'loop_repeated', { loop: block.id, iteration: next, from: feedback.from, summary: `${block.id} → ${unit} ${next}: ${clip(feedback.reason, 200)}` })
  }

  /** Nested loops start from scratch whenever an outer loop starts an iteration. */
  private clearNested(block: TreeBlock): void {
    for (const nested of this.tree.nestedLoops(block)) {
      delete this.state.iterations[nested.id]
      delete this.state.feedback[nested.id]
      delete this.state.bonus[nested.id]
    }
  }

  private descendContext(): DescendContext {
    return {
      enterLoop: (block) => {
        this.state.iterations[block.id] = 1
        delete this.state.feedback[block.id]
        delete this.state.bonus[block.id]
        this.clearNested(block)
      },
      evaluate: (condition) => evaluateCondition(condition, this.scope({}))
    }
  }

  private scope(run: Record<string, unknown>): Scope {
    const leaf = this.tree.leaf(this.state.current)
    const loop = leaf ? this.tree.repeatable(leaf)[0] : undefined
    return { params: this.params, outputs: this.state.outputs, run: { id: this.runId, iteration: loop ? this.state.iterations[loop.id] ?? 1 : 1, ...run } }
  }

  /** Compute the `run.*` values an agent step actually references. */
  private async runValues(refs: string[]): Promise<Record<string, unknown>> {
    const wanted = new Set(refs.filter((r) => r.startsWith('run.')).map((r) => r.split('.')[1]))
    const values: Record<string, unknown> = {}
    const cwd = this.state.projectPath
    if (wanted.has('diff')) values.diff = await this.deps.git.workingDiff(cwd)
    if (wanted.has('stagedDiff')) values.stagedDiff = await this.deps.git.stagedDiff(cwd)
    if (wanted.has('changedFiles')) values.changedFiles = (await this.deps.git.status(cwd)).map((c) => `${c.path} (${c.kind}${c.staged ? ', staged' : ''})`)
    return values
  }

  // ── Step kinds ────────────────────────────────────────────────────────────

  private async runAgent(id: string, node: AgentStep, visit: NodeVisit): Promise<NodeResult> {
    const cli = node.cli ?? this.machine.defaults?.cli
    if (!cli) return { kind: 'escalate', message: `Step "${id}" has no CLI.` }
    const schemaName = node.output ?? 'implementerReport'
    const schema = resolveSchema(schemaName, this.machine.schemas) ?? BUILTIN_SCHEMAS.implementerReport

    const refs = [...(node.inputs ?? []), ...templateRefs(node.task ?? '')]
    const scope = this.scope(await this.runValues(refs))
    const context = buildPipelineContext(this.machine, id, this.state)
    const roleText = this.deps.readRole(this.machineDir, node.role)
    const contract = outputContract(schemaName, schema)
    const systemAppend = buildSystemAppend(roleText, context, contract)
    let prompt = buildTaskPrompt(node, scope, feedbackSections(this.machine, id, this.state))

    // keep (default): continue this step's own session from its previous visit.
    // continue:<step>: continue that step's session (then our own, once we have one).
    let resumeSessionId: string | undefined
    const session = node.session ?? 'keep'
    if (session === 'keep') resumeSessionId = this.state.sessions[id]
    else if (session.startsWith('continue:')) {
      const target = session.slice('continue:'.length)
      resumeSessionId = this.state.sessions[id] ?? this.state.sessions[target]
      if (!resumeSessionId) return { kind: 'escalate', message: `Step "${id}" continues the session of "${target}", which has none yet.` }
    }
    if (resumeSessionId) {
      // The resumed conversation still carries the previous step's instructions, and
      // they outweigh a fresh system append (seen live: commit prep refused to stage
      // because the implement step had said "do not stage"). Restate the step in the
      // user message, which the agent reads last.
      const previous = [...this.state.history].reverse().find((h) => h.sessionId === resumeSessionId && h.finishedAt)
      if (previous && previous.node !== id) prompt = stepSwitchPrompt(previous.node, id, stepSummary(node), roleText, context, contract) + '\n\n' + prompt
    }
    const interrupted = [...this.state.history].reverse().find((h) => h.node === id && h.outcome === 'interrupted' && h.visit === visit.visit)
    if (interrupted?.sessionId) {
      resumeSessionId = interrupted.sessionId
      prompt = `Your previous attempt at this step was interrupted. Continue where you left off.\n\n${prompt}`
    }

    const timeoutMs = (node.timeoutMin ?? this.machine.defaults?.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000
    const runDir = this.store.nodeRunDir(this.runId, id, visit.visit)
    const attempt = (attemptPrompt: string, sessionId: string | undefined): HeadlessRun => this.deps.startAgent({
      cli,
      cwd: this.state.projectPath,
      runDir,
      prompt: attemptPrompt,
      systemAppend,
      permissions: node.permissions ?? 'write',
      outputSchema: schema,
      model: node.model ?? this.machine.defaults?.model,
      effort: node.effort ?? this.machine.defaults?.effort,
      resumeSessionId: sessionId,
      timeoutMs,
      label: `${cli}:${id}`,
      onSessionId: (sid) => { visit.sessionId = sid; this.save() },
      onEntry: (entry) => {
        this.store.appendTranscript(this.runId, id, visit.visit, entry)
        this.deps.onTranscript?.(this.runId, id, visit.visit, entry)
      }
    })

    let handle = attempt(prompt, resumeSessionId)
    this.active = handle
    let result = await handle.result
    if (result.error?.code === 'cancelled' || this.interruptRequested) return { kind: 'interrupted' }
    if (!result.ok) return { kind: 'escalate', message: `${cli} failed (${result.error?.code}): ${result.error?.message}` }

    let errors = validateAgainstSchema(result.structured, schema)
    if (errors.length > 0 && result.sessionId) {
      handle = attempt(invalidOutputPrompt(errors), result.sessionId)
      this.active = handle
      result = await handle.result
      if (result.error?.code === 'cancelled' || this.interruptRequested) return { kind: 'interrupted' }
      if (!result.ok) return { kind: 'escalate', message: `${cli} failed (${result.error?.code}): ${result.error?.message}` }
      errors = validateAgainstSchema(result.structured, schema)
    }
    if (errors.length > 0) return { kind: 'escalate', message: `Output of "${id}" does not match "${schemaName}": ${errors.join('; ')}` }
    return { kind: 'done', outcome: 'ok', output: result.structured, sessionId: result.sessionId, costUsd: result.costUsd }
  }

  private async runCheck(id: string, node: CheckStep, visit: NodeVisit): Promise<NodeResult> {
    let output = ''
    const timeoutMs = (node.timeoutMin ?? this.machine.defaults?.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000
    const handle = this.deps.runCheck({
      commandLine: node.command,
      cwd: this.state.projectPath,
      timeoutMs,
      label: `check:${id}`,
      onOutput: (text) => {
        output += text
        if (output.length > CHECK_OUTPUT_TAIL * 4) output = output.slice(-CHECK_OUTPUT_TAIL * 2)
        this.store.appendCheckLog(this.runId, id, visit.visit, text)
      }
    })
    this.active = handle
    const exit = await handle.done
    if (exit.cancelled || this.interruptRequested) return { kind: 'interrupted' }
    if (exit.spawnError) return { kind: 'escalate', message: `Check "${id}" could not start: ${exit.spawnError}` }
    const tail = output.slice(-CHECK_OUTPUT_TAIL)
    const note = exit.timedOut ? `\n(timed out after ${timeoutMs / 60_000} min)` : ''
    return { kind: 'done', outcome: exit.exitCode === 0 && !exit.timedOut ? 'ok' : 'fail', output: { exitCode: exit.exitCode, output: tail + note } }
  }

  private async runCommit(id: string, node: CommitStep, visit: NodeVisit): Promise<NodeResult> {
    const prep = (this.state.outputs[node.prep.id] ?? {}) as { commitMessage?: string; excluded?: Array<{ path: string; reason: string }> }
    const message = prep.commitMessage ?? ''
    const excluded = prep.excluded ?? []
    const cwd = this.state.projectPath
    const coverage = checkCommitCoverage(await this.deps.git.status(cwd), message, excluded.map((e) => e.path))
    if (!coverage.ok) return { kind: 'done', outcome: 'fail', output: { issues: coverage.issues } }

    if (node.review === 'agent' && node.reviewer) {
      const reviewer = node.reviewer
      const cli = reviewer.cli ?? this.machine.defaults?.cli
      if (!cli) return { kind: 'escalate', message: `Commit reviewer of "${id}" has no CLI.` }
      const stagedDiff = await this.deps.git.stagedDiff(cwd)
      const prompt = [
        'Review the prepared commit. Check that the index contains no junk (build output, temporary files, unrelated changes), that the excluded files are justified, and that the message describes the change.',
        `## Commit message\n\n${message}`,
        `## Excluded files\n\n${excluded.length ? excluded.map((e) => `- ${e.path}: ${e.reason}`).join('\n') : '(none)'}`,
        `## Staged diff\n\n${stagedDiff}`
      ].join('\n\n')
      const handle = this.deps.startAgent({
        cli,
        cwd,
        runDir: this.store.nodeRunDir(this.runId, id, visit.visit),
        prompt,
        systemAppend: buildSystemAppend(this.deps.readRole(this.machineDir, reviewer.role), buildPipelineContext(this.machine, id, this.state), outputContract('commitReview', BUILTIN_SCHEMAS.commitReview)),
        permissions: 'read-only',
        outputSchema: BUILTIN_SCHEMAS.commitReview,
        model: reviewer.model ?? this.machine.defaults?.model,
        effort: reviewer.effort ?? this.machine.defaults?.effort,
        timeoutMs: (reviewer.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000,
        label: `${cli}:${id}:review`,
        onEntry: (entry) => {
          this.store.appendTranscript(this.runId, id, visit.visit, entry)
          this.deps.onTranscript?.(this.runId, id, visit.visit, entry)
        }
      })
      this.active = handle
      const result = await handle.result
      if (result.error?.code === 'cancelled' || this.interruptRequested) return { kind: 'interrupted' }
      if (!result.ok) return { kind: 'escalate', message: `Commit reviewer failed (${result.error?.code}): ${result.error?.message}` }
      const errors = validateAgainstSchema(result.structured, BUILTIN_SCHEMAS.commitReview)
      if (errors.length) return { kind: 'escalate', message: `Commit review output invalid: ${errors.join('; ')}` }
      const verdict = result.structured as { verdict: string; issues: string[] }
      if (verdict.verdict !== 'accept') return { kind: 'done', outcome: 'fail', output: { issues: verdict.issues }, costUsd: result.costUsd }
    }

    const commit = await this.deps.git.commitIndex(cwd, message)
    this.commits.push(commit)
    this.deps.emit(this.runId, 'commit_done', { node: id, sha: commit.sha, summary: `committed ${commit.sha.slice(0, 10)} ${commit.message.split('\n')[0]} (${commit.files.length} files)` })
    return { kind: 'done', outcome: 'ok', output: { ...commit, issues: [] } }
  }

  // ── State transitions ─────────────────────────────────────────────────────

  private recordVisit(id: string, visit: number, outcome: Outcome | null): void {
    const now = new Date().toISOString()
    this.state.history.push({ node: id, visit, outcome, startedAt: now, finishedAt: outcome ? now : null, sessionId: null, costUsd: null, error: null })
  }

  private raise(escalation: Omit<Escalation, 'id' | 'raisedAt' | 'answer'>): void {
    const entry: Escalation = { ...escalation, id: randomUUID().slice(0, 8), raisedAt: new Date().toISOString(), answer: null }
    this.state.escalations.push(entry)
    this.setStatus('waiting')
    this.deps.emit(this.runId, 'escalation', compactEscalation(entry))
  }

  /** Engine-level problem at `node`. `refundVisit` gives the failed visit back so a retry keeps the numbering. */
  private raiseEngineEscalation(node: string, message: string, refundVisit = false): void {
    if (refundVisit && this.state.visits[node]) this.state.visits[node] -= 1
    this.state.current = node
    this.raise({ node, kind: 'engine', to: 'orchestrator', message })
  }

  private finish(result: 'success' | 'failure', reason: string | null): void {
    this.state.result = result
    this.state.finishedAt = new Date().toISOString()
    if (result === 'success') this.state.current = null
    this.setStatus(result === 'success' ? 'finished' : 'failed')
    const report = this.buildReport(reason)
    this.store.writeReport(this.runId, report)
    this.deps.emit(this.runId, result === 'success' ? 'run_finished' : 'run_failed', {
      result,
      reason: reason ? clip(reason, 600) : null,
      summary: `run ${result}${reason ? `: ${clip(reason, 200)}` : ''}`,
      // Everything the orchestrator needs to update the plan; pipeline_report is only for more detail.
      report: compactReport(report)
    })
  }

  buildReport(reason: string | null = null): RunReport & { reason: string | null } {
    const durations = this.state.history.map((h) => ({
      node: h.node,
      visit: h.visit,
      outcome: h.outcome,
      durationMs: h.finishedAt ? Date.parse(h.finishedAt) - Date.parse(h.startedAt) : null,
      costUsd: h.costUsd,
      error: h.error
    }))
    const summaries: Array<{ node: string; summary: string }> = []
    const nonBlocking: string[] = []
    for (const [node, output] of Object.entries(this.state.outputs)) {
      const o = output as Record<string, unknown> | null
      if (o && typeof o.summary === 'string' && this.tree.leaf(node)?.step.type === 'agent') summaries.push({ node, summary: o.summary })
      if (o && Array.isArray(o.non_blocking)) for (const f of o.non_blocking) if (typeof f === 'string') nonBlocking.push(f)
    }
    return {
      runId: this.runId,
      machine: { id: this.machine.id, name: this.machine.name },
      params: this.params,
      result: this.state.result ?? 'stopped',
      reason,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt ?? new Date().toISOString(),
      startCommit: this.state.startCommit,
      loops: this.state.iterations,
      visits: durations,
      commits: this.commits.length ? this.commits : this.state.history.flatMap((h) => {
        const out = this.state.outputs[h.node] as { sha?: string; files?: string[]; message?: string } | undefined
        return this.tree.leaf(h.node)?.step.type === 'commit' && out?.sha ? [{ sha: out.sha, files: out.files ?? [], message: out.message ?? '' }] : []
      }),
      summaries,
      nonBlockingFindings: nonBlocking,
      escalations: this.state.escalations,
      costUsd: this.state.history.reduce((sum, h) => sum + (h.costUsd ?? 0), 0)
    }
  }

  /** Short status for the orchestrator; outputs are fetched separately (`pipeline_output`). */
  describe(): Record<string, unknown> {
    const current = this.state.current
    const leaf = this.tree.leaf(current)
    const pending = this.pendingEscalation()
    return {
      runId: this.runId,
      machine: this.machine.id,
      status: this.state.status,
      current,
      currentSummary: leaf ? stepSummary(leaf.step) : null,
      loops: this.state.iterations,
      visits: this.state.visits,
      pendingEscalation: pending ? compactEscalation(pending) : null,
      result: this.state.result
    }
  }

  private setStatus(status: RunState['status']): void {
    this.state.status = status
    this.save()
  }

  private save(): void {
    this.state.updatedAt = new Date().toISOString()
    this.store.saveState(this.state)
    this.deps.onStateChange?.(this.state)
  }
}
