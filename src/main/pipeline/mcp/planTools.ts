import type { ToolDefinition, ToolResult } from './protocol'
import type { PlanService } from '../plan/planService'
import type { PlanOp } from '../plan/planFile'

/**
 * Plan MCP tools: the Strategist's interface to plans (docs/plan-mode-spec.md).
 * As with the pipeline tools, results are compact: what a call changed, not the
 * whole plan, since everything returned stays in the caller's context.
 */

export interface PlanToolEnvironment {
  plans?: PlanService
  guide?: () => string
  /** Block until the project's next event after `since`; the text of the result. */
  waitAfter(projectPath: string, tabId: string | null, since: number, seconds: unknown): Promise<string>
  /** The id of the project's last event, to wait from. */
  lastEvent(projectPath: string): number
}

const OBJECT = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false })

const PLAN_ID = { type: 'string', description: 'Plan id; defaults to the active plan.' }

const TASK_SCHEMA = OBJECT({
  id: { type: 'string' },
  title: { type: 'string' },
  status: { type: 'string', enum: ['pending', 'done', 'blocked', 'dropped'], description: 'Default pending.' },
  reason: { type: 'string', description: 'Why it is blocked or dropped.' },
  phase: { type: 'string' },
  after: { type: 'array', items: { type: 'string' }, description: 'Tasks that must be done or dropped first.' },
  machine: { type: 'string', description: 'The machine that does this task under the autopilot.' },
  params: { type: 'object', description: 'Machine params fixed by the plan; the Orchestrator fills the rest.' },
  spec: { type: 'string', description: 'Where the task is described, e.g. docs/x.md#csp. Long text belongs there, not here.' },
  acceptance: { type: 'array', items: { type: 'string' } },
  checkpoint: { type: 'boolean', description: 'Wake the Strategist after this task.' }
}, ['id', 'title'])

const ORCHESTRATOR_SCHEMA = OBJECT({
  cli: { type: 'string', description: 'CLI id, e.g. claude-code, codex.' },
  model: { type: 'string' },
  effort: { type: 'string' },
  prompt: { type: 'string', description: 'What the Orchestrator checks after each step and when it wakes you.' },
  maxUnreviewed: { type: 'number', description: 'Tasks in a row without you before you are woken anyway. Default 5.' },
  shadow: { type: 'boolean', description: 'Decisions are shown to you instead of being carried out.' },
  escalations: { type: 'array', items: { type: 'string', enum: ['step', 'gate', 'limit', 'engine'] }, description: 'Kinds of escalation inside a plan step the Orchestrator answers before you see them; it passes on what it cannot decide, and never stops a run. Absent: all come to you.' }
}, ['cli', 'prompt'])

const OPS_SCHEMA = {
  type: 'array',
  description: 'Applied in order, all or nothing.',
  items: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['add', 'update', 'move', 'split', 'drop', 'set', 'dismiss'] },
      id: { type: 'string', description: 'The task (update, move, split, drop) or follow-up (dismiss).' },
      task: { ...TASK_SCHEMA, description: 'add: the new task.' },
      before: { type: 'string', description: 'add, move: the task to go before; the end when absent.' },
      fields: { type: 'object', description: 'update: fields to change, null removes one. Includes status: mark work done by hand this way.' },
      into: { type: 'array', items: TASK_SCHEMA, description: 'split: the tasks that replace it; each inherits its dependencies (besides its own "after"), and tasks that waited for it wait for the last one.' },
      reason: { type: 'string', description: 'drop: why.' },
      title: { type: 'string', description: 'set' },
      goal: { type: 'string', description: 'set' },
      spec: { type: 'string', description: 'set: the document that describes the intent of the whole plan.' },
      orchestrator: { ...ORCHESTRATOR_SCHEMA, description: 'set' }
    }
  }
}

function ok(text: string): ToolResult {
  return { text }
}

function fail(err: unknown): ToolResult {
  return { text: err instanceof Error ? err.message : String(err), isError: true }
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function buildPlanTools(env: () => PlanToolEnvironment): ToolDefinition[] {
  const plans = (): PlanService => {
    const service = env().plans
    if (!service) throw new Error('Plans are not available in this AIDE instance.')
    return service
  }
  /** A handler whose errors are readable results, not protocol failures. */
  const guarded = (body: ToolDefinition['handler']): ToolDefinition['handler'] => async (args, context) => {
    try { return await body(args, context) } catch (err) { return fail(err) }
  }
  return [
    {
      name: 'plan_guide',
      description: 'How plans work in AIDE: the format, how to write tasks and the Orchestrator\'s prompt, the autopilot. Read it before writing a plan. When the user asks for a plan, or a piece of work needs several steps tracked over sessions, make it an AIDE plan, whatever way of planning your own client has.',
      inputSchema: OBJECT({}),
      handler: () => {
        const guide = env().guide?.()
        return guide ? ok(guide) : fail('The plan guide is not available.')
      }
    },
    {
      name: 'plan_list',
      description: 'The plans of this project: id, title, state, progress, which one is active.',
      inputSchema: OBJECT({}),
      handler: guarded((_args, { projectPath }) => {
        const list = plans().list(projectPath)
        return ok(list.length ? JSON.stringify(list) : 'No plans yet. Read plan_guide, then plan_create.')
      })
    },
    {
      name: 'plan_create',
      description: 'Create a plan as a draft in aide/plans/<id>.json. The user approves it (plan_approve, or the plan tab) before it can be activated.',
      inputSchema: OBJECT({
        id: { type: 'string' },
        title: { type: 'string' },
        goal: { type: 'string' },
        spec: { type: 'string', description: 'The document that describes the intent of the whole plan; the Orchestrator reads it for the big picture.' },
        orchestrator: ORCHESTRATOR_SCHEMA,
        tasks: { type: 'array', items: TASK_SCHEMA }
      }, ['id', 'title', 'tasks']),
      handler: guarded((args, { projectPath }) => {
        const plan = plans().create(projectPath, args)
        return ok(`Plan ${plan.id} created as a draft, revision ${plan.revision}, ${plan.tasks.length} task(s). Show it to the user; plan_approve once they agree.`)
      })
    },
    {
      name: 'plan_get',
      description: 'A plan as it is on disk, or one of its tasks. Ask for one task when that is enough: the whole plan stays in your context.',
      inputSchema: OBJECT({ planId: PLAN_ID, taskId: { type: 'string' } }),
      handler: guarded((args, { projectPath }) => ok(JSON.stringify(plans().get(projectPath, optional(args.planId), optional(args.taskId)))))
    },
    {
      name: 'plan_edit',
      description: 'Change a plan: a batch of operations, validated at once and applied all or nothing. Use this, never edit the file. The task a running step works on cannot be changed. Only the Strategist and the user change a plan; the Orchestrator does not.',
      inputSchema: OBJECT({ planId: PLAN_ID, baseRevision: { type: 'number', description: 'The revision you read; refused when the plan has changed since.' }, ops: OPS_SCHEMA }, ['baseRevision', 'ops']),
      handler: guarded((args, { projectPath }) => {
        if (!Array.isArray(args.ops) || args.ops.length === 0) return fail('"ops" must be a non-empty array.')
        return ok(JSON.stringify(plans().edit(projectPath, optional(args.planId), Number(args.baseRevision), args.ops as PlanOp[])))
      })
    },
    {
      name: 'plan_approve',
      description: 'Move a draft to approved, once the user has agreed to it.',
      inputSchema: OBJECT({ planId: PLAN_ID }),
      handler: guarded((args, { projectPath }) => {
        plans().approve(projectPath, optional(args.planId))
        return ok('Approved.')
      })
    },
    {
      name: 'plan_activate',
      description: 'Make an approved plan the active one: the one views show and plan_run walks. Starts nothing. Other plans keep their progress. Refused while the autopilot of the current plan is working.',
      inputSchema: OBJECT({ planId: { type: 'string' } }, ['planId']),
      handler: guarded((args, { projectPath }) => {
        plans().activate(projectPath, String(args.planId))
        return ok(`Plan ${String(args.planId)} is active.`)
      })
    },
    {
      name: 'plan_status',
      description: 'Progress of a plan in a few fields: counts, next task, blocked tasks, what the autopilot and the run are doing, what the plan is waiting for.',
      inputSchema: OBJECT({ planId: PLAN_ID }),
      handler: guarded((args, { projectPath }) => ok(JSON.stringify(plans().status(projectPath, optional(args.planId)))))
    },
    {
      name: 'plan_run',
      description: 'Start or continue the autopilot of the active plan: after each task a new Orchestrator session checks the result and starts the next task, or wakes you. Your note reaches the Orchestrator, so when it woke you and you changed nothing, say why it can go on. A decision made in shadow mode is carried out, unless the plan changed since or redecide is true. With wait, then blocks like pipeline_wait.',
      inputSchema: OBJECT({ planId: PLAN_ID, note: { type: 'string', description: 'For the Orchestrator: your answer to what it woke you for.' }, redecide: { type: 'boolean' }, wait: { type: 'number', description: 'Then block up to this many seconds for the next event that needs you.' } }),
      handler: guarded(async (args, { projectPath, tabId }) => {
        // Taken before the plan moves, so an event that comes right away is not missed.
        const since = env().lastEvent(projectPath)
        await plans().run(projectPath, { planId: optional(args.planId), note: optional(args.note), redecide: args.redecide === true })
        if (args.wait !== undefined) return ok(`Plan continues.\n${await env().waitAfter(projectPath, tabId, since, args.wait)}`)
        return ok(`Plan continues. Wait with pipeline_wait (no runId) since=${since}.`)
      })
    },
    {
      name: 'plan_pause',
      description: 'Hold the autopilot: after the running step, or at once if the Orchestrator is deciding. plan_run continues. To run a machine for something outside the plan while its autopilot is on, pause first, then pipeline_start without planTask.',
      inputSchema: OBJECT({ planId: PLAN_ID }),
      handler: guarded((args, { projectPath }) => {
        const outcome = plans().pause(projectPath, optional(args.planId))
        return ok(outcome === 'held' ? 'Held.' : outcome === 'after_step' ? 'The plan holds after the running step.' : 'The autopilot is not running.')
      })
    }
  ]
}
