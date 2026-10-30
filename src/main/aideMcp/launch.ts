import { getToolConfig } from '../config/appConfig'
import type { CliTool, LaunchMcpServer, SettingsField } from '../pty/cliTools/types'

/**
 * AIDE's MCP server in CLI tabs. AIDE adds it to every launch of a CLI that
 * supports it (CliTool.aideMcp, CliTool.prepareLaunch), with the paths of the
 * running AIDE, so no CLI config holds a path that can go stale. A per-CLI
 * setting, on by default. The server carries pipeline orchestration today and
 * may carry other AIDE tools later. See docs/aide-mcp-launch.md.
 */

export const AIDE_MCP_KEY = 'aideMcpServer'
export const AIDE_MCP_SERVER_NAME = 'aide'

/** Waiting for a pipeline run blocks a tool call for up to 50 minutes. */
const TOOL_TIMEOUT_SEC = 3100

const DEFAULT_NOTE = "Adds AIDE's MCP server (pipeline orchestration and other AIDE tools) to every launch of this CLI from AIDE, with the paths of the running AIDE; the CLI's own config is not changed"

/** The per-CLI setting, or null for a CLI that does not declare AIDE MCP support either way. */
export function aideMcpField(tool: CliTool): SettingsField | null {
  if (!tool.aideMcp) return null
  return {
    key: AIDE_MCP_KEY,
    label: "Give AIDE's MCP server to this CLI",
    description: tool.aideMcp.note ?? DEFAULT_NOTE,
    type: 'boolean',
    default: tool.aideMcp.supported,
    disabled: !tool.aideMcp.supported
  }
}

export function aideMcpEnabled(tool: CliTool): boolean {
  return tool.aideMcp?.supported === true && getToolConfig(tool.id)[AIDE_MCP_KEY] !== false
}

/** How to start the server: AIDE's executable running the shim. */
export interface AideMcpCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

/** The MCP servers for one launch of a tab: AIDE's server when the CLI has it turned on. */
export function aideMcpServers(tool: CliTool, tabId: string, projectPath: string, launch: AideMcpCommand): LaunchMcpServer[] {
  if (!aideMcpEnabled(tool)) return []
  return [{
    name: AIDE_MCP_SERVER_NAME,
    command: launch.command,
    args: launch.args,
    env: launch.env,
    tabEnv: { AIDE_TAB_ID: tabId, AIDE_PROJECT: projectPath },
    toolTimeoutSec: TOOL_TIMEOUT_SEC
  }]
}
