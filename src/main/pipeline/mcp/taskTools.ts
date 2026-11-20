import type { ToolContext, ToolDefinition, ToolResult } from './protocol'
import type { TaskService, TaskCloseArgs, TaskSearchQuery } from '../../tasks/taskService'
import type { TaskStatus } from '../../../shared/task'

/**
 * Task tracker MCP tools (docs/task-tracker-implementation.md §5): the project's state
 * — what is in it, what we do, what we decided not to do. Read tools work in any
 * session; write tools only from a live AIDE terminal tab, since a write records who
 * made it and binds tasks to tabs. Results are compact, as the plan tools' are.
 */

export interface TaskToolEnvironment {
  tasks?: TaskService
  /** `resources/docs/task-guide.md`. */
  guide?: () => string
  /** Whether `tabId` names a terminal tab open in this AIDE. */
  liveTab?: (tabId: string) => boolean
}

export const NO_TAB_TEXT = 'Writing to the tracker needs an AIDE terminal tab; this session can read only.'

const OBJECT = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false })

const STRINGS = (description: string): Record<string, unknown> => ({ type: 'array', items: { type: 'string' }, description })
const ID = { type: 'string', description: 'Task id (a slug).' }
const BASE_REVISION = { type: 'string', description: 'The revision you read (task_get); refused when the task changed since.' }
const STATUSES: TaskStatus[] = ['backlog', 'planned', 'active', 'blocked', 'done', 'cancelled']

function ok(text: string): ToolResult {
  return { text }
}

function fail(err: unknown): ToolResult {
  return { text: err instanceof Error ? err.message : String(err), isError: true }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string.`)
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${name}" is required.`)
  return value
}

function optionalStrings(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`"${name}" must be a list of strings.`)
  return value as string[]
}

export function buildTaskTools(env: () => TaskToolEnvironment): ToolDefinition[] {
  const tasks = (): TaskService => {
    const service = env().tasks
    if (!service) throw new Error('The task tracker is not available in this AIDE instance.')
    return service
  }
  /** A handler whose errors are readable results, not protocol failures. */
  const reader = (body: ToolDefinition['handler']): ToolDefinition['handler'] => async (args, context) => {
    try { return await body(args, context) } catch (err) { return fail(err) }
  }
  /** A write: only from a live tab of this AIDE; `by` names the user and the tab. */
  const writer = (body: (args: Record<string, unknown>, context: ToolContext, tabId: string, by: string) => Promise<ToolResult> | ToolResult): ToolDefinition['handler'] =>
    reader((args, context) => {
      const tabId = context.tabId
      if (!tabId || !env().liveTab?.(tabId)) return fail(NO_TAB_TEXT)
      return body(args, context, tabId, tasks().actor(tabId))
    })

  return [
    {
      name: 'task_guide',
      description: 'How the task tracker works: what a task is (and what belongs in a plan instead), claims and labels, code globs, closing, decided against. Read it before you create or close tasks.',
      inputSchema: OBJECT({}),
      handler: () => {
        const guide = env().guide?.()
        return guide ? ok(guide) : fail('The task guide is not available.')
      }
    },
    {
      name: 'task_snapshot',
      description: 'The live state of the tracker for this tab. Not available in this AIDE version yet.',
      inputSchema: OBJECT({}),
      handler: () => ok('task_snapshot is not available in this AIDE version yet; use task_search and task_get.')
    },
    {
      name: 'task_search',
      description: 'Find tasks: a case-insensitive match over id, title, label, claim, tags and description. History is left out unless history is true. Planned tasks by rank first, at most 50.',
      inputSchema: OBJECT({
        query: { type: 'string' },
        status: { oneOf: [{ type: 'string', enum: STATUSES }, { type: 'array', items: { type: 'string', enum: STATUSES } }] },
        tags: STRINGS('Tasks with any of these tags.'),
        history: { type: 'boolean', description: 'Include tasks in history.' }
      }),
      handler: reader((args, { projectPath }) => {
        const status = args.status === undefined || args.status === null ? undefined : typeof args.status === 'string' ? args.status : optionalStrings(args.status, 'status')
        const query: TaskSearchQuery = {
          query: optionalString(args.query, 'query'),
          status: status as TaskSearchQuery['status'],
          tags: optionalStrings(args.tags, 'tags'),
          history: args.history === true
        }
        const hits = tasks().search(projectPath, query)
        return ok(hits.length ? JSON.stringify(hits) : 'No matching tasks.')
      })
    },
    {
      name: 'task_get',
      description: 'A task with its revision (pass it as baseRevision when you change the task), its claim chain (the tasks it superseded and the ones that superseded it), the tabs working on it.',
      inputSchema: OBJECT({ id: ID }, ['id']),
      handler: reader((args, { projectPath }) => ok(JSON.stringify(tasks().get(projectPath, requiredString(args.id, 'id')))))
    },
    {
      name: 'task_create',
      description: 'A new task, backlog unless status is planned. The id is generated from the title when you leave it out. label and claim are for migrating an existing feature only: pass them with status "done"; such a claim is recorded as unverified.',
      inputSchema: OBJECT({
        id: ID,
        title: { type: 'string', description: 'The action, e.g. "Add titles to terminal tabs".' },
        description: { type: 'string', description: 'Why and what, Markdown; long specs live in docs/ and are linked.' },
        tags: STRINGS('Areas of the project, e.g. terminal.'),
        docs: STRINGS('Project-relative paths, optional #anchor.'),
        code: STRINGS('Globs of the files the feature lives in, relative to the project root.'),
        status: { type: 'string', enum: ['backlog', 'planned', 'done'] },
        rank: { type: 'number', description: 'Order among planned or backlog tasks; smaller first, fractions allowed.' },
        label: { type: 'string', description: 'Migration only: a short noun naming the feature.' },
        claim: { type: 'string', description: 'Migration only: one to three lines about the project, present tense, checkable against the code.' },
        source: { type: 'string', description: 'Where a migrated task came from, e.g. STAGES.md.' }
      }, ['title']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const created = await tasks().create(projectPath, args, by)
        return ok(`Task ${created.id} created, revision ${created.revision}.`)
      })
    },
    {
      name: 'task_update',
      description: `Change title, description, tags, docs, code, rank, reason or status. Status: backlog ↔ planned; backlog, planned or active → blocked (give a reason); blocked → the status it was blocked from; active → planned pauses the work and frees the tabs bound to it. Other changes are refused: task_start, task_close and task_reopen do those.`,
      inputSchema: OBJECT({
        id: ID,
        baseRevision: BASE_REVISION,
        fields: OBJECT({
          title: { type: 'string' },
          description: { type: 'string' },
          tags: STRINGS(''),
          docs: STRINGS(''),
          code: STRINGS(''),
          rank: { type: ['number', 'null'] },
          reason: { type: ['string', 'null'], description: 'Why it is blocked.' },
          status: { type: 'string', enum: STATUSES }
        })
      }, ['id', 'baseRevision', 'fields']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const fields = args.fields
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('"fields" must be an object.')
        const { revision } = await tasks().update(projectPath, requiredString(args.id, 'id'), requiredString(args.baseRevision, 'baseRevision'), fields as Record<string, unknown>, by)
        return ok(`Updated, revision ${revision}.`)
      })
    },
    {
      name: 'task_start',
      description: 'Make a task active and the current task of your tab (a tab has one current task; starting another replaces it). Start the task before you work on it.',
      inputSchema: OBJECT({ id: ID }, ['id']),
      handler: writer(async (args, { projectPath }, tabId) => {
        const id = requiredString(args.id, 'id')
        const { revision } = await tasks().start(projectPath, id, tabId, tasks().user())
        return ok(`Task ${id} is active and the current task of this tab, revision ${revision}.`)
      })
    },
    {
      name: 'task_note',
      description: 'Add a line to a task\'s journal: a short decision or finding that outlives the current work, not a transcript.',
      inputSchema: OBJECT({ id: ID, text: { type: 'string' } }, ['id', 'text']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const { revision } = await tasks().note(projectPath, requiredString(args.id, 'id'), requiredString(args.text, 'text'), by)
        return ok(`Noted, revision ${revision}.`)
      })
    },
    {
      name: 'task_close',
      description: 'Close a task done or cancelled. A task that adds something to the project closes done with a label and a claim. supersedes: closed tasks whose claims this work makes untrue; they go to history pointing at this task (refining a claim = supersede it and claim the combined result). A task closed without a claim and without decidedAgainst (internal work, a fix, a removal) goes to history itself. This is an interim close: a later AIDE version adds checks of the other claims the change touched.',
      inputSchema: OBJECT({
        id: ID,
        baseRevision: BASE_REVISION,
        outcome: { type: 'string', enum: ['done', 'cancelled'] },
        label: { type: 'string', description: 'A short noun naming what the project now has; with claim.' },
        claim: { type: 'string', description: 'One to three lines, present tense, checkable against the code; with label.' },
        code: STRINGS('Globs of the files the feature lives in (not hubs every feature touches).'),
        decidedAgainst: { type: 'string', description: '"We do not do X because Y": keeps a task without a claim visible, so the idea is not proposed again.' },
        supersedes: STRINGS('Closed tasks this work makes untrue.')
      }, ['id', 'baseRevision', 'outcome']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const id = requiredString(args.id, 'id')
        const close: TaskCloseArgs = {
          outcome: requiredString(args.outcome, 'outcome') as TaskCloseArgs['outcome'],
          label: optionalString(args.label, 'label'),
          claim: optionalString(args.claim, 'claim'),
          code: optionalStrings(args.code, 'code'),
          decidedAgainst: optionalString(args.decidedAgainst, 'decidedAgainst'),
          supersedes: optionalStrings(args.supersedes, 'supersedes')
        }
        const { revisions, history } = await tasks().closeSimple(projectPath, id, requiredString(args.baseRevision, 'baseRevision'), close, by)
        const lines = [`Task ${id} closed ${close.outcome}, revision ${revisions[id]}.`]
        if (history.length) lines.push(`To history: ${history.join(', ')}.`)
        return ok(lines.join('\n'))
      })
    },
    {
      name: 'task_reopen',
      description: 'A done task goes back to active: the work turned out unfinished. Its claim stays, shown as reopened until the next close. task_start binds it to your tab.',
      inputSchema: OBJECT({ id: ID, reason: { type: 'string' } }, ['id', 'reason']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const id = requiredString(args.id, 'id')
        const { revision } = await tasks().reopen(projectPath, id, requiredString(args.reason, 'reason'), by)
        return ok(`Task ${id} reopened, revision ${revision}.`)
      })
    },
    {
      name: 'task_to_history',
      description: 'Move a done or cancelled task to history by hand: no longer true or no longer relevant. A close does this for the tasks it supersedes.',
      inputSchema: OBJECT({ id: ID, reason: { type: 'string' } }, ['id']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const id = requiredString(args.id, 'id')
        const { revision } = await tasks().toHistory(projectPath, id, optionalString(args.reason, 'reason'), by)
        return ok(`Task ${id} is in history, revision ${revision}.`)
      })
    },
    {
      name: 'task_restore',
      description: 'Bring a task back from history into the project\'s state.',
      inputSchema: OBJECT({ id: ID }, ['id']),
      handler: writer(async (args, { projectPath }, _tabId, by) => {
        const id = requiredString(args.id, 'id')
        const { revision } = await tasks().restore(projectPath, id, by)
        return ok(`Task ${id} restored, revision ${revision}.`)
      })
    }
  ]
}
