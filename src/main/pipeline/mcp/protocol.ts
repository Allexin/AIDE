/**
 * Minimal MCP server over JSON-RPC 2.0 — the subset AIDE needs: `initialize`,
 * `ping`, `tools/list`, `tools/call` and notifications. Messages arrive one per
 * HTTP request from the stdio shim (resources/mcp/aide-mcp.cjs), so no
 * transport, session or streaming machinery is required.
 */

import type { PipelineEvent } from '../events'

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface ToolContext {
  projectPath: string
  /** Random id of the shim process — one per agent process. */
  connectionId: string
  /** AIDE tab id of the terminal the agent runs in, when known. */
  tabId: string | null
  clientInfo: { name: string; version: string } | null
  /** Aborted when nobody waits for this call any more; `reason` is 'cancelled' (notifications/cancelled) or 'connection-closed'. */
  signal?: AbortSignal
  /** Called for each pipeline event this call hands to its caller, so a response that cannot be written counts as not delivered. */
  onEventHandedOut?: (event: PipelineEvent) => void
}

/** What the transport knows of a message; McpServer adds the per-request signal and the client info. */
export type RequestContext = Omit<ToolContext, 'clientInfo'>

/** Text only: a tool result lands in the agent's context, so it is never duplicated as structured content. */
export interface ToolResult {
  text: string
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> | ToolResult
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface ServerInfo {
  name: string
  version: string
  /** A function is read at every `initialize`, with the connection that asks, so a changed setting reaches the next session. */
  instructions: string | ((context: RequestContext) => string)
  /** Why a tool that is not in the list cannot be called for this connection (a feature switched off); null: unknown tool. */
  unavailableTool?: (name: string, context: RequestContext) => string | null
}

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INVALID_REQUEST = -32600

function errorResponse(id: JsonRpcMessage['id'], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** JSON-RPC ids are per connection, and 1 and "1" are different ids. */
function requestKey(connectionId: string, requestId: unknown): string {
  return `${connectionId}\n${JSON.stringify(requestId)}`
}

export class McpServer {
  /** clientInfo announced in `initialize`, per shim connection. */
  private readonly clients = new Map<string, { name: string; version: string }>()
  /** Tool calls in progress, by shim connection and request id, so notifications/cancelled can reach them. */
  private readonly inFlight = new Map<string, AbortController>()

  /** `tools` is read for every request with the connection that asks: the list can differ per project (feature switches). */
  constructor(private readonly info: ServerInfo, private readonly tools: (context: RequestContext) => ToolDefinition[]) {}

  clientInfo(connectionId: string): { name: string; version: string } | null {
    return this.clients.get(connectionId) ?? null
  }

  /** Handle one JSON-RPC message (or batch). Returns null when there is nothing to send back. */
  async handle(payload: unknown, context: RequestContext): Promise<unknown> {
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((message) => this.handleOne(message, context)))).filter((r) => r !== null)
      return responses.length > 0 ? responses : null
    }
    return this.handleOne(payload, context)
  }

  private cancel(connectionId: string, requestId: unknown): void {
    this.inFlight.get(requestKey(connectionId, requestId))?.abort('cancelled')
  }

  private async handleOne(raw: unknown, context: RequestContext): Promise<Record<string, unknown> | null> {
    if (!raw || typeof raw !== 'object') return errorResponse(null, ERR_INVALID_REQUEST, 'Invalid request')
    const message = raw as JsonRpcMessage
    const isNotification = message.id === undefined || message.id === null
    if (typeof message.method !== 'string') return isNotification ? null : errorResponse(message.id, ERR_INVALID_REQUEST, 'Missing method')
    if (isNotification) { // notifications/initialized, notifications/cancelled, …
      if (message.method === 'notifications/cancelled') this.cancel(context.connectionId, message.params?.requestId)
      return null
    }

    const params = message.params ?? {}
    switch (message.method) {
      case 'initialize': {
        const client = params.clientInfo as { name?: unknown; version?: unknown } | undefined
        if (client && typeof client.name === 'string') {
          this.clients.set(context.connectionId, { name: client.name, version: typeof client.version === 'string' ? client.version : '' })
        }
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.info.name, version: this.info.version },
            instructions: typeof this.info.instructions === 'function' ? this.info.instructions(context) : this.info.instructions
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id: message.id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: this.tools(context).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
        }
      case 'tools/call': {
        const name = params.name
        const tool = this.tools(context).find((t) => t.name === name)
        if (!tool) {
          const reason = typeof name === 'string' ? this.info.unavailableTool?.(name, context) ?? null : null
          if (reason) return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: reason }], isError: true } }
          return errorResponse(message.id, ERR_INVALID_PARAMS, `Unknown tool: ${String(name)}`)
        }
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {}
        const controller = new AbortController()
        const key = requestKey(context.connectionId, message.id)
        this.inFlight.set(key, controller)
        const transport = context.signal
        const onTransportAbort = (): void => controller.abort(transport?.reason)
        if (transport?.aborted) onTransportAbort()
        else transport?.addEventListener('abort', onTransportAbort, { once: true })
        let result: ToolResult
        try {
          result = await tool.handler(args, { ...context, signal: controller.signal, clientInfo: this.clientInfo(context.connectionId) })
        } catch (err) {
          result = { text: err instanceof Error ? err.message : String(err), isError: true }
        } finally {
          this.inFlight.delete(key)
          transport?.removeEventListener('abort', onTransportAbort)
        }
        // MCP: a cancelled request gets no response.
        if (controller.signal.aborted) return null
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: result.text }],
            ...(result.isError ? { isError: true } : {})
          }
        }
      }
      default:
        return errorResponse(message.id, ERR_METHOD_NOT_FOUND, `Method not found: ${message.method}`)
    }
  }
}
