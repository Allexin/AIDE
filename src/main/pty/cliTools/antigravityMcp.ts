import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LaunchMcpServer } from './types'

/**
 * Antigravity CLI loads workspace MCP servers from `.agents/mcp_config.json`
 * (it has no per-launch `--mcp-config` flag). Before each Antigravity launch,
 * AIDE keeps its managed entries in `.agents/mcp_config.json` with the paths of
 * the running AIDE while preserving the user's own servers there, and removes
 * AIDE's entry when the setting is turned off.
 *
 * The file is shared by all Antigravity tabs open in the project, so it carries
 * no `tabEnv`; Antigravity forwards its own environment (including `AIDE_TAB_ID`
 * and `AIDE_PROJECT`) to stdio MCP servers it spawns.
 */

export const ANTIGRAVITY_MCP_CONFIG = join('.agents', 'mcp_config.json')

/** Write AIDE's managed MCP servers into `.agents/mcp_config.json`, or remove them when empty. Returns true if the file changed. */
export function syncAntigravityMcpConfig(projectPath: string, servers: LaunchMcpServer[], managed: string[]): boolean {
  const path = join(projectPath, ANTIGRAVITY_MCP_CONFIG)
  let root: Record<string, unknown> = {}
  const before = existsSync(path) ? readFileSync(path, 'utf-8') : null
  if (before !== null) {
    try {
      const parsed: unknown = JSON.parse(before)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('root must be a JSON object')
      }
      root = parsed as Record<string, unknown>
    } catch (err) {
      throw new Error(`${path} is not valid JSON, left as it is: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const mcpServers = { ...((root.mcpServers ?? {}) as Record<string, unknown>) }
  for (const name of managed) delete mcpServers[name]
  for (const server of servers) {
    const entry: Record<string, unknown> = {
      command: server.command,
      args: server.args,
      env: server.env
    }
    if (server.toolTimeoutSec) entry.timeoutSeconds = server.toolTimeoutSec
    if (server.eagerTools && server.eagerTools.length > 0) {
      const tools: Record<string, { eager: true }> = {}
      for (const name of server.eagerTools) tools[name] = { eager: true }
      entry.tools = tools
    }
    mcpServers[server.name] = entry
  }

  if (before === null && servers.length === 0) return false
  const after = JSON.stringify({ ...root, mcpServers }, null, 2) + '\n'
  if (after === before) return false

  mkdirSync(join(projectPath, '.agents'), { recursive: true })
  writeFileSync(path, after, 'utf-8')
  excludeFromGit(projectPath)
  return true
}

/** Keep `.agents/mcp_config.json` out of commits in a git repository rooted at the project, without touching tracked files. */
function excludeFromGit(projectPath: string): void {
  const gitDir = join(projectPath, '.git')
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return
  const exclude = join(gitDir, 'info', 'exclude')
  const line = '/.agents/mcp_config.json'
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : ''
  if (current.split(/\r?\n/).includes(line)) return
  mkdirSync(join(gitDir, 'info'), { recursive: true })
  writeFileSync(exclude, current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n', 'utf-8')
}
