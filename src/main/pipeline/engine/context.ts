import type { AgentStep, MachineDefinition, Step } from '../../../shared/pipelineMachine'
import type { LoopFeedback, RunState } from './types'
import { evaluateCondition, parseCondition, renderTemplate, resolveRef, type Scope } from './expressions'
import { renderInputs } from './inputs'
import { MachineTree, blockLimit, blockName, type LeafStep, type TreeBlock, type TreeNode } from './tree'

/**
 * Prompt composition for agent steps (plan §3.1). Besides its role, every agent
 * gets a generated **pipeline context**: the whole step tree with its position
 * marked, what the later steps do (so it does not duplicate work — e.g. the
 * implementer does not run checks that a check step runs), the loops it is in,
 * and what happened before this visit.
 */

/** One line about a leaf; for a commit step this describes its commit action. */
export const DEFAULT_TIMEOUT_MIN = 60

export function stepSummary(step: LeafStep): string {
  if (step.type === 'commit') {
    return `AIDE reviews the prepared commit (${step.review === 'agent' ? 'reviewer agent' : 'automatic checks'}) and commits it; problems go back to "${step.prep?.id}"`
  }
  if (step.summary?.trim()) return step.summary.trim()
  switch (step.type) {
    case 'repeat': return `AIDE starts loop "${step.loop}" over${step.reason ? `: ${step.reason}` : ''}`
    case 'check': return `AIDE runs \`${step.command}\``
    case 'gate': return `waits for approval: ${step.question}`
    case 'agent': return `agent step "${step.id}"`
  }
}

function performer(step: LeafStep): string {
  return step.type === 'agent' ? 'agent' : step.type === 'gate' ? `approval by the ${step.to ?? 'orchestrator'}` : 'AIDE'
}

export function describeCondition(condition: string): string {
  const parsed = parseCondition(condition)
  if ('error' in parsed) return condition
  const field = parsed.ref.split('.').slice(-1)[0]
  return `${field} ${parsed.op === '==' ? 'is' : 'is not'} ${JSON.stringify(parsed.literal)}`
}

/** What a leaf does to its loop, as one clause. */
function repeatNote(tree: MachineTree, id: string): string {
  const leaf = tree.leaves.get(id)!
  const step = leaf.step
  const loops = tree.repeatable(leaf)
  if (loops.length === 0) {
    if (step.type === 'check') return '; a failure stops the run for a decision'
    return ''
  }
  const target = (name: string | undefined): string => {
    const block = name ? tree.blocks.get(name) : loops[0]
    return block ? `"${blockName(block)}"` : 'the loop'
  }
  if (step.type === 'check') return `; a failure repeats ${target(step.repeatLoop)}`
  if (step.type === 'gate') return `; rejecting repeats ${target(step.repeatLoop)}`
  if (step.type === 'commit' || step.type === 'repeat') return ''
  const notes: string[] = []
  if (step.repeatIf) notes.push(`repeats ${target(step.repeatLoop)} if ${describeCondition(step.repeatIf)}`)
  if (step.escalateIf) notes.push(`stops for a decision if ${describeCondition(step.escalateIf)}`)
  return notes.length ? `; ${notes.join('; ')}` : ''
}

/**
 * The branch an `if` takes when its condition depends only on params, which are
 * fixed for the run: the context then shows only that branch (an implementer
 * was told the next check is `ciFull` while the run took the `else` with `ci`).
 */
function fixedBranch(node: TreeBlock, params: Record<string, unknown> | undefined): { list: 0 | 1; ref: string; value: unknown } | undefined {
  const step = node.step
  if (!params || node.kind !== 'if' || step?.type !== 'if') return undefined
  const parsed = parseCondition(step.condition)
  if ('error' in parsed || !parsed.ref.startsWith('params.')) return undefined
  const scope: Scope = { params, outputs: {}, run: {} }
  return { list: evaluateCondition(step.condition, scope) ? 0 : 1, ref: parsed.ref, value: resolveRef(parsed.ref, scope) }
}

/** Leaves in `if` branches that the params rule out for this run. */
function skippedLeaves(tree: MachineTree, params: Record<string, unknown> | undefined): Set<string> {
  const skipped = new Set<string>()
  const collect = (nodes: TreeNode[]): void => { for (const n of nodes) n.kind === 'leaf' ? skipped.add(n.id) : n.lists.forEach(collect) }
  const visit = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'leaf') continue
      const fixed = fixedBranch(n, params)
      n.lists.forEach((list, i) => (fixed && i !== fixed.list ? collect(list) : visit(list)))
    }
  }
  visit(tree.root.lists[0] ?? [])
  return skipped
}

/** The step tree as an indented outline with numbered leaves. */
function outline(tree: MachineTree, current: string, state: RunState, params: Record<string, unknown> | undefined, skipped: Set<string>): string[] {
  const lines: string[] = []
  const numbers = new Map(tree.order.filter((id) => !skipped.has(id)).map((id, i) => [id, i + 1]))
  const currentLeaf = tree.leaves.get(current)
  const enclosing = new Set(currentLeaf ? tree.repeatable(currentLeaf).map((b) => b.id) : [])
  const walk = (nodes: TreeNode[], depth: number): void => {
    const pad = '  '.repeat(depth)
    for (const node of nodes) {
      if (node.kind === 'leaf') {
        const marker = node.id === current ? '   ← YOU ARE HERE' : ''
        lines.push(`${pad}${numbers.get(node.id)}. ${node.id} [${performer(node.step)}] — ${stepSummary(node.step)}${repeatNote(tree, node.id)}${marker}`)
        continue
      }
      const step = node.step!
      const iteration = enclosing.has(node.id) ? state.iterations[node.id] : undefined
      if (node.kind === 'loop' || node.kind === 'commit') {
        const name = node.kind === 'loop' && blockName(node) !== node.id ? ` "${blockName(node)}"` : ''
        const limit = blockLimit(node) + (state.bonus?.[node.id] ?? 0)
        const what = node.kind === 'commit' ? `commit ${node.id} (up to ${limit} attempts)` : `loop ${node.id}${name} (repeats until a pass completes, at most ${limit} iterations)`
        const now = iteration ? ` — now on ${node.kind === 'commit' ? 'attempt' : 'iteration'} ${iteration}` : ''
        lines.push(`${pad}- ${what}${step.summary ? `: ${step.summary}` : ''}${now}`)
        walk(node.lists[0] ?? [], depth + 1)
      } else if (node.kind === 'group') {
        lines.push(`${pad}- ${blockName(node)}${step.summary ? `: ${step.summary}` : ''}`)
        walk(node.lists[0] ?? [], depth + 1)
      } else if (node.kind === 'if' && step.type === 'if') {
        const fixed = fixedBranch(node, params)
        if (fixed) {
          const chosen = node.lists[fixed.list] ?? []
          if (chosen.length) {
            lines.push(`${pad}- ${fixed.ref.split('.').slice(-1)[0]} is ${JSON.stringify(fixed.value ?? null)} in this run, so:`)
            walk(chosen, depth + 1)
          }
          continue
        }
        lines.push(`${pad}- if ${describeCondition(step.condition)}:`)
        walk(node.lists[0] ?? [], depth + 1)
        if ((node.lists[1] ?? []).length) {
          lines.push(`${pad}- otherwise:`)
          walk(node.lists[1], depth + 1)
        }
      }
    }
  }
  walk(tree.root.lists[0] ?? [], 0)
  return lines
}

export function buildPipelineContext(machine: MachineDefinition, current: string, state: RunState, params?: Record<string, unknown>): string {
  const tree = new MachineTree(machine)
  const leaf = tree.leaves.get(current)
  // Params changed by an answer can rule out the branch the run is already in: show all branches then.
  if (skippedLeaves(tree, params).has(current)) params = undefined
  const skipped = skippedLeaves(tree, params)
  const lines: string[] = []
  lines.push(`You are one step of the AIDE pipeline "${machine.name}". AIDE runs the steps top to bottom; each step is done by its own performer. Loops start over when a step inside asks for another iteration. The pipeline:`)
  lines.push(...outline(tree, current, state, params, skipped))
  if (!leaf) return lines.join('\n')

  // Steps that can run after this one: everything later in document order, plus
  // the whole body of every enclosing loop (it runs again on a repeat).
  const loops = tree.repeatable(leaf)
  const later = new Set(tree.order.slice(leaf.order + 1).filter((id) => !skipped.has(id)))
  for (const loop of loops) for (const id of tree.leavesIn(loop)) if (id !== current && !skipped.has(id)) later.add(id)
  const laterSteps = [...later].map((id) => tree.leaves.get(id)!.step)
  const checks = laterSteps.filter((s): s is Extract<Step, { type: 'check' }> => s.type === 'check')
  const isCommitPrep = leaf.parent.kind === 'commit' && leaf.step.type === 'agent'
  const commitLater = laterSteps.some((s) => s.type === 'commit')

  lines.push('', 'What happens after you — do not do this work yourself:')
  const next = tree.order.slice(leaf.order + 1).find((id) => !skipped.has(id))
  if (next) lines.push(`- Next in order: ${next} — ${stepSummary(tree.leaves.get(next)!.step)}.`)
  else lines.push('- You are the last step; the run ends after you.')
  if (checks.length) lines.push(`- AIDE itself runs these checks later: ${checks.map((c) => `\`${c.command}\``).join(', ')}. You need not run them: if they fail, the failure output comes back to the steps that must fix it. Run one yourself only when your task or a decision explicitly asks for it.`)
  if (isCommitPrep) lines.push('- You prepare the commit (stage files, write the message); AIDE reviews it and commits. Do not commit yourself.')
  else if (commitLater) lines.push('- Staging and committing happen in a later step. Do not stage or commit.')
  // Facts about the machine and the engine only. How an agent should work (finish
  // everything now, plan increments, …) belongs in its role file: AIDE does not
  // know a step's purpose and would have to guess it.
  if (loops.length && leaf.step.type === 'agent') lines.push('- You are inside a loop: it starts over only when a later step reports a problem, and the steps then get that problem as feedback.')
  if (leaf.step.type === 'agent') lines.push(`- Time limit of this step: ${leaf.step.timeoutMin ?? machine.defaults?.timeoutMin ?? DEFAULT_TIMEOUT_MIN} minutes.`)

  lines.push('', 'Before you:')
  const visit = state.visits[current] ?? 1
  lines.push(`- This is visit ${visit} of "${current}" in run ${state.runId}.`)
  for (const loop of [...loops].reverse()) {
    const iteration = state.iterations[loop.id]
    if (iteration) lines.push(`- ${loop.kind === 'commit' ? 'Commit' : 'Loop'} "${loop.id}": ${loop.kind === 'commit' ? 'attempt' : 'iteration'} ${iteration} of at most ${blockLimit(loop) + (state.bonus[loop.id] ?? 0)}.`)
  }
  const sofar = iterationResults(tree, loops, current, state)
  if (sofar) lines.push(`- Results so far in this pass: ${sofar}. These are the current results; feedback from earlier passes may be outdated.`)
  const previous = [...state.history].reverse().find((h) => h.finishedAt && !(h.node === current && h.visit === visit))
  if (previous) lines.push(`- The previous step was "${previous.node}" (visit ${previous.visit}), outcome: ${previous.outcome ?? 'unknown'}.`)
  else lines.push('- You are the first step of this run.')
  for (const e of state.escalations) {
    const changed = Object.entries(e.answer?.params ?? {}).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    if (!e.answer || (!e.answer.text.trim() && !changed.length)) continue
    lines.push(`- Decision by the ${e.answer.by} at "${e.node}" (${e.answer.action}): ${e.answer.text.trim()}${changed.length ? `${e.answer.text.trim() ? ' ' : ''}(params changed for the rest of the run: ${changed.join(', ')})` : ''}`)
  }
  for (const a of state.amendments ?? []) lines.push(`- Instruction from the ${a.by}${a.node ? ` (given during "${a.node}")` : ''}: ${a.text.trim()}`)
  return lines.join('\n')
}

/** History index where the outermost enclosing loop's current pass started, if known. */
function passStart(loops: TreeBlock[], state: RunState): number | undefined {
  for (const loop of [...loops].reverse()) {
    const start = state.iterationStart?.[loop.id]
    if (start !== undefined) return start
  }
  return undefined
}

/** Latest outcome of each step that finished in the current pass of the enclosing loops, e.g. "ci passed, review: reject". */
function iterationResults(tree: MachineTree, loops: TreeBlock[], current: string, state: RunState): string {
  const start = passStart(loops, state)
  if (start === undefined) return ''
  const latest = new Map<string, string>()
  for (const h of state.history.slice(start)) {
    if (h.node === current || !h.finishedAt || h.outcome === 'interrupted' || !h.outcome) continue
    const step = tree.leaves.get(h.node)?.step
    if (!step) continue
    const output = state.outputs[h.node] as Record<string, unknown> | null | undefined
    const detail = typeof output?.verdict === 'string' ? `: ${output.verdict}` : typeof output?.status === 'string' ? `: ${output.status}` : ''
    latest.delete(h.node) // keep the order of the latest runs
    latest.set(h.node, step.type === 'check' ? `${h.node} ${h.outcome === 'ok' ? 'passed' : 'failed'}` : step.type === 'agent' ? `${h.node}${detail}` : `${h.node} ${h.outcome}`)
  }
  return [...latest.values()].join(', ')
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

/** Feedback sections for the loops an agent is in, outermost first. */
export function feedbackSections(machine: MachineDefinition, current: string, state: RunState): string[] {
  const tree = new MachineTree(machine)
  const leaf = tree.leaves.get(current)
  if (!leaf) return []
  return tree.repeatable(leaf).reverse().flatMap((loop) => {
    const feedback: LoopFeedback | undefined = state.feedback[loop.id]
    if (!feedback || (state.iterations[loop.id] ?? 1) < 2) return []
    const what = loop.kind === 'commit' ? `attempt ${feedback.iteration} of commit "${loop.id}"` : `iteration ${feedback.iteration} of loop "${loop.id}"`
    // The step that asked for this pass has run again in it: its complaint is history now.
    const start = state.iterationStart?.[loop.id]
    const rerun = start === undefined ? undefined : state.history.slice(start).filter((h) => h.node === feedback.from && h.finishedAt && h.outcome && h.outcome !== 'interrupted').at(-1)
    const superseded = rerun ? `\n\nSuperseded: "${feedback.from}" has run again in this pass (outcome: ${rerun.outcome === 'ok' ? (tree.leaves.get(feedback.from)?.step.type === 'check' ? 'passed' : 'ok') : 'failed'}). The feedback below is what started this pass, not the current state.` : ''
    return [`## Feedback: this is ${what}\n\nThe previous pass was repeated because ${feedback.reason}.${superseded}\n\n${feedback.details || '(no details)'}`]
  })
}

/**
 * The user message for an agent step: its task, the loop feedback and the
 * declared inputs. `save` writes an input too large for the prompt to a file.
 */
export function buildTaskPrompt(step: AgentStep, scope: Scope, feedback: string[] = [], save: (name: string, text: string) => string = () => '(not saved)'): string {
  const parts: string[] = []
  parts.push(step.task ? renderTemplate(step.task, scope) : 'Do the work of your role for this pipeline step.')
  parts.push(...feedback)
  parts.push(...renderInputs(step.inputs ?? [], scope, save))
  return parts.join('\n\n')
}

/**
 * Header for a step that continues another step's CLI session: the conversation
 * already holds the previous step's instructions, so the new step is restated in
 * the user message and declared to take precedence.
 */
export function stepSwitchPrompt(previousNode: string, node: string, summary: string, roleText: string, context: string, contract: string): string {
  return [
    `# New step: ${node}`,
    `You are no longer doing the step "${previousNode}". You are now performing the step "${node}" of the pipeline: ${summary}. Where the instructions of "${previousNode}" conflict with this step, this step wins.`,
    '## Your role for this step',
    roleText.trim(),
    '## Pipeline context',
    context,
    '## Output',
    contract,
    '## This step'
  ].join('\n\n')
}

export function invalidOutputPrompt(errors: string[]): string {
  return [
    'Your previous final answer did not match the required output schema:',
    ...errors.map((e) => `- ${e}`),
    'Reply again with only the corrected JSON object.'
  ].join('\n')
}
