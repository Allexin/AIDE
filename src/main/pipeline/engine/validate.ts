import type { AgentNode, MachineDefinition, MachineNode } from './types'
import { parseCondition, templateRefs } from './expressions'
import { resolveSchema, strictSchemaProblems } from './schema'

/**
 * Static validation of a machine definition (plan §2.4). Run on load, by
 * `pipeline_validate`, and before every start.
 */

export interface ValidationEnvironment {
  /** CLI ids that support headless runs. */
  headlessClis: string[]
  /** Whether a role file exists (path relative to the machine's directory). */
  roleExists(rolePath: string): boolean
}

export interface ValidationResult {
  errors: string[]
  warnings: string[]
}

const NODE_TYPES = new Set(['agent', 'check', 'commit', 'gate', 'escalate', 'end'])
const PARAM_TYPES = new Set(['string', 'string[]', 'path', 'glob[]', 'number', 'boolean'])

export function validateMachine(machine: MachineDefinition, env: ValidationEnvironment): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const err = (message: string): void => { errors.push(message) }

  if (!machine || typeof machine !== 'object') return { errors: ['Machine definition must be an object.'], warnings }
  for (const field of ['id', 'name', 'description', 'start'] as const) {
    if (typeof machine[field] !== 'string' || !machine[field].trim()) err(`"${field}" is required.`)
  }
  if (!machine.nodes || typeof machine.nodes !== 'object') return { errors: [...errors, '"nodes" is required.'], warnings }
  if (!Array.isArray(machine.edges)) return { errors: [...errors, '"edges" must be an array.'], warnings }

  const nodes = machine.nodes
  const ids = Object.keys(nodes)
  if (!nodes[machine.start]) err(`Start node "${machine.start}" does not exist.`)

  for (const [name, param] of Object.entries(machine.params ?? {})) {
    if (!PARAM_TYPES.has(param?.type)) err(`Param "${name}": unknown type "${param?.type}".`)
  }

  const defaultCli = machine.defaults?.cli
  for (const [id, node] of Object.entries(nodes)) validateNode(id, node, machine, env, defaultCli, err, warnings)

  // Edges
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]))
  machine.edges.forEach((edge, index) => {
    if (!Array.isArray(edge) || edge.length !== 3) { err(`Edge #${index + 1} must be [from, to, condition].`); return }
    const [from, to, condition] = edge
    if (!nodes[from]) err(`Edge #${index + 1}: unknown source node "${from}".`)
    if (!nodes[to]) err(`Edge #${index + 1}: unknown target node "${to}".`)
    if (nodes[from]?.type === 'end') err(`Edge #${index + 1}: end node "${from}" cannot have outgoing edges.`)
    const parsed = parseCondition(String(condition))
    if ('error' in parsed) err(`Edge #${index + 1}: ${parsed.error}`)
    else if (parsed.kind === 'compare') validateRef(parsed.ref, machine, `Edge #${index + 1}`, err)
    outgoing.get(from)?.push(to)
  })

  for (const id of ids) {
    const node = nodes[id]
    if (node.type === 'end') continue
    const edges = machine.edges.filter((e) => e[0] === id)
    if (edges.length === 0) err(`Node "${id}" has no outgoing edges.`)
    const last = edges[edges.length - 1]
    const hasCatchAll = edges.some((e) => e[2] === 'default') || (edges.some((e) => e[2] === 'ok') && edges.some((e) => e[2] === 'fail'))
    if (edges.length > 0 && !hasCatchAll) err(`Node "${id}" needs a "default" edge (or both "ok" and "fail") so every outcome has a route.`)
    if (last && edges.some((e, i) => e[2] === 'default' && i < edges.length - 1)) warnings.push(`Node "${id}": edges after "default" are never taken.`)
    if (node.onLimit) outgoing.get(id)?.push(node.onLimit)
  }

  // Reachability from start, and every node can reach an end or escalate node.
  if (nodes[machine.start]) {
    const reachable = walk(machine.start, (id) => outgoing.get(id) ?? [])
    for (const id of ids) if (!reachable.has(id)) err(`Node "${id}" is unreachable from "${machine.start}".`)
  }
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [from, targets] of outgoing) for (const to of targets) incoming.get(to)?.push(from)
  const terminals = ids.filter((id) => nodes[id].type === 'end' || nodes[id].type === 'escalate')
  if (terminals.length === 0) err('The machine needs at least one "end" node.')
  const canFinish = new Set<string>()
  for (const terminal of terminals) for (const id of walk(terminal, (n) => incoming.get(n) ?? [])) canFinish.add(id)
  for (const id of ids) if (!canFinish.has(id)) err(`Node "${id}" cannot reach an end or escalate node.`)

  // Every cycle must be bounded by maxVisits.
  for (const component of stronglyConnected(ids, (id) => outgoing.get(id) ?? [])) {
    const cyclic = component.length > 1 || (outgoing.get(component[0]) ?? []).includes(component[0])
    if (cyclic && !component.some((id) => (nodes[id].maxVisits ?? 0) > 0)) {
      err(`Loop ${component.join(' → ')} has no node with "maxVisits"; it could run forever.`)
    }
  }

  return { errors, warnings }
}

function validateNode(id: string, node: MachineNode, machine: MachineDefinition, env: ValidationEnvironment, defaultCli: string | undefined, err: (m: string) => void, warnings: string[]): void {
  if (!node || !NODE_TYPES.has((node as { type?: string }).type ?? '')) { err(`Node "${id}": unknown type "${(node as { type?: string })?.type}".`); return }
  if (node.maxVisits !== undefined && (!Number.isInteger(node.maxVisits) || node.maxVisits < 1)) err(`Node "${id}": "maxVisits" must be a positive integer.`)
  if (node.onLimit !== undefined && !machine.nodes[node.onLimit]) err(`Node "${id}": "onLimit" target "${node.onLimit}" does not exist.`)
  if (node.onLimit && node.maxVisits === undefined) warnings.push(`Node "${id}": "onLimit" without "maxVisits" is never used.`)

  switch (node.type) {
    case 'agent': {
      validateAgent(id, node, machine, env, defaultCli, err)
      break
    }
    case 'check':
      if (!node.command?.trim()) err(`Node "${id}": "command" is required.`)
      break
    case 'commit': {
      const prep = machine.nodes[node.prep]
      if (!prep || prep.type !== 'agent') err(`Node "${id}": "prep" must name an agent node.`)
      else {
        const schema = resolveSchema(prep.output, machine.schemas)
        const properties = (schema?.properties ?? {}) as Record<string, unknown>
        if (!('commitMessage' in properties) || !('excluded' in properties)) err(`Node "${id}": prep node "${node.prep}" must output "commitMessage" and "excluded" (use the built-in "commitPrep" schema).`)
      }
      if (node.review !== 'algorithmic' && node.review !== 'agent') err(`Node "${id}": "review" must be "algorithmic" or "agent".`)
      if (node.review === 'agent') {
        if (!node.reviewer?.role) err(`Node "${id}": "reviewer.role" is required for agent review.`)
        else if (!env.roleExists(node.reviewer.role)) err(`Node "${id}": role file "${node.reviewer.role}" not found.`)
        const cli = node.reviewer?.cli ?? defaultCli
        if (!cli) err(`Node "${id}": reviewer has no "cli" and the machine has no default.`)
        else if (!env.headlessClis.includes(cli)) err(`Node "${id}": CLI "${cli}" does not support headless runs.`)
      }
      break
    }
    case 'gate':
      if (!node.question?.trim()) err(`Node "${id}": "question" is required.`)
      break
    case 'end':
      if (node.result !== 'success' && node.result !== 'failure') err(`Node "${id}": "result" must be "success" or "failure".`)
      break
  }
}

function validateAgent(id: string, node: AgentNode, machine: MachineDefinition, env: ValidationEnvironment, defaultCli: string | undefined, err: (m: string) => void): void {
  if (!node.summary?.trim()) err(`Node "${id}": "summary" is required — agents before it are told what it does.`)
  if (!node.role?.trim()) err(`Node "${id}": "role" is required.`)
  else if (!env.roleExists(node.role)) err(`Node "${id}": role file "${node.role}" not found.`)
  const cli = node.cli ?? defaultCli
  if (!cli) err(`Node "${id}": no "cli" and the machine has no default.`)
  else if (!env.headlessClis.includes(cli)) err(`Node "${id}": CLI "${cli}" does not support headless runs.`)
  if (node.permissions && node.permissions !== 'read-only' && node.permissions !== 'write') err(`Node "${id}": "permissions" must be "read-only" or "write".`)
  if (!node.output) err(`Node "${id}": "output" schema is required.`)
  else {
    const schema = resolveSchema(node.output, machine.schemas)
    if (!schema) err(`Node "${id}": output schema "${node.output}" is not defined.`)
    else if (cli === 'codex') for (const problem of strictSchemaProblems(schema)) err(`Node "${id}": schema "${node.output}" is not strict enough for Codex — ${problem}.`)
  }
  if (node.session && node.session !== 'new') {
    const match = /^continue:(.+)$/.exec(node.session)
    const target = match ? machine.nodes[match[1]] : undefined
    if (!target || target.type !== 'agent') err(`Node "${id}": "session" must be "new" or "continue:<agent node>".`)
    else if ((target.cli ?? defaultCli) !== cli) err(`Node "${id}": cannot continue a session of a different CLI.`)
  }
  for (const ref of node.inputs ?? []) validateRef(ref, machine, `Node "${id}" input`, err)
  for (const ref of templateRefs(node.task ?? '')) validateRef(ref, machine, `Node "${id}" task`, err)
}

const RUN_REFS = new Set(['diff', 'stagedDiff', 'changedFiles', 'iteration', 'id'])

function validateRef(ref: string, machine: MachineDefinition, where: string, err: (m: string) => void): void {
  const [root, first, second] = ref.split('.')
  if (root === 'params') {
    if (!first || !machine.params?.[first]) err(`${where}: unknown param "${first}".`)
  } else if (root === 'outputs') {
    const node = first ? machine.nodes[first] : undefined
    if (!node) { err(`${where}: unknown node "${first}" in "${ref}".`); return }
    if (second && node.type === 'agent') {
      const schema = resolveSchema(node.output, machine.schemas)
      const properties = (schema?.properties ?? {}) as Record<string, unknown>
      if (schema && !(second in properties)) err(`${where}: "${ref}" — "${second}" is not in the output schema of "${first}".`)
    }
  } else if (root === 'run') {
    if (!first || !RUN_REFS.has(first)) err(`${where}: unknown run value "${ref}". Known: ${[...RUN_REFS].map((r) => `run.${r}`).join(', ')}.`)
  } else err(`${where}: "${ref}" must start with params., outputs. or run.`)
}

function walk(start: string, next: (id: string) => string[]): Set<string> {
  const seen = new Set<string>([start])
  const stack = [start]
  while (stack.length) {
    for (const n of next(stack.pop()!)) if (!seen.has(n)) { seen.add(n); stack.push(n) }
  }
  return seen
}

/** Tarjan's algorithm. */
function stronglyConnected(ids: string[], next: (id: string) => string[]): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []
  const visit = (v: string): void => {
    indices.set(v, index); low.set(v, index); index++
    stack.push(v); onStack.add(v)
    for (const w of next(v)) {
      if (!indices.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, indices.get(w)!))
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = []
      let w: string
      do { w = stack.pop()!; onStack.delete(w); component.push(w) } while (w !== v)
      result.push(component)
    }
  }
  for (const id of ids) if (!indices.has(id)) visit(id)
  return result
}
