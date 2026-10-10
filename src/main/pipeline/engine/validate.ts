import { STEP_TYPES, walkSteps, type AgentStep, type MachineDefinition, type Step } from '../../../shared/pipelineMachine'
import { parseCondition, templateRefs } from './expressions'
import { resolveSchema, strictSchemaProblems } from './schema'
import { MachineTree, type TreeNode } from './tree'

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

const PARAM_TYPES = new Set(['string', 'string[]', 'path', 'glob[]', 'number', 'boolean'])
const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/

export function validateMachine(machine: MachineDefinition, env: ValidationEnvironment): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const err = (message: string): void => { errors.push(message) }

  if (!machine || typeof machine !== 'object') return { errors: ['Machine definition must be an object.'], warnings }
  if ('nodes' in machine || 'edges' in machine) {
    return { errors: ['This is the old graph format ("nodes"/"edges"). Machines are now a tree of "steps" — see pipeline_guide.'], warnings }
  }
  for (const field of ['id', 'name', 'description'] as const) {
    if (typeof machine[field] !== 'string' || !machine[field].trim()) err(`"${field}" is required.`)
  }
  if (!Array.isArray(machine.steps) || machine.steps.length === 0) return { errors: [...errors, '"steps" must be a non-empty array.'], warnings }

  for (const [name, param] of Object.entries(machine.params ?? {})) {
    if (!PARAM_TYPES.has(param?.type)) err(`Param "${name}": unknown type "${param?.type}".`)
  }

  // Shapes first: the tree is only meaningful for well-formed steps.
  let shapeOk = true
  const checkList = (steps: unknown, where: string, allowEmpty = false): void => {
    if (!Array.isArray(steps)) { err(`${where}: must be an array of steps.`); shapeOk = false; return }
    if (!allowEmpty && steps.length === 0) err(`${where}: must contain at least one step.`)
    for (const step of steps) {
      const s = step as Partial<Step> | null
      if (!s || typeof s !== 'object') { err(`${where}: every step must be an object.`); shapeOk = false; continue }
      if (!STEP_TYPES.includes(s.type as Step['type'])) { err(`Step "${s.id ?? '?'}": unknown type "${s.type}". Known: ${STEP_TYPES.join(', ')}.`); shapeOk = false; continue }
      if (typeof s.id !== 'string') { err(`A step of type "${s.type}" has no "id".`); shapeOk = false }
      else if (!ID.test(s.id)) err(`Step "${s.id}": invalid "id" ("${s.id}") — use letters, digits, "_" and "-".`)
      const label = `Step "${s.id}"`
      if (s.type === 'loop' || s.type === 'group') checkList((s as { steps?: unknown }).steps, `${label} "steps"`)
      if (s.type === 'if') {
        checkList((s as { then?: unknown }).then, `${label} "then"`)
        if ((s as { else?: unknown }).else !== undefined) checkList((s as { else?: unknown }).else, `${label} "else"`, true)
      }
      if (s.type === 'commit') {
        const prep = (s as { prep?: Partial<Step> }).prep
        if (!prep || typeof prep !== 'object' || prep.type !== 'agent') { err(`${label}: "prep" must be an agent step (it stages the change and writes the message).`); shapeOk = false }
        else if (typeof prep.id !== 'string' || !ID.test(prep.id)) { err(`${label}: "prep" needs a valid "id".`); shapeOk = false }
      }
    }
  }
  checkList(machine.steps, '"steps"')
  if (!shapeOk) return { errors, warnings }

  const tree = new MachineTree(machine)
  for (const id of new Set(tree.duplicates)) err(`Step id "${id}" is used more than once.`)

  const defaultCli = machine.defaults?.cli
  const nodeOf = (step: Step): TreeNode | undefined => step.type === 'agent' || step.type === 'check' || step.type === 'gate' || step.type === 'repeat' ? tree.leaves.get(step.id) : tree.blocks.get(step.id)

  walkSteps(machine.steps, (step) => {
    const node = nodeOf(step)
    if (!node) return
    const label = `Step "${step.id}"`
    const repeatable = tree.repeatable(node)

    const checkRepeat = (repeatIf: string | undefined, repeatLoop: string | undefined): void => {
      if (repeatIf !== undefined) checkCondition(repeatIf, `${label} "repeatIf"`)
      if ((repeatIf !== undefined || repeatLoop !== undefined) && repeatable.length === 0) err(`${label}: "repeatIf"/"repeatLoop" only work inside a loop.`)
      if (repeatLoop !== undefined && !tree.ancestors(node).some((b) => b.kind === 'loop' && b.id === repeatLoop)) err(`${label}: "repeatLoop" must name an enclosing loop ("${repeatLoop}" is not one).`)
    }
    const checkCondition = (condition: string, where: string): void => {
      const parsed = parseCondition(condition)
      if ('error' in parsed) err(`${where}: ${parsed.error}`)
      else validateRef(parsed.ref, machine, tree, node, where, err, warnings)
    }

    switch (step.type) {
      case 'agent':
        validateAgent(step, tree, node, machine, env, defaultCli, err, warnings)
        checkRepeat(step.repeatIf, step.repeatLoop)
        if (step.escalateIf !== undefined) checkCondition(step.escalateIf, `${label} "escalateIf"`)
        if (step.escalateTo !== undefined && step.escalateTo !== 'user' && step.escalateTo !== 'orchestrator') err(`${label}: "escalateTo" must be "user" or "orchestrator".`)
        break
      case 'check':
        if (typeof step.command !== 'string' || !step.command.trim()) err(`${label}: "command" is required.`)
        checkRepeat(undefined, step.repeatLoop)
        break
      case 'gate':
        if (typeof step.question !== 'string' || !step.question.trim()) err(`${label}: "question" is required.`)
        if (step.to !== undefined && step.to !== 'user' && step.to !== 'orchestrator') err(`${label}: "to" must be "user" or "orchestrator".`)
        checkRepeat(undefined, step.repeatLoop)
        break
      case 'repeat':
        if (typeof step.loop !== 'string' || !tree.ancestors(node).some((b) => b.kind === 'loop' && b.id === step.loop)) err(`${label}: "loop" must name an enclosing loop ("${step.loop ?? ''}" is not one).`)
        break
      case 'loop': {
        if (!Number.isInteger(step.maxIterations) || step.maxIterations < 1) err(`${label}: "maxIterations" must be a positive integer — every loop needs a bound.`)
        if (step.onLimit !== undefined && step.onLimit !== 'escalate' && step.onLimit !== 'fail') err(`${label}: "onLimit" must be "escalate" or "fail".`)
        const block = tree.blocks.get(step.id)!
        const repeats = tree.leavesIn(block).some((id) => {
          const leaf = tree.leaves.get(id)!.step
          return leaf.type === 'check' || leaf.type === 'gate' || leaf.type === 'repeat' || (leaf.type === 'agent' && leaf.repeatIf !== undefined)
        })
        if (!repeats) warnings.push(`${label}: nothing inside the loop can repeat it (no check, gate, repeat step or "repeatIf"), so it always runs once.`)
        break
      }
      case 'if':
        checkCondition(step.condition, `${label} "condition"`)
        break
      case 'commit': {
        const prepSchema = resolveSchema(step.prep.output, machine.schemas)
        const properties = (prepSchema?.properties ?? {}) as Record<string, unknown>
        if (prepSchema && (!('commitMessage' in properties) || !('excluded' in properties))) err(`${label}: its prep step "${step.prep.id}" must output "commitMessage" and "excluded" (use the built-in "commitPrep" schema).`)
        if (step.review !== 'algorithmic' && step.review !== 'agent') err(`${label}: "review" must be "algorithmic" or "agent".`)
        if (step.maxAttempts !== undefined && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1)) err(`${label}: "maxAttempts" must be a positive integer.`)
        if (step.onLimit !== undefined && step.onLimit !== 'escalate' && step.onLimit !== 'fail') err(`${label}: "onLimit" must be "escalate" or "fail".`)
        if (step.review === 'agent') {
          if (!step.reviewer?.role) err(`${label}: "reviewer.role" is required for agent review.`)
          else if (!env.roleExists(step.reviewer.role)) err(`${label}: role file "${step.reviewer.role}" not found.`)
          const cli = step.reviewer?.cli ?? defaultCli
          if (!cli) err(`${label}: the reviewer has no "cli" and the machine has no default.`)
          else if (!env.headlessClis.includes(cli)) err(`${label}: CLI "${cli}" does not support headless runs.`)
        }
        break
      }
    }
  })

  return { errors, warnings }
}

function validateAgent(step: AgentStep, tree: MachineTree, node: TreeNode, machine: MachineDefinition, env: ValidationEnvironment, defaultCli: string | undefined, err: (m: string) => void, warnings: string[]): void {
  const label = `Step "${step.id}"`
  if (!step.summary?.trim()) err(`${label}: "summary" is required — the other agents are told what it does.`)
  if (!step.role?.trim()) err(`${label}: "role" is required.`)
  else if (!env.roleExists(step.role)) err(`${label}: role file "${step.role}" not found.`)
  const cli = step.cli ?? defaultCli
  if (!cli) err(`${label}: no "cli" and the machine has no default.`)
  else if (!env.headlessClis.includes(cli)) err(`${label}: CLI "${cli}" does not support headless runs.`)
  if (step.permissions && step.permissions !== 'read-only' && step.permissions !== 'write') err(`${label}: "permissions" must be "read-only" or "write".`)
  if (!step.output) err(`${label}: "output" schema is required.`)
  else {
    const schema = resolveSchema(step.output, machine.schemas)
    if (!schema) err(`${label}: output schema "${step.output}" is not defined.`)
    else if (cli === 'codex') for (const problem of strictSchemaProblems(schema)) err(`${label}: schema "${step.output}" is not strict enough for Codex — ${problem}.`)
  }
  if (step.session && step.session !== 'keep' && step.session !== 'new') {
    const match = /^continue:(.+)$/.exec(step.session)
    const target = match ? tree.leaves.get(match[1]) : undefined
    if (!target || target.step.type !== 'agent') err(`${label}: "session" must be "keep", "new" or "continue:<agent step>".`)
    else {
      if ((target.step.cli ?? defaultCli) !== cli) err(`${label}: cannot continue a session of a different CLI.`)
      if (node.kind === 'leaf' && target.order >= node.order) err(`${label}: "continue:${target.id}" must name a step that runs earlier.`)
    }
  }
  for (const ref of step.inputs ?? []) validateRef(ref, machine, tree, node, `${label} input`, err, warnings)
  for (const ref of templateRefs(step.task ?? '')) validateRef(ref, machine, tree, node, `${label} task`, err, warnings)
}

const RUN_REFS = new Set(['diff', 'stagedDiff', 'changedFiles', 'iteration', 'id'])

function validateRef(ref: string, machine: MachineDefinition, tree: MachineTree, from: TreeNode, where: string, err: (m: string) => void, warnings: string[]): void {
  const [root, first, second] = String(ref).split('.')
  if (root === 'params') {
    if (!first || !machine.params?.[first]) err(`${where}: unknown param "${first ?? ''}".`)
  } else if (root === 'outputs') {
    const leaf = first ? tree.leaves.get(first) : undefined
    if (!leaf) { err(`${where}: unknown step "${first}" in "${ref}".`); return }
    if (second && leaf.step.type === 'agent') {
      const schema = resolveSchema(leaf.step.output, machine.schemas)
      const properties = (schema?.properties ?? {}) as Record<string, unknown>
      if (schema && !(second in properties)) err(`${where}: "${ref}" — "${second}" is not in the output schema of "${first}".`)
    }
    if (from.kind === 'leaf' && leaf.order >= from.order && !sharesLoop(tree, leaf, from)) {
      warnings.push(`${where}: "${ref}" refers to a step that has not run yet at that point; it will be empty.`)
    }
  } else if (root === 'run') {
    if (!first || !RUN_REFS.has(first)) err(`${where}: unknown run value "${ref}". Known: ${[...RUN_REFS].map((r) => `run.${r}`).join(', ')}.`)
  } else err(`${where}: "${ref}" must start with params., outputs. or run.`)
}

function sharesLoop(tree: MachineTree, a: TreeNode, b: TreeNode): boolean {
  const loops = new Set(tree.repeatable(a))
  return tree.repeatable(b).some((block) => loops.has(block))
}
