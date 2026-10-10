import type { ToolDefinition, ToolResult } from './protocol'
import { orchestrators } from '../orchestrators'
import { pipelineEvents, SIGNIFICANT_EVENTS, type PipelineEvent } from '../events'
import type { PipelineManager } from '../manager'
import { MACHINE_FILE_SCHEMA } from '../engine/machineSchema'

/**
 * Pipeline MCP tools — the orchestrator's interface to AIDE (plan §4.2).
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
  'AIDE executes pipeline state machines deterministically: it spawns step agents, runs checks, repeats loops, commits and reports. You decide what to run: pick the next task from the project plan, choose a machine and its parameters, start it, read the report, update the plan, and talk to the user.',
  'While a run is executing, leave the working tree to it: do not edit files yourself.',
  'After starting a run, subscribe to its events instead of polling when your client can run background commands.'
]

function eventDeliveryText(launcherPath: string): string {
  return [
    'Event delivery, best first:',
    `1. Background command / monitor: "${launcherPath}" events --run <runId> --since <lastEventId>  — one JSON event per line; or "${launcherPath}" wait --run <runId> --since <lastEventId>  — prints the next significant event and exits.`,
    '2. Without background commands: call pipeline_wait (blocks until the next significant event or a timeout).',
    '3. Last resort: poll pipeline_status.',
    'Always pass the last event id you have seen as `since`, so no event is lost across reconnects.'
  ].join('\n')
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return { text, structured }
}

function fail(text: string): ToolResult {
  return { text, isError: true }
}

const OBJECT = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false })

const RUN_ID = { type: 'string', description: 'Run id; defaults to the active run.' }

function waitForEvent(projectPath: string, runId: string | null, since: number, timeoutSec: number): Promise<PipelineEvent | null> {
  const pending = pipelineEvents.since(projectPath, runId, since).find((e) => SIGNIFICANT_EVENTS.has(e.type))
  if (pending) return Promise.resolve(pending)
  return new Promise((resolve) => {
    const unsubscribe = pipelineEvents.subscribe(projectPath, (event) => {
      if ((runId === null || event.runId === runId) && SIGNIFICANT_EVENTS.has(event.type)) { clearTimeout(timer); unsubscribe(); resolve(event) }
    })
    const timer = setTimeout(() => { unsubscribe(); resolve(null) }, timeoutSec * 1000)
  })
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
        return ok(text, { aideVersion, projectPath: context.projectPath, tabId: context.tabId, client: context.clientInfo, eventLauncher: launcherPath, doc: docPath })
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
        const list = machines.map((m) => ({ id: m.id, name: m.name, description: m.description, params: m.params ?? {}, source: m.source, valid: m.validation.errors.length === 0, errors: m.validation.errors }))
        if (list.length === 0 && errors.length === 0) return ok('No machines yet. Machines live in aide/pipelines/*.json; call pipeline_guide to learn how to write them.', { machines: [] })
        return ok(json({ machines: list, unreadableFiles: errors }), { machines: list, unreadableFiles: errors })
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
        return ok((allValid ? 'All valid.\n' : 'Problems found.\n') + json(result), result)
      }
    },
    {
      name: 'pipeline_start',
      description: 'Start a run of a machine with params. Only one run per project can be active. Returns the run id and how to subscribe to its events.',
      inputSchema: OBJECT({ machine: { type: 'string', description: 'Machine id from pipeline_list.' }, params: { type: 'object', description: 'Values for the machine params.' } }, ['machine']),
      handler: async (args, { projectPath }) => {
        try {
          const { runId, warnings } = await manager().start(projectPath, String(args.machine), (args.params as Record<string, unknown>) ?? {})
          const launcher = env().launcherPath
          const text = [
            `Run ${runId} started.`,
            ...warnings.map((w) => `Warning: ${w}`),
            `Subscribe to its events now: "${launcher}" events --run ${runId} --since 0  (or call pipeline_wait with runId "${runId}").`,
            'Leave the working tree to the run while it executes.'
          ].join('\n')
          return ok(text, { runId, warnings, subscribe: `"${launcher}" events --run ${runId} --since 0` })
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_status',
      description: 'Status of the active run (or a given run): current step, loop iterations, visits, pending escalation, recent events.',
      inputSchema: OBJECT({ runId: RUN_ID }),
      handler: (args, { projectPath }) => {
        const m = manager()
        const run = m.activeRun(projectPath)
        const runId = typeof args.runId === 'string' ? args.runId : run?.runId
        if (!runId) return ok('No active run.', { active: false, recentRuns: m.runs(projectPath).slice(0, 5) })
        if (run && run.runId === runId) {
          const recent = pipelineEvents.since(projectPath, runId, 0).slice(-10)
          const status = { ...run.describe(), recentEvents: recent }
          return ok(json(status), status)
        }
        const state = m.runState(projectPath, runId)
        return state ? ok(json({ runId, status: state.status, result: state.result }), { runId, status: state.status, result: state.result }) : fail(`Unknown run ${runId}.`)
      }
    },
    {
      name: 'pipeline_wait',
      description: 'Block until the next significant event of a run (escalation, failed check, commit, pause, stop, end) or a timeout. Use when you cannot run background commands.',
      inputSchema: OBJECT({ runId: { type: 'string' }, since: { type: 'number', description: 'Last event id you have seen.' }, timeoutSec: { type: 'number', description: 'Default 240, max 1800.' } }, ['runId']),
      handler: async (args, { projectPath }) => {
        const timeout = Math.min(Math.max(Number(args.timeoutSec ?? 240) || 240, 1), 1800)
        const event = await waitForEvent(projectPath, String(args.runId), Number(args.since ?? 0) || 0, timeout)
        return event ? ok(json(event), event as unknown as Record<string, unknown>) : ok('No significant event before the timeout. Call again with the same since.', { type: 'timeout' })
      }
    },
    {
      name: 'pipeline_answer',
      description: 'Answer a pending escalation. action: continue (go on after the step; approve a gate; leave an exhausted loop as if it passed), reject (reject a gate: repeats its loop, or fails the run outside loops), retry (run the step again; for an exhausted loop: one more iteration), stop (end the run).',
      inputSchema: OBJECT({ escalationId: { type: 'string' }, action: { type: 'string', enum: ['continue', 'retry', 'reject', 'stop'] }, text: { type: 'string', description: 'Your answer; shown to the later agents of the run.' }, runId: RUN_ID }, ['escalationId', 'action']),
      handler: async (args, { projectPath }) => {
        try {
          await manager().answer(projectPath, String(args.escalationId), { action: args.action as 'continue' | 'retry' | 'reject' | 'stop', text: String(args.text ?? ''), by: 'orchestrator' }, typeof args.runId === 'string' ? args.runId : undefined)
          return ok('Answer recorded; the run continues.')
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_stop',
      description: 'pause: finish the current step, then hold. stop: interrupt the current step now (resumable). abandon: end a stopped/paused run for good.',
      inputSchema: OBJECT({ mode: { type: 'string', enum: ['pause', 'stop', 'abandon'] }, reason: { type: 'string' }, runId: RUN_ID }, ['mode']),
      handler: async (args, { projectPath }) => {
        const runId = typeof args.runId === 'string' ? args.runId : undefined
        try {
          if (args.mode === 'pause') manager().pause(projectPath, runId)
          else if (args.mode === 'stop') await manager().stop(projectPath, runId)
          else manager().abandon(projectPath, String(args.reason ?? 'abandoned by the orchestrator'), runId)
          return ok(`Done: ${String(args.mode)}.`)
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_resume',
      description: 'Continue a paused or stopped run from where it stopped.',
      inputSchema: OBJECT({ runId: RUN_ID }),
      handler: (args, { projectPath }) => {
        try {
          manager().resume(projectPath, typeof args.runId === 'string' ? args.runId : undefined)
          return ok('Resumed.')
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err))
        }
      }
    },
    {
      name: 'pipeline_report',
      description: 'Report of a run: facts collected by AIDE (visits, outcomes, commits, cost), agent summaries, non-blocking findings, escalations.',
      inputSchema: OBJECT({ runId: { type: 'string' } }, ['runId']),
      handler: (args, { projectPath }) => {
        const report = manager().report(projectPath, String(args.runId))
        return report ? ok(json(report), report as Record<string, unknown>) : fail(`No report for run ${String(args.runId)}.`)
      }
    },
    {
      name: 'pipeline_runs',
      description: 'Recent runs of this project with their status.',
      inputSchema: OBJECT({}),
      handler: (_args, { projectPath }) => {
        const runs = manager().runs(projectPath)
        return ok(json(runs), { runs })
      }
    },
    {
      name: 'pipeline_schema',
      description: 'JSON Schema of a machine file (aide/pipelines/*.json), for authoring machines.',
      inputSchema: OBJECT({}),
      handler: () => ok(json(MACHINE_FILE_SCHEMA), MACHINE_FILE_SCHEMA as unknown as Record<string, unknown>)
    },
    {
      name: 'pipeline_guide',
      description: 'How to author pipeline machines and role files for this project: primitives, routing, contracts, examples. Read before writing machines.',
      inputSchema: OBJECT({}),
      handler: () => {
        const guide = env().authoringGuide?.()
        return guide ? ok(guide) : fail('The authoring guide is not available.')
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
