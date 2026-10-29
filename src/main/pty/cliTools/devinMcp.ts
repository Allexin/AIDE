import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LaunchMcpServer } from './types'

/**
 * Devin takes MCP servers only from files: it has no launch flag for them, its
 * --config file ignores `mcpServers`, and DEVIN_CONFIG_HOME also moves its
 * sessions and state. AIDE keeps its servers in the project's local Devin config,
 * `.devin/mcp_config.local.json` (Devin's own not-committed file), before every
 * Devin launch, with the paths of the running AIDE; the user's own servers there
 * are kept. The file is shared by the project's Devin tabs, so it has no
 * per-tab environment: the tab's AIDE_TAB_ID reaches the server through Devin's
 * environment.
 */

export const DEVIN_LOCAL_MCP_CONFIG = join('.devin', 'mcp_config.local.json')

/** The servers' entries written into the project's local config; a server turned off is removed. Returns whether the file changed. */
export function syncDevinMcpConfig(projectPath: string, servers: LaunchMcpServer[], managed: string[]): boolean {
  const path = join(projectPath, DEVIN_LOCAL_MCP_CONFIG)
  let root: Record<string, unknown> = {}
  const before = existsSync(path) ? readFileSync(path, 'utf-8') : null
  if (before !== null) {
    try {
      root = JSON.parse(before) as Record<string, unknown>
    } catch (err) {
      throw new Error(`${path} is not valid JSON, left as it is: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const mcpServers = { ...((root.mcpServers ?? {}) as Record<string, unknown>) }
  for (const name of managed) delete mcpServers[name]
  for (const server of servers) mcpServers[server.name] = { command: server.command, args: server.args, env: server.env, transport: 'stdio' }
  if (before === null && servers.length === 0) return false
  const after = JSON.stringify({ ...root, mcpServers }, null, 2) + '\n'
  if (after === before) return false
  mkdirSync(join(projectPath, '.devin'), { recursive: true })
  writeFileSync(path, after, 'utf-8')
  excludeFromGit(projectPath)
  return true
}

/** Keep the file out of commits in a git repository rooted at the project, without touching tracked files. */
function excludeFromGit(projectPath: string): void {
  const gitDir = join(projectPath, '.git')
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return
  const exclude = join(gitDir, 'info', 'exclude')
  const line = '/.devin/mcp_config.local.json'
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : ''
  if (current.split(/\r?\n/).includes(line)) return
  mkdirSync(join(gitDir, 'info'), { recursive: true })
  writeFileSync(exclude, current + (current && !current.endsWith('\n') ? '\n' : '') + line + '\n', 'utf-8')
}
