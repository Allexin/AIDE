import type { RunSnapshot } from '../pipeline/manager'
import type { Escalation, EscalationAnswer, NodeVisit, RunState, RunStatus } from '../pipeline/engine/types'
import { blockTitle, walkSteps, type Step } from '../../shared/pipelineMachine'

/**
 * The remote pipeline page's view of a run: the machine's step tree flattened
 * into indented rows with their states, the pending escalation with the answers
 * it takes, and the run header. Built here so the page's script only draws it;
 * step outputs and the full state stay in AIDE.
 */

export interface RemoteVisit {
  visit: number
  outcome: NodeVisit['outcome']
  startedAt: string
  finishedAt: string | null
  costUsd: number | null
  error: string | null
  retries?: number
}

export type LeafState = 'pending' | 'running' | 'waiting' | 'held' | 'ok' | 'fail' | 'interrupted' | 'other'

export type RemoteStepRow =
  | { kind: 'heading'; depth: number; label: string; tone: 'group' | 'branch'; summary?: string }
  | { kind: 'block'; depth: number; id: string; label: string; type: 'loop' | 'commit'; progress: string; active: boolean; summary?: string }
  | {
      kind: 'leaf'; depth: number; id: string; type: string; summary?: string; state: LeafState; current: boolean
      /** Whether the step runs an agent, so its visits have a transcript and inputs. */
      agent: boolean
      cli?: string
      visits: RemoteVisit[]
    }

export interface RemoteEscalation {
  id: string
  kind: Escalation['kind']
  node: string
  to: Escalation['to']
  title: string
  message: string
  raisedAt: string
  actions: Array<{ action: EscalationAnswer['action']; label: string }>
}

export interface RemoteRunView {
  runId: string
  machineName: string
  status: RunStatus
  active: boolean
  current: string | null
  loopLabel: string
  startedAt: string
  finishedAt: string | null
  result: RunState['result']
  pending: RemoteEscalation | null
  lastAnswer: { node: string; action: EscalationAnswer['action']; text: string; by: EscalationAnswer['by']; at: string } | null
  limitResumeAt: string | null
  limitCli: string | null
  unavailable: { node: string; cli: string; since: string; attempts: number; lastError: string } | null
  /** Absent in a brief view (the terminal page only shows the header). */
  rows?: RemoteStepRow[]
}

type LoopStep = Extract<Step, { type: 'loop' | 'commit' }>

export function isRunActive(status: RunStatus): boolean {
  return status === 'running' || status === 'pausing' || status === 'paused' || status === 'waiting' || status === 'stopped'
}

function loopLimit(step: LoopStep, state: RunState): number {
  return (step.type === 'loop' ? step.maxIterations : step.maxAttempts ?? 3) + (state.bonus?.[step.id] ?? 0)
}

function contains(steps: Step[], id: string | null): boolean {
  let found = false
  if (id) walkSteps(steps, (step) => { if (step.id === id) found = true })
  return found
}

function holdsCurrent(step: LoopStep, current: string | null): boolean {
  if (step.type === 'commit') return current === step.id || current === step.prep.id
  return contains(step.steps, current)
}

/** "name 2/3" for the innermost loop or commit block around the current step. */
function loopLabel(steps: Step[], state: RunState): string {
  let label = ''
  walkSteps(steps, (step, ancestors) => {
    if (step.id !== state.current || label) return
    const chain = step.type === 'commit' ? [...ancestors, step] : ancestors
    const loop = [...chain].reverse().find((s): s is LoopStep => s.type === 'loop' || s.type === 'commit')
    if (loop) label = `${blockTitle(loop)} ${state.iterations?.[loop.id] ?? 1}/${loopLimit(loop, state)}`
  })
  return label
}

const ESCALATION_TITLE: Record<Escalation['kind'], string> = {
  engine: 'The run cannot continue', gate: 'Approval needed', limit: 'Loop limit reached', step: 'Decision needed'
}

/** The answers each kind takes, as the desktop pipeline tab offers them. */
function escalationActions(kind: Escalation['kind']): RemoteEscalation['actions'] {
  const own: RemoteEscalation['actions'] =
    kind === 'engine' ? [{ action: 'retry', label: 'Retry step' }]
      : kind === 'step' ? [{ action: 'continue', label: 'Continue' }, { action: 'retry', label: 'Retry step' }]
        : kind === 'limit' ? [{ action: 'retry', label: 'One more iteration' }, { action: 'continue', label: 'Continue anyway' }]
          : [{ action: 'continue', label: 'Approve' }, { action: 'reject', label: 'Reject' }]
  return [...own, { action: 'stop', label: 'Stop run' }]
}

function visitView(visit: NodeVisit): RemoteVisit {
  const view: RemoteVisit = {
    visit: visit.visit, outcome: visit.outcome, startedAt: visit.startedAt, finishedAt: visit.finishedAt, costUsd: visit.costUsd, error: visit.error
  }
  if (visit.retries) view.retries = visit.retries
  return view
}

function buildRows(snapshot: RunSnapshot): RemoteStepRow[] {
  const { machine, state } = snapshot
  const active = isRunActive(state.status)
  const fallbackCli = machine.defaults?.cli
  const rows: RemoteStepRow[] = []

  const leaf = (id: string, type: string, depth: number, agent: boolean, summary?: string, cli?: string): void => {
    const visits = state.history.filter((h) => h.node === id)
    const last = visits[visits.length - 1]
    const current = active && state.current === id
    const leafState: LeafState = current
      ? state.status === 'waiting' ? 'waiting' : state.status === 'running' || state.status === 'pausing' ? 'running' : 'held'
      : !last ? 'pending' : last.outcome === 'ok' ? 'ok' : last.outcome === 'fail' ? 'fail' : last.outcome === 'interrupted' ? 'interrupted' : 'other'
    const row: RemoteStepRow = { kind: 'leaf', depth, id, type, state: leafState, current, agent, visits: visits.map(visitView) }
    if (summary) row.summary = summary
    if (cli) row.cli = cli
    rows.push(row)
  }

  const list = (steps: Step[], depth: number): void => {
    for (const step of Array.isArray(steps) ? steps : []) {
      switch (step.type) {
        case 'group':
          rows.push({ kind: 'heading', depth, label: blockTitle(step), tone: 'group', ...(step.summary ? { summary: step.summary } : {}) })
          list(step.steps, depth + 1)
          break
        case 'loop':
        case 'commit': {
          const iteration = state.iterations?.[step.id]
          const limit = loopLimit(step, state)
          rows.push({
            kind: 'block', depth, id: step.id, type: step.type,
            label: step.type === 'commit' ? `commit ${step.id}` : blockTitle(step),
            progress: iteration !== undefined ? `${step.type === 'commit' ? 'attempt' : 'iteration'} ${iteration}/${limit}` : `max ${limit}`,
            active: iteration !== undefined && active && holdsCurrent(step, state.current),
            ...(step.summary ? { summary: step.summary } : {})
          })
          if (step.type === 'loop') list(step.steps, depth + 1)
          else {
            list([step.prep], depth + 1)
            const reviewer = step.review === 'agent'
            leaf(step.id, 'commit', depth + 1, reviewer,
              reviewer ? 'a reviewer agent checks the staged commit, then AIDE commits' : 'AIDE checks the staged commit and commits',
              reviewer ? step.reviewer?.cli ?? fallbackCli : undefined)
          }
          break
        }
        case 'if':
          rows.push({ kind: 'heading', depth, label: `if ${step.condition}`, tone: 'branch' })
          list(step.then, depth + 1)
          if (step.else && step.else.length > 0) {
            rows.push({ kind: 'heading', depth, label: 'else', tone: 'branch' })
            list(step.else, depth + 1)
          }
          break
        case 'agent':
          leaf(step.id, 'agent', depth, true, step.summary, step.cli ?? fallbackCli)
          break
        case 'check':
          leaf(step.id, 'check', depth, false, step.summary ?? step.command)
          break
        case 'gate':
          leaf(step.id, 'gate', depth, false, step.summary ?? step.question)
          break
        default:
          leaf(step.id, step.type, depth, false, step.summary)
      }
    }
  }

  list(machine.steps, 0)
  return rows
}

export function buildRemoteRunView(snapshot: RunSnapshot, options: { brief?: boolean } = {}): RemoteRunView {
  const { machine, state } = snapshot
  const pending = state.escalations.find((e) => e.answer === null) ?? null
  const answered = [...state.escalations].reverse().find((e) => e.answer !== null) ?? null
  const view: RemoteRunView = {
    runId: state.runId,
    machineName: machine.name,
    status: state.status,
    active: isRunActive(state.status),
    current: state.current,
    loopLabel: loopLabel(machine.steps, state),
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    result: state.result,
    pending: pending && {
      id: pending.id, kind: pending.kind, node: pending.node, to: pending.to, title: ESCALATION_TITLE[pending.kind],
      message: pending.message, raisedAt: pending.raisedAt, actions: escalationActions(pending.kind)
    },
    lastAnswer: answered?.answer
      ? { node: answered.node, action: answered.answer.action, text: answered.answer.text, by: answered.answer.by, at: answered.answer.at }
      : null,
    limitResumeAt: state.limitResumeAt ?? null,
    limitCli: state.limitCli ?? null,
    unavailable: state.unavailable
      ? { node: state.unavailable.node, cli: state.unavailable.cli, since: state.unavailable.since, attempts: state.unavailable.attempts, lastError: state.unavailable.lastError }
      : null
  }
  if (!options.brief) view.rows = buildRows(snapshot)
  return view
}
