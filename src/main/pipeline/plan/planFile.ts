import { ESCALATION_KINDS, type PlanFile, type PlanOrchestrator, type PlanTask } from '../../../shared/plan'

/**
 * Plan files as data: validation, edit operations, serialization, what comes next.
 * No disk access (see planStore.ts). See docs/plan-mode-spec.md.
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TASK_STATUSES = ['pending', 'done', 'blocked', 'dropped']
const PLAN_STATES = ['draft', 'approved', 'done', 'dropped']

const TASK_KEYS = ['id', 'title', 'status', 'reason', 'phase', 'after', 'machine', 'params', 'spec', 'acceptance', 'checkpoint'] as const
const ORCHESTRATOR_KEYS = ['cli', 'model', 'effort', 'prompt', 'maxUnreviewed', 'shadow', 'escalations'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function taskProblems(task: unknown, at: string): string[] {
  if (!isObject(task)) return [`${at}: must be an object`]
  const problems: string[] = []
  if (typeof task.id !== 'string' || !ID_RE.test(task.id)) problems.push(`${at}: "id" must be letters, digits, ".", "_" or "-"`)
  if (typeof task.title !== 'string' || !task.title.trim()) problems.push(`${at}: "title" is required`)
  if (!TASK_STATUSES.includes(task.status as string)) problems.push(`${at}: "status" must be one of ${TASK_STATUSES.join(', ')}`)
  for (const key of ['reason', 'phase', 'machine', 'spec']) if (task[key] !== undefined && typeof task[key] !== 'string') problems.push(`${at}: "${key}" must be a string`)
  for (const key of ['after', 'acceptance']) if (task[key] !== undefined && !isStringArray(task[key])) problems.push(`${at}: "${key}" must be an array of strings`)
  if (task.params !== undefined && !isObject(task.params)) problems.push(`${at}: "params" must be an object`)
  if (task.checkpoint !== undefined && typeof task.checkpoint !== 'boolean') problems.push(`${at}: "checkpoint" must be a boolean`)
  for (const key of Object.keys(task)) if (!(TASK_KEYS as readonly string[]).includes(key)) problems.push(`${at}: unknown field "${key}"`)
  return problems
}

function orchestratorProblems(value: unknown): string[] {
  if (!isObject(value)) return ['orchestrator: must be an object']
  const problems: string[] = []
  if (typeof value.cli !== 'string' || !value.cli) problems.push('orchestrator: "cli" is required')
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) problems.push('orchestrator: "prompt" is required')
  for (const key of ['model', 'effort']) if (value[key] !== undefined && typeof value[key] !== 'string') problems.push(`orchestrator: "${key}" must be a string`)
  if (value.maxUnreviewed !== undefined && (!Number.isInteger(value.maxUnreviewed) || (value.maxUnreviewed as number) < 1)) problems.push('orchestrator: "maxUnreviewed" must be a positive integer')
  if (value.shadow !== undefined && typeof value.shadow !== 'boolean') problems.push('orchestrator: "shadow" must be a boolean')
  if (value.escalations !== undefined && (!isStringArray(value.escalations) || value.escalations.some((k) => !(ESCALATION_KINDS as readonly string[]).includes(k)))) problems.push(`orchestrator: "escalations" must be a list of ${ESCALATION_KINDS.join(', ')}`)
  for (const key of Object.keys(value)) if (!(ORCHESTRATOR_KEYS as readonly string[]).includes(key)) problems.push(`orchestrator: unknown field "${key}"`)
  return problems
}

/** A cycle through `after`, as ids in order, or null. */
function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id]
    state.set(id, 'visiting')
    path.push(id)
    for (const dep of byId.get(id)?.after ?? []) {
      if (!byId.has(dep)) continue
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    path.pop()
    state.set(id, 'done')
    return null
  }
  for (const task of tasks) {
    const cycle = visit(task.id)
    if (cycle) return cycle
  }
  return null
}

/** Problems with a parsed plan file; empty when it is valid. */
export function planProblems(value: unknown): string[] {
  if (!isObject(value)) return ['the plan must be an object']
  const problems: string[] = []
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) problems.push('"id" must be letters, digits, ".", "_" or "-"')
  if (typeof value.title !== 'string' || !value.title.trim()) problems.push('"title" is required')
  for (const key of ['goal', 'spec']) if (value[key] !== undefined && typeof value[key] !== 'string') problems.push(`"${key}" must be a string`)
  if (!PLAN_STATES.includes(value.state as string)) problems.push(`"state" must be one of ${PLAN_STATES.join(', ')}`)
  if (!Number.isInteger(value.revision)) problems.push('"revision" must be an integer')
  if (value.orchestrator !== undefined) problems.push(...orchestratorProblems(value.orchestrator))
  if (!Array.isArray(value.tasks)) return [...problems, '"tasks" must be an array']
  if (!Array.isArray(value.followups)) problems.push('"followups" must be an array')
  value.tasks.forEach((task, index) => problems.push(...taskProblems(task, `tasks[${index}]`)))
  if (problems.length) return problems

  const tasks = value.tasks as PlanTask[]
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) problems.push(`task "${task.id}" appears twice`)
    ids.add(task.id)
  }
  for (const task of tasks) {
    for (const dep of task.after ?? []) if (!ids.has(dep)) problems.push(`task "${task.id}" comes after unknown task "${dep}"`)
  }
  const cycle = findCycle(tasks)
  if (cycle) problems.push(`tasks depend on each other: ${cycle.join(' → ')}`)
  return problems
}

/** Stable key order, so the file's git diff shows only what changed. */
function orderedTask(task: PlanTask): PlanTask {
  const out: Record<string, unknown> = {}
  for (const key of TASK_KEYS) if (task[key] !== undefined) out[key] = task[key]
  return out as unknown as PlanTask
}

function orderedOrchestrator(value: PlanOrchestrator): PlanOrchestrator {
  const out: Record<string, unknown> = {}
  for (const key of ORCHESTRATOR_KEYS) if (value[key] !== undefined) out[key] = value[key]
  return out as unknown as PlanOrchestrator
}

export function serializePlan(plan: PlanFile): string {
  const ordered: PlanFile = {
    id: plan.id,
    title: plan.title,
    ...(plan.goal !== undefined ? { goal: plan.goal } : {}),
    ...(plan.spec !== undefined ? { spec: plan.spec } : {}),
    state: plan.state,
    revision: plan.revision,
    ...(plan.orchestrator ? { orchestrator: orderedOrchestrator(plan.orchestrator) } : {}),
    tasks: plan.tasks.map(orderedTask),
    followups: plan.followups
  }
  return JSON.stringify(ordered, null, 2) + '\n'
}

/** A new plan from what the Strategist sent to `plan_create`; throws with the problems. */
export function newPlan(input: Record<string, unknown>): PlanFile {
  const tasks = Array.isArray(input.tasks) ? input.tasks.map((t) => (isObject(t) ? { status: 'pending', ...t } : t)) : input.tasks
  const plan = { state: 'draft', revision: 1, followups: [], ...input, tasks: tasks ?? [] } as unknown as PlanFile
  const problems = planProblems(plan)
  if (problems.length) throw new Error(`Invalid plan:\n- ${problems.join('\n- ')}`)
  return plan
}

export type PlanOp =
  | { op: 'add'; task: Partial<PlanTask> & { id: string; title: string }; before?: string }
  | { op: 'update'; id: string; fields: Partial<Omit<PlanTask, 'id'>> }
  | { op: 'move'; id: string; before?: string }
  | { op: 'split'; id: string; into: Array<Partial<PlanTask> & { id: string; title: string }> }
  | { op: 'drop'; id: string; reason?: string }
  | { op: 'set'; title?: string; goal?: string; spec?: string; orchestrator?: PlanOrchestrator }
  | { op: 'dismiss'; id: string }

function position(tasks: PlanTask[], before: string | undefined): number {
  if (before === undefined) return tasks.length
  const index = tasks.findIndex((t) => t.id === before)
  if (index < 0) throw new Error(`Unknown task "${before}".`)
  return index
}

function requireIndex(tasks: PlanTask[], id: string): number {
  const index = tasks.findIndex((t) => t.id === id)
  if (index < 0) throw new Error(`Unknown task "${id}".`)
  return index
}

/**
 * Apply a batch of operations and return the new plan with the ids of the tasks
 * they changed; the input is not modified. All or nothing: throws on the first
 * bad operation or when the result is not a valid plan. `locked` is the task a
 * running step works on: it cannot be changed.
 */
export function applyOps(plan: PlanFile, ops: PlanOp[], locked: string | null = null): { plan: PlanFile; changed: string[] } {
  const next: PlanFile = JSON.parse(JSON.stringify(plan)) as PlanFile
  const changed = new Set<string>()
  const guard = (id: string): void => {
    if (id === locked) throw new Error(`Task "${id}" is running; change it after the step ends, or pause or stop the run first.`)
  }
  for (const op of ops) {
    switch (op?.op) {
      case 'add': {
        next.tasks.splice(position(next.tasks, op.before), 0, { status: 'pending', ...op.task } as PlanTask)
        changed.add(op.task.id)
        break
      }
      case 'update': {
        guard(op.id)
        const index = requireIndex(next.tasks, op.id)
        if (!isObject(op.fields)) throw new Error(`update of "${op.id}" needs "fields".`)
        if ('id' in op.fields) throw new Error('A task id cannot change; use split or add and drop.')
        const merged: Record<string, unknown> = { ...next.tasks[index], ...op.fields }
        for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key]
        next.tasks[index] = merged as unknown as PlanTask
        changed.add(op.id)
        break
      }
      case 'move': {
        guard(op.id)
        const index = requireIndex(next.tasks, op.id)
        const [task] = next.tasks.splice(index, 1)
        next.tasks.splice(position(next.tasks, op.before), 0, task)
        changed.add(op.id)
        break
      }
      case 'split': {
        guard(op.id)
        const index = requireIndex(next.tasks, op.id)
        if (!Array.isArray(op.into) || op.into.length === 0) throw new Error(`split of "${op.id}" needs "into".`)
        const parent = next.tasks[index]
        // Every part waits for what the task waited for, besides what it names itself.
        const parts = op.into.map((part) => {
          const after = [...new Set([...(parent.after ?? []), ...(part.after ?? [])])]
          return { status: 'pending', ...(parent.phase ? { phase: parent.phase } : {}), ...part, ...(after.length ? { after } : {}) } as PlanTask
        })
        next.tasks.splice(index, 1, ...parts)
        const last = parts[parts.length - 1].id
        for (const task of next.tasks) if (task.after?.includes(op.id)) task.after = task.after.map((dep) => (dep === op.id ? last : dep))
        for (const part of parts) changed.add(part.id)
        break
      }
      case 'drop': {
        guard(op.id)
        const index = requireIndex(next.tasks, op.id)
        next.tasks[index] = { ...next.tasks[index], status: 'dropped', ...(op.reason ? { reason: op.reason } : {}) }
        changed.add(op.id)
        break
      }
      case 'set': {
        if (op.title !== undefined) next.title = op.title
        if (op.goal !== undefined) next.goal = op.goal
        if (op.spec !== undefined) next.spec = op.spec
        if (op.orchestrator !== undefined) next.orchestrator = op.orchestrator
        break
      }
      case 'dismiss': {
        const index = next.followups.findIndex((f) => f.id === op.id)
        if (index < 0) throw new Error(`Unknown follow-up "${op.id}".`)
        next.followups.splice(index, 1)
        break
      }
      default:
        throw new Error(`Unknown operation ${JSON.stringify((op as { op?: unknown } | null)?.op)}; use add, update, move, split, drop, set or dismiss.`)
    }
  }
  const problems = planProblems(next)
  if (problems.length) throw new Error(`The edit would make the plan invalid:\n- ${problems.join('\n- ')}`)
  return { plan: next, changed: [...changed] }
}

/** The first pending task, in file order, whose dependencies are all done or dropped. */
export function nextTask(plan: PlanFile): PlanTask | null {
  const finished = new Set(plan.tasks.filter((t) => t.status === 'done' || t.status === 'dropped').map((t) => t.id))
  return plan.tasks.find((t) => t.status === 'pending' && (t.after ?? []).every((dep) => finished.has(dep))) ?? null
}

/** The plan with this task marked done and the findings added as follow-ups; a new object. Neither counts as a revision. */
export function markDone(plan: PlanFile, taskId: string, findings: string[] = [], at = new Date().toISOString()): PlanFile {
  const used = new Set(plan.followups.map((f) => f.id))
  let counter = plan.followups.length
  const known = new Set(plan.followups.map((f) => f.text))
  const added = [...new Set(findings.map((f) => f.trim()).filter(Boolean))].filter((text) => !known.has(text)).map((text) => {
    do counter++; while (used.has(`f${counter}`))
    return { id: `f${counter}`, text, from: taskId, at }
  })
  return {
    ...plan,
    tasks: plan.tasks.map((t) => {
      if (t.id !== taskId) return t
      const { reason: _reason, ...rest } = t
      return { ...rest, status: 'done' as const }
    }),
    followups: [...plan.followups, ...added]
  }
}

/** The whole plan for the Orchestrator: every task with its spec and acceptance, and the open follow-ups. */
export function planDetail(plan: PlanFile, current: string | null = null): string {
  const outline = planOutline(plan, current).split('\n')
  const lines = plan.tasks.flatMap((t, i) => [
    outline[i],
    ...(t.spec ? [`    spec: ${t.spec}`] : []),
    ...(t.acceptance?.length ? [`    acceptance: ${t.acceptance.join('; ')}`] : []),
    ...(t.machine ? [`    machine: ${t.machine}`] : [])
  ])
  if (plan.followups.length) lines.push('', 'Follow-ups (findings of earlier runs, not yet turned into tasks):', ...plan.followups.map((f) => `- ${f.id} (from ${f.from}): ${f.text}`))
  return lines.join('\n')
}

/** One line per task, for the Orchestrator's prompt and `plan_get`. */
export function planOutline(plan: PlanFile, current: string | null = null): string {
  const mark: Record<PlanTask['status'], string> = { pending: '[ ]', done: '[x]', blocked: '[!]', dropped: '[-]' }
  return plan.tasks.map((t) => {
    const parts = [`${mark[t.status]} ${t.id}: ${t.title}`]
    if (t.phase) parts.push(`(${t.phase})`)
    if (t.after?.length) parts.push(`after ${t.after.join(', ')}`)
    if (t.reason) parts.push(`— ${t.reason}`)
    if (t.id === current) parts.push('← next')
    return parts.join(' ')
  }).join('\n')
}
