/**
 * Pipeline machine definitions and run state (plan §2, §3, §4).
 *
 * A machine is a graph of primitive nodes. Routing is expressed on edges:
 * `[from, to, condition]`, evaluated in order after a node finishes; the first
 * matching edge wins. Conditions:
 *   'ok' | 'fail'                      — the node's outcome
 *   'default'                          — always matches (put it last)
 *   "<ref> == <literal>" / "!="        — e.g. "outputs.review.verdict == 'accept'"
 */

export type JsonSchema = Record<string, unknown>

export type ParamType = 'string' | 'string[]' | 'path' | 'glob[]' | 'number' | 'boolean'

export interface ParamDefinition {
  type: ParamType
  description?: string
  /** Defaults to true. */
  required?: boolean
}

interface NodeBase {
  /** One line telling the agents *before* this node what it does (pipeline context). */
  summary?: string
  /** Entering the node more often than this routes to `onLimit` (or escalates). */
  maxVisits?: number
  onLimit?: string
}

export interface AgentNode extends NodeBase {
  type: 'agent'
  /** Role file, relative to the machine's directory (e.g. `roles/implementer.md`). */
  role: string
  /** CliTool id; falls back to machine defaults. */
  cli?: string
  model?: string
  permissions?: 'read-only' | 'write'
  /** `new` (default) or `continue:<nodeId>` — resume that node's CLI session. */
  session?: string
  /** Task text for this node; may reference `{{params.x}}` / `{{outputs.n.f}}`. */
  task?: string
  /** References included in the prompt: `params.x`, `outputs.node.field`, `run.diff`, `run.stagedDiff`, `run.changedFiles`. */
  inputs?: string[]
  /** Name of a schema in `schemas` or a built-in (implementerReport, reviewVerdict, commitPrep, commitReview). */
  output?: string
  timeoutMin?: number
}

export interface CheckNode extends NodeBase {
  type: 'check'
  command: string
  timeoutMin?: number
}

export interface CommitNode extends NodeBase {
  type: 'commit'
  /** The agent node whose output carries `commitMessage` and `excluded`. */
  prep: string
  review: 'algorithmic' | 'agent'
  /** Reviewer for `review: 'agent'`. */
  reviewer?: { role: string; cli?: string; model?: string; timeoutMin?: number }
}

export interface GateNode extends NodeBase {
  type: 'gate'
  question: string
  to?: 'user' | 'orchestrator'
}

export interface EscalateNode extends NodeBase {
  type: 'escalate'
  to?: 'user' | 'orchestrator'
  message?: string
}

export interface EndNode extends NodeBase {
  type: 'end'
  result: 'success' | 'failure'
}

export type MachineNode = AgentNode | CheckNode | CommitNode | GateNode | EscalateNode | EndNode

export type Edge = [from: string, to: string, condition: string]

export interface MachineDefinition {
  id: string
  name: string
  /** Written for the orchestrator: when to use this machine, what it needs, what it produces. */
  description: string
  params?: Record<string, ParamDefinition>
  defaults?: { cli?: string; model?: string; timeoutMin?: number }
  /** Named output schemas referenced by agent nodes. */
  schemas?: Record<string, JsonSchema>
  start: string
  nodes: Record<string, MachineNode>
  edges: Edge[]
}

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
}

export interface Escalation {
  id: string
  node: string
  /** `node`: an escalate/gate node; `engine`: the engine could not proceed. */
  kind: 'node' | 'gate' | 'engine'
  to: 'user' | 'orchestrator'
  message: string
  raisedAt: string
  answer: EscalationAnswer | null
}

export interface EscalationAnswer {
  /** continue: follow the node's edges (gate: approve); retry: re-run the failed node; reject: gate rejected; stop: end the run. */
  action: 'continue' | 'retry' | 'reject' | 'stop'
  text: string
  by: 'user' | 'orchestrator'
  at: string
}

export interface RunState {
  runId: string
  machineId: string
  projectPath: string
  status: RunStatus
  /** Node to execute next (or currently executing / interrupted). */
  current: string | null
  visits: Record<string, number>
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
