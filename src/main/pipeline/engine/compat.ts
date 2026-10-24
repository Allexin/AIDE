import type { MachineDefinition } from './types'

/**
 * Engine versions for machine files. A machine declares the engine version it
 * was written (or last reviewed) for in `engineVersion`. When AIDE changes how
 * machines or their role files behave, the version goes up and the change is
 * listed here with what an author must do. Starting a machine written for an
 * older version is refused until it is reviewed (or the start is forced), so a
 * run does not silently behave differently after an AIDE update.
 *
 * Bump ENGINE_VERSION only for changes that can make an existing machine or
 * role file behave differently or wrongly — not for new optional features.
 */

export interface EngineChange {
  version: number
  /** What changed for machines and role files. */
  changes: string[]
  /** What the author has to check or edit. */
  actions: string[]
}

export const ENGINE_CHANGES: readonly EngineChange[] = [
  {
    version: 1,
    changes: ['Machines are a tree of "steps" (loop, group, if, repeat, commit); the graph format ("nodes"/"edges") is gone.'],
    actions: ['Rewrite graph machines as a step tree (pipeline_guide).']
  },
  {
    version: 2,
    changes: [
      'Reasoning effort is a step / defaults setting ("effort"). Codex steps without one use the model and effort of the user\'s Codex config instead of the model\'s built-in default.',
      'implementerReport "blocked" means a named external obstacle; the size of a task is not one.'
    ],
    actions: ['Set "effort" where a step needs more (or less) than the default.']
  },
  {
    version: 3,
    changes: [
      'The pipeline context states facts only. It no longer tells agents to finish the whole task in the visit, to plan increments and implement all of them, or how to report pipeline problems.',
      'The built-in schemas implementerReport, reviewVerdict and commitPrep have a required "pipelineIssues" array.',
      'The context says later checks "need not" be run (it said "do not run them").',
      'run.iteration in an "if" is the iteration of the loop around the "if" (it was the loop of the step that ran before).',
      'A gate rejected outside loops holds the run at the gate instead of failing it.',
      'Check commands expand {{params.x}} / {{outputs.step.field}}.'
    ],
    actions: [
      'Implementer roles: add "Finish the whole task in this visit; a loop repeats only to fix what later steps find" and "plan the increments and implement all of them" if you relied on the context for it (see the starter roles in pipeline_guide §8).',
      'All roles: say that problems with the pipeline itself go into "pipelineIssues"; stop writing "PIPELINE ISSUE" into non_blocking or excluded.',
      'Check every "if" condition that uses run.iteration.',
      'A check command that contains "{{" literally must be rewritten.'
    ]
  },
  {
    version: 4,
    changes: [
      'Claude Code steps start without MCP servers: neither the servers of the user nor claude.ai connectors reach step agents (Codex steps already ran without the user config).',
      'The context resolves an "if" whose condition uses only params and shows just the branch that runs (numbering, "Next in order" and the later checks follow it).',
      'An input over 100,000 characters is saved to a file under the run directory; the prompt gets its path and a file list instead of the value.'
    ],
    actions: [
      'A role that relied on an MCP tool in a Claude Code step must do without it.',
      'Inputs that bring in noise (regenerated golden files in run.diff) can be filtered: {"ref": "run.diff", "exclude": ["<glob>"]}.'
    ]
  }
]

export const ENGINE_VERSION = ENGINE_CHANGES[ENGINE_CHANGES.length - 1].version

/** The changes since the version a machine was written for (all of them when it declares none). */
export function changesSince(version: number | undefined): EngineChange[] {
  return ENGINE_CHANGES.filter((change) => change.version > (version ?? 0))
}

/** A machine written for an older engine, or null when it is current. */
export function outdatedMachine(machine: MachineDefinition): { declared: number | null; changes: EngineChange[] } | null {
  const declared = typeof machine.engineVersion === 'number' ? machine.engineVersion : null
  if (declared !== null && declared >= ENGINE_VERSION) return null
  return { declared, changes: changesSince(declared ?? undefined) }
}

/** The text the orchestrator gets when it starts an outdated machine. */
export function outdatedMessage(machine: MachineDefinition): string | null {
  const outdated = outdatedMachine(machine)
  if (!outdated) return null
  const lines = [
    `Machine "${machine.id}" was written for AIDE pipeline engine ${outdated.declared ?? '(not declared)'}; this AIDE runs engine ${ENGINE_VERSION}. It may not work as intended. Changes since then:`
  ]
  for (const change of outdated.changes) {
    lines.push(`Engine ${change.version}:`)
    for (const c of change.changes) lines.push(`- ${c}`)
    for (const a of change.actions) lines.push(`- To do: ${a}`)
  }
  lines.push(`Review the machine and its role files, then set "engineVersion": ${ENGINE_VERSION} in it (do this with the user — the files are shared). To run it unchanged anyway, call pipeline_start again with "acceptOutdated": true.`)
  return lines.join('\n')
}
