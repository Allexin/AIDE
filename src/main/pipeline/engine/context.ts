import type { AgentNode, MachineDefinition, MachineNode, RunState } from './types'
import { parseCondition, renderTemplate, resolveRef, stringifyValue, type Scope } from './expressions'

/**
 * Prompt composition for agent nodes (plan §3.1). Besides its role, every agent
 * gets a generated **pipeline context**: the whole flow with its position
 * marked, what each later node does (so it does not duplicate work — e.g. the
 * implementer does not run checks that a check node runs), and what happened
 * before this visit.
 */

export function nodeSummary(id: string, node: MachineNode): string {
  if (node.summary?.trim()) return node.summary.trim()
  switch (node.type) {
    case 'check': return `AIDE runs \`${node.command}\``
    case 'commit': return `AIDE reviews the prepared commit (${node.review === 'agent' ? 'reviewer agent' : 'automatic checks'}) and commits it`
    case 'gate': return `waits for approval: ${node.question}`
    case 'escalate': return `hands the problem to the ${node.to ?? 'orchestrator'}`
    case 'end': return `the run ends (${node.result})`
    case 'agent': return `agent step "${id}"`
  }
}

function performer(node: MachineNode): string {
  switch (node.type) {
    case 'agent': return 'agent'
    case 'check': return 'AIDE'
    case 'commit': return 'AIDE'
    case 'gate': return 'approval'
    case 'escalate': return 'escalation'
    case 'end': return 'end'
  }
}

function describeCondition(condition: string): string {
  const parsed = parseCondition(condition)
  if ('error' in parsed) return condition
  if (parsed.kind === 'default') return 'otherwise'
  if (parsed.kind === 'outcome') return parsed.outcome === 'ok' ? 'on success' : 'on failure'
  const field = parsed.ref.split('.').slice(-1)[0]
  return `if ${field} ${parsed.op === '==' ? 'is' : 'is not'} ${JSON.stringify(parsed.literal)}`
}

/** Nodes in flow order: breadth-first from start, following edges in declaration order. */
export function flowOrder(machine: MachineDefinition): string[] {
  const order: string[] = []
  const queue = [machine.start]
  const seen = new Set(queue)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    const next = machine.edges.filter((e) => e[0] === id).map((e) => e[1])
    const limit = machine.nodes[id]?.onLimit
    for (const to of limit ? [...next, limit] : next) if (!seen.has(to) && machine.nodes[to]) { seen.add(to); queue.push(to) }
  }
  return order
}

function downstream(machine: MachineDefinition, from: string): Set<string> {
  const seen = new Set<string>()
  const stack = machine.edges.filter((e) => e[0] === from).map((e) => e[1])
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of machine.edges) if (e[0] === id) stack.push(e[1])
  }
  return seen
}

export function buildPipelineContext(machine: MachineDefinition, current: string, state: RunState): string {
  const lines: string[] = []
  const order = flowOrder(machine)
  lines.push(`You are one step of the AIDE pipeline "${machine.name}". AIDE runs the flow; each step is done by its own performer. The flow:`)
  order.forEach((id, index) => {
    const node = machine.nodes[id]
    const marker = id === current ? '   ← YOU ARE HERE' : ''
    const limit = node.maxVisits ? ` (at most ${node.maxVisits} times)` : ''
    lines.push(`${index + 1}. ${id} [${performer(node)}] — ${nodeSummary(id, node)}${limit}${marker}`)
    const routes = machine.edges.filter((e) => e[0] === id)
    if (routes.length > 1 || (routes.length === 1 && routes[0][2] !== 'default')) {
      lines.push(`   then: ${routes.map(([, to, condition]) => `${describeCondition(condition)} → ${to}`).join('; ')}`)
    }
  })

  const after = downstream(machine, current)
  const node = machine.nodes[current]
  const checks = [...after].map((id) => machine.nodes[id]).filter((n): n is Extract<MachineNode, { type: 'check' }> => n?.type === 'check')
  const commits = [...after].map((id) => machine.nodes[id]).filter((n): n is Extract<MachineNode, { type: 'commit' }> => n?.type === 'commit')
  const isCommitPrep = Object.values(machine.nodes).some((n) => n.type === 'commit' && n.prep === current)

  lines.push('', 'What happens after you — do not do this work yourself:')
  const next = machine.edges.filter((e) => e[0] === current)
  for (const [, to, condition] of next) {
    lines.push(`- ${describeCondition(condition)}: ${to} — ${nodeSummary(to, machine.nodes[to])}`)
  }
  if (checks.length) lines.push(`- AIDE itself runs these checks later: ${checks.map((c) => `\`${c.command}\``).join(', ')}. Do not run them; if they fail, the failure output comes back to the step that must fix it.`)
  if (isCommitPrep) lines.push('- You prepare the commit (stage files, write the message); AIDE reviews it and commits. Do not commit yourself.')
  else if (commits.length) lines.push('- Staging and committing happen in a later step. Do not stage or commit.')
  if (node?.type === 'agent' && after.has(current)) lines.push('- This step can come back to you with feedback; keep your work easy to continue.')

  lines.push('', 'Before you:')
  const visit = state.visits[current] ?? 1
  const max = node?.maxVisits ? ` of at most ${node.maxVisits}` : ''
  lines.push(`- This is visit ${visit}${max} of "${current}" in run ${state.runId}.`)
  const previous = [...state.history].reverse().find((h) => h.finishedAt && !(h.node === current && h.visit === visit))
  if (previous) lines.push(`- The previous step was "${previous.node}" (visit ${previous.visit}), outcome: ${previous.outcome ?? 'unknown'}.`)
  else lines.push('- You are the first step of this run.')
  return lines.join('\n')
}

export function outputContract(schemaName: string, schema: Record<string, unknown>): string {
  return [
    `Your final answer must be a single JSON object matching the "${schemaName}" schema below. AIDE parses it to decide the next step; prose outside the JSON is ignored.`,
    '```json',
    JSON.stringify(schema, null, 2),
    '```'
  ].join('\n')
}

export function buildSystemAppend(roleText: string, context: string, contract: string, extra: string[] = []): string {
  return [roleText.trim(), '## Pipeline context', context, '## Output', contract, ...extra].filter(Boolean).join('\n\n')
}

/** The user message for an agent node: its task plus the declared inputs. */
export function buildTaskPrompt(node: AgentNode, scope: Scope): string {
  const parts: string[] = []
  parts.push(node.task ? renderTemplate(node.task, scope) : 'Do the work of your role for this pipeline step.')
  for (const ref of node.inputs ?? []) {
    const value = stringifyValue(resolveRef(ref, scope))
    parts.push(`## ${ref}\n\n${value || '(empty)'}`)
  }
  return parts.join('\n\n')
}

export function invalidOutputPrompt(errors: string[]): string {
  return [
    'Your previous final answer did not match the required output schema:',
    ...errors.map((e) => `- ${e}`),
    'Reply again with only the corrected JSON object.'
  ].join('\n')
}
