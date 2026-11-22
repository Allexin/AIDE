import type { ToolContext, ToolDefinition } from './protocol'
import type { AgentInfo, AgentSendResult } from '../../agents/agentMessaging'

/** `agent_list` and `agent_send`: inter-agent discovery and fire-and-forget messaging. */

export interface AgentToolEnvironment {
  list?: (projectPath: string, tabId: string | null, scope: 'project' | 'all') => Promise<AgentInfo[]>
  send?: (projectPath: string, tabId: string | null, to: string, message: string) => Promise<AgentSendResult>
}

export function buildAgentTools(env: () => AgentToolEnvironment): ToolDefinition[] {
  return [
    {
      name: 'agent_list',
      description:
        'List running interactive AI agent tabs in AIDE. Default scope is "project" (this project only); ' +
        'pass scope: "all" to list agents across all open AIDE windows on this machine. ' +
        'Returns each agent\'s id (use with agent_send), title, tool, status (idle/busy/starting), whether the user has unsent text in its input box, and its current task if any.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['project', 'all'],
            description: 'Which agents to list: "project" (default, current project only) or "all" (every open AIDE project on this machine).'
          }
        },
        additionalProperties: false
      },
      handler: async (args, context: ToolContext) => {
        const list = env().list
        if (!list) return { text: 'Agent messaging is not available in this AIDE instance.', isError: true }
        const rawScope = args.scope
        if (rawScope !== undefined && rawScope !== 'project' && rawScope !== 'all') {
          return { text: '"scope" must be "project" or "all".', isError: true }
        }
        const scope = rawScope ?? 'project'
        const agents = await list(context.projectPath, context.tabId, scope)
        return { text: JSON.stringify({ scope, agents }) }
      }
    },
    {
      name: 'agent_send',
      description:
        'Send a message to another running AI agent tab in AIDE (fire-and-forget; does not wait for a reply). ' +
        'Delivers right away when the target is idle, queues until idle when busy, and refuses when the user has unsent text in the target tab\'s input box.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Target agent "id" from agent_list (e.g. "<projectKey>:<tabId>"), or a bare tabId for a tab in the same project.'
          },
          message: {
            type: 'string',
            description: 'Message text to send to the target agent.'
          }
        },
        required: ['to', 'message'],
        additionalProperties: false
      },
      handler: async (args, context: ToolContext) => {
        const send = env().send
        if (!send) return { text: 'Agent messaging is not available in this AIDE instance.', isError: true }
        if (typeof args.to !== 'string' || !args.to.trim()) {
          return { text: '"to" is required.', isError: true }
        }
        if (typeof args.message !== 'string' || !args.message.trim()) {
          return { text: '"message" is required.', isError: true }
        }
        const result = await send(context.projectPath, context.tabId, args.to, args.message)
        if (result.status === 'rejected' || result.status === 'failed') {
          return { text: JSON.stringify(result), isError: true }
        }
        return { text: JSON.stringify(result) }
      }
    }
  ]
}
