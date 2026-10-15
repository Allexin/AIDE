import type { AgentStep, MachineDefinition, Step } from '../../../shared/pipelineMachine'
import type { LoopFeedback, RunState } from './types'
import { parseCondition, renderTemplate, resolveRef, stringifyValue, type Scope } from './expressions'
import { MachineTree, blockLimit, blockName, type LeafStep, type TreeNode } from './tree'

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

/** The step tree as an indented outline with numbered leaves. */
function outline(tree: MachineTree, current: string, state: RunState): string[] {
  const lines: string[] = []
  const numbers = new Map(tree.order.map((id, i) => [id, i + 1]))
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
        const what = node.kind === 'commit' ? `commit ${node.id} (up to ${blockLimit(node)} attempts)` : `loop ${node.id}${name} (repeats until a pass completes, at most ${blockLimit(node)} iterations)`
        const now = iteration ? ` — now on ${node.kind === 'commit' ? 'attempt' : 'iteration'} ${iteration}` : ''
        lines.push(`${pad}- ${what}${step.summary ? `: ${step.summary}` : ''}${now}`)
        walk(node.lists[0] ?? [], depth + 1)
      } else if (node.kind === 'group') {
        lines.push(`${pad}- ${blockName(node)}${step.summary ? `: ${step.summary}` : ''}`)
        walk(node.lists[0] ?? [], depth + 1)
      } else if (node.kind === 'if' && step.type === 'if') {
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

export function buildPipelineContext(machine: MachineDefinition, current: string, state: RunState): string {
  const tree = new MachineTree(machine)
  const leaf = tree.leaves.get(current)
  const lines: string[] = []
  lines.push(`You are one step of the AIDE pipeline "${machine.name}". AIDE runs the steps top to bottom; each step is done by its own performer. Loops start over when a step inside asks for another iteration. The pipeline:`)
  lines.push(...outline(tree, current, state))
  if (!leaf) return lines.join('\n')

  // Steps that can run after this one: everything later in document order, plus
  // the whole body of every enclosing loop (it runs again on a repeat).
  const loops = tree.repeatable(leaf)
  const later = new Set(tree.order.slice(leaf.order + 1))
  for (const loop of loops) for (const id of tree.leavesIn(loop)) if (id !== current) later.add(id)
  const laterSteps = [...later].map((id) => tree.leaves.get(id)!.step)
  const checks = laterSteps.filter((s): s is Extract<Step, { type: 'check' }> => s.type === 'check')
  const isCommitPrep = leaf.parent.kind === 'commit' && leaf.step.type === 'agent'
  const commitLater = laterSteps.some((s) => s.type === 'commit')

  lines.push('', 'What happens after you — do not do this work yourself:')
  const next = tree.order[leaf.order + 1]
  if (next) lines.push(`- Next in order: ${next} — ${stepSummary(tree.leaves.get(next)!.step)}.`)
  else lines.push('- You are the last step; the run ends after you.')
  if (checks.length) lines.push(`- AIDE itself runs these checks later: ${checks.map((c) => `\`${c.command}\``).join(', ')}. Do not run them; if they fail, the failure output comes back to the steps that must fix it.`)
  if (isCommitPrep) lines.push('- You prepare the commit (stage files, write the message); AIDE reviews it and commits. Do not commit yourself.')
  else if (commitLater) lines.push('- Staging and committing happen in a later step. Do not stage or commit.')
  if (loops.length && leaf.step.type === 'agent') lines.push('- You are inside a loop. It exists so that problems a later step finds come back to be fixed — not to continue unfinished work. Finish your whole task in this visit.')

  if (leaf.step.type === 'agent') {
    const minutes = leaf.step.timeoutMin ?? machine.defaults?.timeoutMin ?? DEFAULT_TIMEOUT_MIN
    lines.push(`- Your only limit in this step is time: ${minutes} minutes. There is no token or work budget beyond that, and large tasks are expected here.`)
    if ((leaf.step.permissions ?? 'write') === 'write') lines.push('- For a large task, plan the increments, then implement all of them now.')
  }

  lines.push('', 'Before you:')
  const visit = state.visits[current] ?? 1
  lines.push(`- This is visit ${visit} of "${current}" in run ${state.runId}.`)
  for (const loop of [...loops].reverse()) {
    const iteration = state.iterations[loop.id]
    if (iteration) lines.push(`- ${loop.kind === 'commit' ? 'Commit' : 'Loop'} "${loop.id}": ${loop.kind === 'commit' ? 'attempt' : 'iteration'} ${iteration} of at most ${blockLimit(loop) + (state.bonus[loop.id] ?? 0)}.`)
  }
  const previous = [...state.history].reverse().find((h) => h.finishedAt && !(h.node === current && h.visit === visit))
  if (previous) lines.push(`- The previous step was "${previous.node}" (visit ${previous.visit}), outcome: ${previous.outcome ?? 'unknown'}.`)
  else lines.push('- You are the first step of this run.')
  const decisions = state.escalations.filter((e) => e.answer && e.answer.text.trim())
  for (const e of decisions) lines.push(`- Decision by the ${e.answer!.by} at "${e.node}" (${e.answer!.action}): ${e.answer!.text.trim()}`)
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

/** Feedback sections for the loops an agent is in, outermost first. */
export function feedbackSections(machine: MachineDefinition, current: string, state: RunState): string[] {
  const tree = new MachineTree(machine)
  const leaf = tree.leaves.get(current)
  if (!leaf) return []
  return tree.repeatable(leaf).reverse().flatMap((loop) => {
    const feedback: LoopFeedback | undefined = state.feedback[loop.id]
    if (!feedback || (state.iterations[loop.id] ?? 1) < 2) return []
    const what = loop.kind === 'commit' ? `attempt ${feedback.iteration} of commit "${loop.id}"` : `iteration ${feedback.iteration} of loop "${loop.id}"`
    return [`## Feedback: this is ${what}\n\nThe previous pass was repeated because ${feedback.reason}.\n\n${feedback.details || '(no details)'}`]
  })
}

/** The user message for an agent step: its task, the loop feedback and the declared inputs. */
export function buildTaskPrompt(step: AgentStep, scope: Scope, feedback: string[] = []): string {
  const parts: string[] = []
  parts.push(step.task ? renderTemplate(step.task, scope) : 'Do the work of your role for this pipeline step.')
  parts.push(...feedback)
  for (const ref of step.inputs ?? []) {
    const value = stringifyValue(resolveRef(ref, scope))
    parts.push(`## ${ref}\n\n${value || '(empty)'}`)
  }
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
