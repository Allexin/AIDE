import { EventEmitter } from 'events'

/**
 * Agents that have connected to AIDE's pipeline MCP server and completed the
 * `pipeline_hello` handshake — i.e. eligible orchestrators. Used by the
 * orchestration setup wizard to detect success and to show who is connected.
 */

export interface OrchestratorConnection {
  projectPath: string
  connectionId: string
  tabId: string | null
  client: { name: string; version: string } | null
  connectedAt: string
}

class OrchestratorRegistry extends EventEmitter {
  private readonly connections = new Map<string, OrchestratorConnection>()

  /** Record a handshake; emits 'connected' with the connection. */
  hello(connection: Omit<OrchestratorConnection, 'connectedAt'>): OrchestratorConnection {
    const entry = { ...connection, connectedAt: new Date().toISOString() }
    this.connections.set(connection.connectionId, entry)
    this.emit('connected', entry)
    return entry
  }

  /**
   * The user submitted input in a terminal tab. A `pipeline_wait` blocked in that
   * tab's agent returns early, so the agent sees the message instead of holding it
   * until the next pipeline event.
   */
  userInput(tabId: string, data: string): void {
    if (!data.includes('\r') || data.startsWith('\x1b[200~')) return // not a submit (or a paste)
    this.emit('input', tabId)
  }

  forProject(projectPath: string): OrchestratorConnection[] {
    return [...this.connections.values()].filter((c) => c.projectPath === projectPath)
  }

  forgetProject(projectPath: string): void {
    for (const [id, c] of this.connections) if (c.projectPath === projectPath) this.connections.delete(id)
  }
}

export const orchestrators = new OrchestratorRegistry()
