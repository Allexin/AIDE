/**
 * Minimal MCP server over JSON-RPC 2.0 — the subset AIDE needs: `initialize`,
 * `ping`, `tools/list`, `tools/call` and notifications. Messages arrive one per
 * HTTP request from the stdio shim (resources/mcp/aide-mcp.cjs), so no
 * transport, session or streaming machinery is required.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface ToolContext {
  projectPath: string
  /** Random id of the shim process — one per agent process. */
  connectionId: string
  /** AIDE tab id of the terminal the agent runs in, when known. */
  tabId: string | null
  clientInfo: { name: string; version: string } | null
}

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
  instructions: string
}

const ERR_METHOD_NOT_FOUND = -32601
const ERR_INVALID_PARAMS = -32602
const ERR_INVALID_REQUEST = -32600

function errorResponse(id: JsonRpcMessage['id'], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export class McpServer {
  /** clientInfo announced in `initialize`, per shim connection. */
  private readonly clients = new Map<string, { name: string; version: string }>()

  constructor(private readonly info: ServerInfo, private readonly tools: () => ToolDefinition[]) {}

  clientInfo(connectionId: string): { name: string; version: string } | null {
    return this.clients.get(connectionId) ?? null
  }

  /** Handle one JSON-RPC message (or batch). Returns null when there is nothing to send back. */
  async handle(payload: unknown, context: Omit<ToolContext, 'clientInfo'>): Promise<unknown> {
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((message) => this.handleOne(message, context)))).filter((r) => r !== null)
      return responses.length > 0 ? responses : null
    }
    return this.handleOne(payload, context)
  }

  private async handleOne(raw: unknown, context: Omit<ToolContext, 'clientInfo'>): Promise<Record<string, unknown> | null> {
    if (!raw || typeof raw !== 'object') return errorResponse(null, ERR_INVALID_REQUEST, 'Invalid request')
    const message = raw as JsonRpcMessage
    const isNotification = message.id === undefined || message.id === null
    if (typeof message.method !== 'string') return isNotification ? null : errorResponse(message.id, ERR_INVALID_REQUEST, 'Missing method')
    if (isNotification) return null // notifications/initialized, notifications/cancelled, …

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
            instructions: this.info.instructions
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id: message.id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
        }
      case 'tools/call': {
        const name = params.name
        const tool = this.tools().find((t) => t.name === name)
        if (!tool) return errorResponse(message.id, ERR_INVALID_PARAMS, `Unknown tool: ${String(name)}`)
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {}
        let result: ToolResult
        try {
          result = await tool.handler(args, { ...context, clientInfo: this.clientInfo(context.connectionId) })
        } catch (err) {
          result = { text: err instanceof Error ? err.message : String(err), isError: true }
        }
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
