import type { ToolDefinition } from './protocol'
import { orchestrators } from '../orchestrators'

/**
 * Pipeline MCP tools. Phase 0 ships the handshake; the run-control tools
 * (pipeline_list, pipeline_start, pipeline_status, …) are added with the engine.
 */

export interface ToolEnvironment {
  aideVersion: string
  /** Shell launcher for the event feed (`<launcher> events --run <id>`). */
  launcherPath: string
  /** Project-relative path of the orchestration doc. */
  docPath: string
}

export const ORCHESTRATOR_RULES = [
  'You are the orchestrator of AIDE pipelines for this project.',
  'AIDE executes pipeline state machines deterministically: it spawns node agents, runs checks, loops, commits and reports. You decide what to run: pick the next task from the project plan, choose a machine and its parameters, start it, read the report, update the plan, and talk to the user.',
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

export function buildPipelineTools(env: () => ToolEnvironment): ToolDefinition[] {
  return [
    {
      name: 'pipeline_hello',
      description: 'Handshake with AIDE. Call once after connecting: confirms the connection and returns the orchestrator rules and how to receive pipeline events.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
        return {
          text,
          structured: {
            aideVersion,
            projectPath: context.projectPath,
            tabId: context.tabId,
            client: context.clientInfo,
            eventLauncher: launcherPath,
            doc: docPath
          }
        }
      }
    }
  ]
}
