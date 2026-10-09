import { randomUUID } from 'crypto'
import type { HistoryEntry } from '../../pty/cliTools/types'
import type { HeadlessRun, HeadlessRunOptions } from '../headless/types'
import type { ProcessHandle } from '../processRunner'
import type { CommitResult, FileChange } from '../git'
import { checkCommitCoverage } from '../git'
import type { PipelineEventType } from '../events'
import type { AgentNode, CheckNode, CommitNode, Escalation, EscalationAnswer, MachineDefinition, NodeVisit, Outcome, RunState } from './types'
import { evaluateCondition, resolveRef, templateRefs, type Scope } from './expressions'
import { resolveSchema, validateAgainstSchema, BUILTIN_SCHEMAS } from './schema'
import { buildPipelineContext, buildSystemAppend, buildTaskPrompt, invalidOutputPrompt, nodeSummary, outputContract, stepSwitchPrompt } from './context'
import type { RunStore, StoredMachine } from './runStore'

/**
 * Deterministic executor of one pipeline run (plan §1, §3, §4).
 *
 * The run is a loop over nodes. After each node, edges are evaluated in order
 * and the first match decides the next node. Agent failures (crash, limit,
 * timeout, unusable output) are not routed: they raise an engine escalation
 * that the orchestrator or the user answers with retry or stop.
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

const DEFAULT_TIMEOUT_MIN = 60
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
  visits: Array<{ node: string; visit: number; outcome: string | null; durationMs: number | null; costUsd: number | null; error: string | null }>
  commits: CommitResult[]
  summaries: Array<{ node: string; summary: string }>
  nonBlockingFindings: string[]
  escalations: Escalation[]
  costUsd: number
}

export class PipelineRun {
  private readonly machine: MachineDefinition
  private readonly machineDir: string
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
  }

  static create(stored: StoredMachine, params: Record<string, unknown>, runId: string, projectPath: string, store: RunStore, deps: EngineDeps): PipelineRun {
    const now = new Date().toISOString()
    const state: RunState = {
      runId,
      machineId: stored.machine.id,
      projectPath,
      status: 'paused',
      current: stored.machine.start,
      visits: {},
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
    store.create(state, stored, params)
    return new PipelineRun(stored, params, state, store, deps)
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

  /** Finish the current node, then stop before the next one. */
  pause(): void {
    if (this.state.status === 'running') this.setStatus('pausing')
  }

  /** Interrupt the current node now; the run can be resumed later from that node. */
  async stop(): Promise<void> {
    if (this.state.status === 'running' || this.state.status === 'pausing') {
      this.interruptRequested = true
      await this.active?.cancel()
      await this.loop
    } else if (this.state.status === 'paused' || this.state.status === 'waiting') {
      this.setStatus('stopped')
      this.deps.emit(this.runId, 'run_stopped', { node: this.state.current })
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
    if (escalation.kind === 'engine') {
      // retry (continue is treated the same): run the failed node again.
      this.state.current = node
    } else {
      const outcome: Outcome = escalation.kind === 'gate' && answer.action === 'reject' ? 'fail' : 'ok'
      this.state.outputs[node] = { answer: answer.text, action: answer.action, by: answer.by }
      const next = this.route(node, outcome)
      if (!next) { this.raiseEngineEscalation(node, `No edge from "${node}" matches the answer.`); return null }
      this.state.current = next
    }
    this.setStatus('paused')
    void this.run()
    return null
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  private async execute(): Promise<void> {
    while (this.state.status === 'running' || this.state.status === 'pausing') {
      const id = this.state.current
      if (!id) { this.finish('failure', 'no current node'); return }
      const node = this.machine.nodes[id]

      const visits = (this.state.visits[id] ?? 0) + 1
      if (node.maxVisits && visits > node.maxVisits) {
        if (node.onLimit) { this.state.current = node.onLimit; this.save(); continue }
        this.raiseEngineEscalation(id, `"${id}" reached its limit of ${node.maxVisits} visits.`, false)
        return
      }
      this.state.visits[id] = visits

      if (node.type === 'end') {
        this.recordVisit(id, visits, 'ok')
        this.finish(node.result, null)
        return
      }
      if (node.type === 'escalate' || node.type === 'gate') {
        this.recordVisit(id, visits, null)
        const message = node.type === 'gate' ? node.question : (node.message ? node.message : `Escalation from "${id}".`)
        this.raise({ node: id, kind: node.type === 'gate' ? 'gate' : 'node', to: node.to ?? 'orchestrator', message })
        return
      }

      const visit: NodeVisit = { node: id, visit: visits, outcome: null, startedAt: new Date().toISOString(), finishedAt: null, sessionId: null, costUsd: null, error: null }
      this.state.history.push(visit)
      this.save()
      this.deps.emit(this.runId, 'node_started', { node: id, visit: visits, type: node.type })

      let result: NodeResult
      try {
        result = node.type === 'agent' ? await this.runAgent(id, node, visit)
          : node.type === 'check' ? await this.runCheck(id, node, visit)
            : await this.runCommit(id, node, visit)
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
        this.deps.emit(this.runId, 'run_stopped', { node: id, visit: visits })
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
      this.deps.emit(this.runId, 'node_finished', { node: id, visit: visits, outcome: result.outcome })
      if (node.type === 'check' && result.outcome === 'fail') this.deps.emit(this.runId, 'check_failed', { node: id, visit: visits, output: (result.output as { output?: string }).output ?? '' })

      const next = this.route(id, result.outcome)
      if (!next) { this.raiseEngineEscalation(id, `No edge from "${id}" matches outcome "${result.outcome}".`, false); return }
      this.state.current = next
      this.save()
      if (this.state.status === 'pausing') {
        this.setStatus('paused')
        this.deps.emit(this.runId, 'run_paused', { next })
        return
      }
    }
  }

  private route(from: string, outcome: Outcome): string | null {
    const scope = this.scope({})
    for (const [source, to, condition] of this.machine.edges) {
      if (source === from && evaluateCondition(condition, outcome, scope)) return to
    }
    return null
  }

  private scope(run: Record<string, unknown>): Scope {
    return { params: this.params, outputs: this.state.outputs, run: { id: this.runId, iteration: this.state.visits[this.state.current ?? ''] ?? 0, ...run } }
  }

  /** Compute the `run.*` values an agent node actually references. */
  private async runValues(refs: string[], reviewerExtra = false): Promise<Record<string, unknown>> {
    const wanted = new Set(refs.filter((r) => r.startsWith('run.')).map((r) => r.split('.')[1]))
    if (reviewerExtra) { wanted.add('stagedDiff') }
    const values: Record<string, unknown> = {}
    const cwd = this.state.projectPath
    if (wanted.has('diff')) values.diff = await this.deps.git.workingDiff(cwd)
    if (wanted.has('stagedDiff')) values.stagedDiff = await this.deps.git.stagedDiff(cwd)
    if (wanted.has('changedFiles')) values.changedFiles = (await this.deps.git.status(cwd)).map((c) => `${c.path} (${c.kind}${c.staged ? ', staged' : ''})`)
    return values
  }

  // ── Node kinds ────────────────────────────────────────────────────────────

  private async runAgent(id: string, node: AgentNode, visit: NodeVisit): Promise<NodeResult> {
    const cli = node.cli ?? this.machine.defaults?.cli
    if (!cli) return { kind: 'escalate', message: `Node "${id}" has no CLI.` }
    const schemaName = node.output ?? 'implementerReport'
    const schema = resolveSchema(schemaName, this.machine.schemas) ?? BUILTIN_SCHEMAS.implementerReport

    const refs = [...(node.inputs ?? []), ...templateRefs(node.task ?? '')]
    const scope = this.scope(await this.runValues(refs))
    const context = buildPipelineContext(this.machine, id, this.state)
    const roleText = this.deps.readRole(this.machineDir, node.role)
    const contract = outputContract(schemaName, schema)
    const systemAppend = buildSystemAppend(roleText, context, contract)
    let prompt = buildTaskPrompt(node, scope)

    let resumeSessionId: string | undefined
    if (node.session?.startsWith('continue:')) {
      const target = node.session.slice('continue:'.length)
      resumeSessionId = this.state.sessions[target]
      if (!resumeSessionId) return { kind: 'escalate', message: `Node "${id}" continues the session of "${target}", which has none yet.` }
      // The resumed conversation still carries the previous step's instructions, and
      // they outweigh a fresh system append (seen live: commit prep refused to stage
      // because the implement step had said "do not stage"). Restate the step in the
      // user message, which the agent reads last.
      const previous = [...this.state.history].reverse().find((h) => h.sessionId === resumeSessionId && h.finishedAt)
      if (previous && previous.node !== id) prompt = stepSwitchPrompt(previous.node, id, nodeSummary(id, node), roleText, context, contract) + '\n\n' + prompt
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

  private async runCheck(id: string, node: CheckNode, visit: NodeVisit): Promise<NodeResult> {
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

  private async runCommit(id: string, node: CommitNode, visit: NodeVisit): Promise<NodeResult> {
    const prep = (this.state.outputs[node.prep] ?? {}) as { commitMessage?: string; excluded?: Array<{ path: string; reason: string }> }
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
    this.deps.emit(this.runId, 'commit_done', { node: id, sha: commit.sha, files: commit.files })
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
    this.deps.emit(this.runId, 'escalation', { escalationId: entry.id, node: entry.node, kind: entry.kind, to: entry.to, message: entry.message })
  }

  /** Engine-level problem at `node`. `refundVisit` gives the failed visit back so a retry does not use up the loop budget. */
  private raiseEngineEscalation(node: string, message: string, refundVisit = false): void {
    if (refundVisit && this.state.visits[node]) this.state.visits[node] -= 1
    this.state.current = node
    this.raise({ node, kind: 'engine', to: 'orchestrator', message })
  }

  private finish(result: 'success' | 'failure', reason: string | null): void {
    this.state.result = result
    this.state.finishedAt = new Date().toISOString()
    this.setStatus(result === 'success' ? 'finished' : 'failed')
    const report = this.buildReport(reason)
    this.store.writeReport(this.runId, report)
    this.deps.emit(this.runId, result === 'success' ? 'run_finished' : 'run_failed', { result, reason, commits: report.commits.map((c) => c.sha) })
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
      if (o && typeof o.summary === 'string' && this.machine.nodes[node]?.type === 'agent') summaries.push({ node, summary: o.summary })
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
      visits: durations,
      commits: this.commits.length ? this.commits : this.state.history.flatMap((h) => {
        const out = this.state.outputs[h.node] as { sha?: string; files?: string[]; message?: string } | undefined
        return this.machine.nodes[h.node]?.type === 'commit' && out?.sha ? [{ sha: out.sha, files: out.files ?? [], message: out.message ?? '' }] : []
      }),
      summaries,
      nonBlockingFindings: nonBlocking,
      escalations: this.state.escalations,
      costUsd: this.state.history.reduce((sum, h) => sum + (h.costUsd ?? 0), 0)
    }
  }

  /** Short human/agent-readable status. */
  describe(): Record<string, unknown> {
    const current = this.state.current
    return {
      runId: this.runId,
      machine: this.machine.id,
      status: this.state.status,
      current,
      currentSummary: current ? nodeSummary(current, this.machine.nodes[current]) : null,
      visits: this.state.visits,
      pendingEscalation: this.pendingEscalation(),
      result: this.state.result,
      lastOutputs: current ? resolveRef(`outputs.${current}`, this.scope({})) ?? null : null
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
