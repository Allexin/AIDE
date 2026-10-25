import type { ToolDefinition, ToolResult } from './protocol'
import { orchestrators } from '../orchestrators'
import { clip, pipelineEvents, SIGNIFICANT_EVENTS, type PipelineEvent } from '../events'
import type { PipelineManager } from '../manager'
import { MACHINE_FILE_SCHEMA } from '../engine/machineSchema'
import { compactReport } from '../engine/reportView'
import { ENGINE_CHANGES, ENGINE_VERSION, outdatedMachine } from '../engine/compat'

/**
 * Pipeline MCP tools — the orchestrator's interface to AIDE (plan §4.2).
 *
 * Everything returned here lands in the orchestrator's context, so results are
 * compact: decisions and outcomes, not logs. Details are fetched on demand
 * (`pipeline_output`, `pipeline_report detail: true`). Results are text only —
 * data as one line of JSON, never duplicated into `structuredContent`.
 */

export interface ToolEnvironment {
  aideVersion: string
  /** Shell launcher for the event feed (`<launcher> events --run <id>`). */
  launcherPath: string
  /** Project-relative path of the orchestration doc. */
  docPath: string
  /** Absent in contexts without an engine (tests of the handshake). */
  manager?: PipelineManager
  /** Authoring guide text (`pipeline_guide`). */
  authoringGuide?: () => string
  /** Smoke test of a machine (`pipeline_smoke`). */
  smoke?: (projectPath: string, machineId: string, pingAgents: boolean) => Promise<string>
}

export const ORCHESTRATOR_RULES = [
  'You are the orchestrator of AIDE pipelines for this project.',
  'AIDE executes pipeline machines deterministically: it spawns step agents, runs checks, repeats loops, commits and reports. You decide what to run: pick the next task from the project plan, choose a machine and its parameters, start it, read the result, update the plan if the machine does not, and talk to the user.',
  'While a run is executing, leave the working tree to it: do not edit files yourself.',
  'Do not give step agents a way out in task texts or params ("if you cannot finish, escalate"): they take it early. A step that should stop has blocked / plan_wrong and escalations for real obstacles.',
  'Every call you make re-reads your whole context, so keep each cycle to the few calls it needs. Do not re-verify what the machine\'s checks and reviewers already verified; inspect results yourself only on a signal (a reviewer flagged something, a first capture of a new visual stage, a failed run).'
]

function eventDeliveryText(launcherPath: string): string {
  return [
    'Waiting for runs, cheapest first:',
    '1. Stay in one turn and block: pass `wait` to pipeline_start / pipeline_answer / pipeline_resume (they act, then return the next event), or call pipeline_wait. The event comes back as the call result — no output files, no extra turns. When the user types in your terminal, the wait returns early with type "user_input", so their message reaches you right away; handle it, then wait again.',
    `2. If your client cannot block on a tool call for long: a background command or monitor — "${launcherPath}" events --run <runId> --since <lastEventId> (one JSON line per event that needs you) or "${launcherPath}" wait --run <runId> --since <lastEventId> (prints the next one and exits). Each wake-up costs extra calls.`,
    '3. Last resort: poll pipeline_status.',
    'Events that need you: escalation (a decision; answer with pipeline_answer), run_paused / run_stopped (the run changed hands, possibly by the user or an AIDE restart; continue with pipeline_resume — reason "usage_limit" means a CLI hit its usage limit: the run resumes by itself at resumeAt when the message said when, keeping the step\'s session, and AIDE may switch the CLI to another account and resume it at once — wait for the next event before resuming it yourself), run_finished / run_failed (the event carries the compact report). Step progress is not sent.',
    'Pass the last event id you have seen as `since`; ids continue across AIDE restarts, so nothing is lost.'
  ].join('\n')
}

/** The engine version history, appended to the guide: what to check when raising a machine's engineVersion. */
function engineVersionsText(): string {
  const lines = [`## Engine versions`, '', `This AIDE runs pipeline engine ${ENGINE_VERSION}. Set "engineVersion": ${ENGINE_VERSION} in machines you write or review. Changes per version:`]
  for (const change of [...ENGINE_CHANGES].reverse()) {
    lines.push('', `Engine ${change.version}:`, ...change.changes.map((c) => `- ${c}`), ...change.actions.map((a) => `- To do: ${a}`))
  }
  return lines.join('\n')
}

function ok(text: string): ToolResult {
  return { text }
}

/** Data as compact JSON, optionally after a line of text. */
function data(value: unknown, lead?: string): ToolResult {
  const body = JSON.stringify(value)
  return { text: lead ? `${lead}\n${body}` : body }
}

function fail(text: string): ToolResult {
  return { text, isError: true }
}

const OBJECT = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false })

const RUN_ID = { type: 'string', description: 'Run id; defaults to the active run.' }

const DEFAULT_WAIT_SEC = 1500 // under the 1-hour prompt-cache lifetime of the waiting agent
const MAX_WAIT_SEC = 1800

type WaitResult = PipelineEvent | { type: 'user_input'; summary: string } | null

/**
 * Next significant event of a run after `since`. Returns early when the user
 * submits input in the calling agent's terminal tab, so a blocked orchestrator
 * does not hold the user's message until the next event.
 */
function waitForEvent(projectPath: string, runId: string | null, since: number, timeoutSec: number, tabId: string | null): Promise<WaitResult> {
  pipelineEvents.noteObserver(projectPath)
  const pending = pipelineEvents.since(projectPath, runId, since).find((e) => SIGNIFICANT_EVENTS.has(e.type))
  if (pending) return Promise.resolve(pending)
  return new Promise((resolve) => {
    const finish = (result: WaitResult): void => { clearTimeout(timer); unsubscribe(); orchestrators.off('input', onInput); resolve(result) }
    const unsubscribe = pipelineEvents.subscribe(projectPath, (event) => {
      if ((runId === null || event.runId === runId) && SIGNIFICANT_EVENTS.has(event.type)) finish(event)
    })
    const onInput = (inputTab: string): void => { if (tabId && inputTab === tabId) finish({ type: 'user_input', summary: 'The user sent you a message; it follows this result. Wait again afterwards with the same since.' }) }
    orchestrators.on('input', onInput)
    const timer = setTimeout(() => finish(null), timeoutSec * 1000)
  })
}

const lastEventId = (projectPath: string, runId: string): number => pipelineEvents.since(projectPath, runId, 0).at(-1)?.id ?? 0

const WAIT_ARG = { type: 'number', description: `Then block up to this many seconds (max ${MAX_WAIT_SEC}) and return the run's next event, as pipeline_wait does.` }

function waitSeconds(value: unknown, fallback: number): number {
  return Math.min(Math.max(Number(value ?? fallback) || fallback, 1), MAX_WAIT_SEC)
}

/** Text for a wait result. */
function waitText(result: WaitResult): string {
  if (!result) return 'No event before the timeout. Wait again with the same since.'
  return JSON.stringify(result)
}

export function buildPipelineTools(env: () => ToolEnvironment): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'pipeline_hello',
      description: 'Handshake with AIDE. Call once after connecting: confirms the connection and returns the orchestrator rules and how to receive pipeline events.',
      inputSchema: OBJECT({}),
      handler: (_args, context) => {
        const { aideVersion, launcherPath, docPath } = env()
        orchestrators.hello({ projectPath: context.projectPath, connectionId: context.connectionId, tabId: context.tabId, client: context.clientInfo })
        const text = [
          `Connected to AIDE ${aideVersion} for project ${context.projectPath}.`,
          '',
          ...ORCHESTRATOR_RULES,
          '',
          eventDeliveryText(launcherPath),
          '',
          `Full reference: ${docPath}`
        ].join('\n')
        return ok(text)
      }
    }
  ]

  const manager = (): PipelineManager => {
    const m = env().manager
    if (!m) throw new Error('The pipeline engine is not available in this AIDE instance.')
    return m
  }

  tools.push(
    {
      name: 'pipeline_list',
      description: 'List the pipeline machines of this project: id, description (when to use it), params, and whether each one is valid.',
      inputSchema: OBJECT({}),
      handler: (_args, { projectPath }) => {
        const { machines, errors } = manager().listMachines(projectPath)
        const list = machines.map((m) => {
          const entry = manager().machineEntry(projectPath, m.id)
          const outdated = entry ? outdatedMachine(entry.machine) : null
          return { id: m.id, name: m.name, description: m.description, params: m.params ?? {}, source: m.source, valid: m.validation.errors.length === 0, errors: m.validation.errors, ...(outdated ? { outdated: `written for engine ${outdated.declared ?? '(not declared)'}, AIDE runs ${ENGINE_VERSION}` } : {}) }
        })
        if (list.length === 0 && errors.length === 0) return ok('No machines yet. Machines live in aide/pipelines/*.json; call pipeline_guide to learn how to write them.')
        return data(errors.length ? { machines: list, unreadableFiles: errors } : { machines: list })
      }
    },
    {
      name: 'pipeline_validate',
      description: 'Validate machine files (all, or one by id): step tree, ids, references, role files, loop bounds and targets, sessions. Fix every error before starting a run.',
      inputSchema: OBJECT({ machineId: { type: 'string' } }),
      handler: (args, { projectPath }) => {
        const { machines, errors } = manager().listMachines(projectPath)
        const selected = typeof args.machineId === 'string' ? machines.filter((m) => m.id === args.machineId) : machines
        if (typeof args.machineId === 'string' && selected.length === 0) return fail(`Unknown machine "${args.machineId}".`)
        const result = { machines: selected.map((m) => ({ id: m.id, file: m.file, errors: m.validation.errors, warnings: m.validation.warnings })), unreadableFiles: errors }
        const allValid = result.machines.every((m) => m.errors.length === 0) && errors.length === 0
        return data(result, allValid ? 'All valid.' : 'Problems found.')
      }
    },
    {
      name: 'pipeline_start',
      description: 'Start a run of a machine with params. Only one run per project can be active. A machine written for an older pipeline engine is refused with the list of what changed since; review it with the user (or pass acceptOutdated: true to run it unchanged). With wait, blocks until the run\'s first event that needs you (usually its end) and returns it.',
      inputSchema: OBJECT({ machine: { type: 'string', description: 'Machine id from pipeline_list.' }, params: { type: 'object', description: 'Values for the machine params.' }, acceptOutdated: { type: 'boolean', description: 'Run a machine written for an older engine without reviewing it.' }, wait: WAIT_ARG }, ['machine']),
      handler: async (args, { projectPath, tabId }) => {
        try {
          const { runId, warnings } = await manager().start(projectPath, String(args.machine), (args.params as Record<string, unknown>) ?? {}, { acceptOutdated: args.acceptOutdated === true })
          const lines = [`Run ${runId} started.`, ...warnings.map((w) => `Warning: ${w}`)]
          if (args.wait !== undefined) return ok([...lines, waitText(await waitForEvent(projectPath, runId, 0, waitSeconds(args.wait, DEFAULT_WAIT_SEC), tabId))].join('\n'))
          lines.push(`Wait for its events: pipeline_wait with runId "${runId}" (or "${env().launcherPath}" events --run ${runId} --since 0 in the background).`, 'Leave the working tree to the run while it executes.')
          return ok(lines.join('\n'))
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_status',
      description: 'Status of the active run (or a given run): current step, loop iterations, visits per step, pending escalation, the last few events.',
      inputSchema: OBJECT({ runId: RUN_ID }),
      handler: (args, { projectPath }) => {
        const m = manager()
        const run = m.activeRun(projectPath)
        const runId = typeof args.runId === 'string' ? args.runId : run?.runId
        if (!runId) return data({ active: false, recentRuns: m.runs(projectPath).slice(0, 5) }, 'No active run.')
        if (run && run.runId === runId) {
          const recent = pipelineEvents.since(projectPath, runId, 0).slice(-5).map((e) => ({ id: e.id, type: e.type, summary: e.data.summary }))
          return data({ ...run.describe(), recentEvents: recent })
        }
        const state = m.runState(projectPath, runId)
        return state ? data({ runId, status: state.status, result: state.result }) : fail(`Unknown run ${runId}.`)
      }
    },
    {
      name: 'pipeline_wait',
      description: `Block until the next event of a run that needs you (escalation, pause, stop, end), the user typing in your terminal (type "user_input"), or a timeout. The cheapest way to wait: the event is the result of this call.`,
      inputSchema: OBJECT({ runId: { type: 'string' }, since: { type: 'number', description: 'Last event id you have seen.' }, timeoutSec: { type: 'number', description: `Default ${DEFAULT_WAIT_SEC}, max ${MAX_WAIT_SEC}. Pass less if your client cuts tool calls earlier.` } }, ['runId']),
      handler: async (args, { projectPath, tabId }) => {
        const result = await waitForEvent(projectPath, String(args.runId), Number(args.since ?? 0) || 0, waitSeconds(args.timeoutSec, DEFAULT_WAIT_SEC), tabId)
        return ok(waitText(result))
      }
    },
    {
      name: 'pipeline_answer',
      description: 'Answer a pending escalation. action: continue (go on after the step; approve a gate; leave an exhausted loop as if it passed), reject (reject a gate: repeats its loop; outside loops the run holds at the gate — pipeline_resume asks again), retry (run the step again — after an engine failure it continues the failed session; for an exhausted loop: one more iteration), stop (end the run for good; it cannot be resumed). To hold the run without deciding, do not answer: a run waiting on an escalation does nothing and survives AIDE restarts. Your text is shown to every later agent of the run.',
      inputSchema: OBJECT({ escalationId: { type: 'string' }, action: { type: 'string', enum: ['continue', 'retry', 'reject', 'stop'] }, text: { type: 'string', description: 'Your answer; shown to the later agents of the run.' }, params: { type: 'object', description: 'Change machine params for the rest of the run, e.g. {"stageId": "S5.7a"} after approving a split. Validated against the machine params; later templates, inputs and conditions use the new values.' }, runId: RUN_ID, wait: WAIT_ARG }, ['escalationId', 'action']),
      handler: async (args, { projectPath, tabId }) => {
        try {
          const m = manager()
          const runId = typeof args.runId === 'string' ? args.runId : m.activeRun(projectPath)?.runId
          const since = runId ? lastEventId(projectPath, runId) : 0
          await m.answer(projectPath, String(args.escalationId), { action: args.action as 'continue' | 'retry' | 'reject' | 'stop', text: String(args.text ?? ''), by: 'orchestrator', ...(args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { params: args.params as Record<string, unknown> } : {}) }, typeof args.runId === 'string' ? args.runId : undefined)
          if (args.wait !== undefined && runId) return ok(`Answer recorded.\n${waitText(await waitForEvent(projectPath, runId, since, waitSeconds(args.wait, DEFAULT_WAIT_SEC), tabId))}`)
          return ok('Answer recorded; the run continues.')
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_stop',
      description: 'pause: finish the current step, then hold. stop: interrupt the current step now (resumable; the step continues its session on resume). abandon: end a stopped/paused/waiting run for good; the result lists the uncommitted files left in the working tree.',
      inputSchema: OBJECT({ mode: { type: 'string', enum: ['pause', 'stop', 'abandon'] }, reason: { type: 'string' }, runId: RUN_ID }, ['mode']),
      handler: async (args, { projectPath }) => {
        const runId = typeof args.runId === 'string' ? args.runId : undefined
        try {
          if (args.mode === 'pause') manager().pause(projectPath, runId)
          else if (args.mode === 'stop') await manager().stop(projectPath, runId)
          else {
            const left = await manager().abandon(projectPath, String(args.reason ?? 'abandoned by the orchestrator'), runId)
            return ok(left.length ? `Done: abandon. Uncommitted changes left in the working tree (${left.length}): ${clip(left.join(', '), 2000)}` : 'Done: abandon. The working tree is clean.')
          }
          return ok(`Done: ${String(args.mode)}.`)
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_amend',
      description: 'Add an instruction to the active run — a new requirement or a ruling while a step works. A running agent step is interrupted and continues at once in its own session with the instruction (its work so far is kept); every later step of the run sees it in its context. When no agent step is running, the instruction is only recorded for the later steps. Cheaper than stop, abandon and restart.',
      inputSchema: OBJECT({ text: { type: 'string', description: 'The instruction, written for the step agents.' }, runId: RUN_ID }, ['text']),
      handler: async (args, { projectPath }) => {
        try {
          const outcome = await manager().amend(projectPath, String(args.text ?? ''), 'orchestrator', typeof args.runId === 'string' ? args.runId : undefined)
          return ok(outcome === 'restarted' ? 'Instruction added; the running step continues with it in its session.' : 'Instruction recorded; the later steps of the run will see it.')
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_reload',
      description: 'Make the active run use its edited machine file (a timeout, a task text, a model) for the steps still to come. The run must be paused, stopped or waiting on an escalation; the steps and loops it is in must still exist. Role files need no reload: every visit reads them afresh.',
      inputSchema: OBJECT({ runId: RUN_ID }),
      handler: (args, { projectPath }) => {
        try {
          const problems = manager().reload(projectPath, typeof args.runId === 'string' ? args.runId : undefined)
          return problems.length ? fail(`Not reloaded:\n- ${problems.join('\n- ')}`) : ok('Reloaded; the coming steps use the edited machine.')
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_resume',
      description: 'Continue a paused or stopped run from where it stopped. With wait, then blocks until its next event that needs you.',
      inputSchema: OBJECT({ runId: RUN_ID, wait: WAIT_ARG }),
      handler: async (args, { projectPath, tabId }) => {
        try {
          const m = manager()
          const runId = typeof args.runId === 'string' ? args.runId : m.activeRun(projectPath)?.runId
          const since = runId ? lastEventId(projectPath, runId) : 0
          m.resume(projectPath, typeof args.runId === 'string' ? args.runId : undefined)
          if (args.wait !== undefined && runId) return ok(`Resumed.\n${waitText(await waitForEvent(projectPath, runId, since, waitSeconds(args.wait, DEFAULT_WAIT_SEC), tabId))}`)
          return ok('Resumed.')
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_report',
      description: 'Report of a run: result, commits, visits per step, loop iterations, agent summaries, non-blocking findings (first 20), pipeline issues the agents reported, instructions added, decisions taken, cost. detail: true returns the full report: every finding and visit with its outcome, duration and error, and the full escalations.',
      inputSchema: OBJECT({ runId: { type: 'string' }, detail: { type: 'boolean' } }, ['runId']),
      handler: (args, { projectPath }) => {
        const report = manager().report(projectPath, String(args.runId))
        if (!report) return fail(`No report for run ${String(args.runId)}.`)
        if (args.detail !== true) return data(compactReport(report))
        const { params: _params, ...full } = report
        return data(full)
      }
    },
    {
      name: 'pipeline_output',
      description: 'Output of one step visit when you need details for a decision: an agent\'s JSON answer, a check\'s exit code and log tail, a commit result, a gate answer. Defaults to the step\'s last visit of the active run.',
      inputSchema: OBJECT({ step: { type: 'string' }, visit: { type: 'number' }, runId: RUN_ID, maxChars: { type: 'number', description: 'Default 4000.' } }, ['step']),
      handler: (args, { projectPath }) => {
        const found = manager().output(projectPath, String(args.step), typeof args.visit === 'number' ? args.visit : undefined, typeof args.runId === 'string' ? args.runId : undefined)
        if (!found) return fail(`No output for step "${String(args.step)}"${typeof args.visit === 'number' ? ` visit ${args.visit}` : ''}.`)
        const max = Math.min(Math.max(Number(args.maxChars ?? 4000) || 4000, 200), 50_000)
        const out = found.output as Record<string, unknown> | null
        // Check logs keep their tail (errors are at the end); JSON keeps its head.
        const log = out && typeof out === 'object' ? (typeof out.output === 'string' ? out.output : typeof out.log === 'string' ? out.log : null) : null
        const body = log !== null ? clip(log, max, 'tail') : clip(JSON.stringify(out), max)
        const exit = out && typeof out === 'object' && 'exitCode' in out ? ` exit code ${String(out.exitCode)}` : ''
        return ok(`${found.step} visit ${found.visit}${exit}:\n${body}`)
      }
    },
    {
      name: 'pipeline_runs',
      description: 'Recent runs of this project with their status.',
      inputSchema: OBJECT({}),
      handler: (_args, { projectPath }) => {
        return data(manager().runs(projectPath).slice(0, 20))
      }
    },
    {
      name: 'pipeline_schema',
      description: 'JSON Schema of a machine file (aide/pipelines/*.json), for authoring machines.',
      inputSchema: OBJECT({}),
      handler: () => data(MACHINE_FILE_SCHEMA)
    },
    {
      name: 'pipeline_guide',
      description: 'How to author pipeline machines and role files for this project: the step tree, loops, contracts, examples. Read before writing machines.',
      inputSchema: OBJECT({}),
      handler: () => {
        const guide = env().authoringGuide?.()
        return guide ? ok(`${guide}\n\n${engineVersionsText()}`) : fail('The authoring guide is not available.')
      }
    },
    {
      name: 'pipeline_smoke',
      description: 'Smoke-test a machine on this computer: every check command runs once, every CLI is found; with pingAgents, every agent CLI answers a trivial headless prompt (costs a little).',
      inputSchema: OBJECT({ machineId: { type: 'string' }, pingAgents: { type: 'boolean' } }, ['machineId']),
      handler: async (args, { projectPath }) => {
        const smoke = env().smoke
        if (!smoke) return fail('Smoke testing is not available.')
        return ok(await smoke(projectPath, String(args.machineId), args.pingAgents === true))
      }
    }
  )
  return tools
}
