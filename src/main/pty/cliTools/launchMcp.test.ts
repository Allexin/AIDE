import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LaunchMcpServer } from './types'
import { shellLiteral } from './launchFiles'
import { syncDevinMcpConfig } from './devinMcp'
import { codexMcpArgs } from './codex'
import { claudeMcpConfig } from './claudeCode'
import { cursorMcpPlugin } from './cursorAgent'
import { openCodeMcpConfigContent } from './openCode'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aide-launch-mcp-'))
  dirs.push(dir)
  return dir
}

const server: LaunchMcpServer = {
  name: 'aide',
  command: String.raw`C:\Program Files\AIDE\AIDE.exe`,
  args: [String.raw`C:\Program Files\AIDE\resources\app.asar.unpacked\resources\mcp\aide-mcp.cjs`, 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1', AIDE_RUNTIME_DIR: String.raw`C:\Users\me\AppData\Roaming\aide\runtime` },
  tabEnv: { AIDE_TAB_ID: 'tab-3', AIDE_PROJECT: String.raw`D:\Games\Re Engine` },
  toolTimeoutSec: 1900
}

describe('AIDE MCP server at launch', () => {
  it('quotes one literal argument for PowerShell and sh', () => {
    expect(shellLiteral("it's", 'win32')).toBe("'it''s'")
    expect(shellLiteral("it's", 'linux')).toBe(String.raw`'it'\''s'`)
    expect(() => shellLiteral('say "hi"', 'win32')).toThrow(/double quote/)
  })

  it('gives Codex the server as -c overrides with TOML literal strings', () => {
    const args = codexMcpArgs([server], 'win32')
    expect(args).toBe(
      String.raw` -c 'mcp_servers.aide.command=''C:\Program Files\AIDE\AIDE.exe'''` +
      String.raw` -c 'mcp_servers.aide.args=[''C:\Program Files\AIDE\resources\app.asar.unpacked\resources\mcp\aide-mcp.cjs'',''mcp'']'` +
      String.raw` -c 'mcp_servers.aide.env={ELECTRON_RUN_AS_NODE=''1'',AIDE_RUNTIME_DIR=''C:\Users\me\AppData\Roaming\aide\runtime'',AIDE_TAB_ID=''tab-3'',AIDE_PROJECT=''D:\Games\Re Engine''}'` +
      " -c 'mcp_servers.aide.tool_timeout_sec=1900'"
    )
    expect(() => codexMcpArgs([{ ...server, command: String.raw`C:\O'Brien\AIDE.exe` }], 'win32')).toThrow(/single quote/)
  })

  it('gives Claude Code, Cursor and OpenCode the server with the tab identity', () => {
    const env = { ...server.env, ...server.tabEnv }
    expect(JSON.parse(claudeMcpConfig([server]))).toEqual({ mcpServers: { aide: { type: 'stdio', command: server.command, args: server.args, env } } })
    expect(JSON.parse(cursorMcpPlugin([server]))).toMatchObject({ name: 'aide', mcpServers: { aide: { command: server.command, args: server.args, env } } })
    const content = JSON.parse(openCodeMcpConfigContent([server], JSON.stringify({ theme: 'dark', mcp: { mine: { type: 'remote', url: 'http://x' } } })))
    expect(content).toEqual({
      theme: 'dark',
      mcp: { mine: { type: 'remote', url: 'http://x' }, aide: { type: 'local', command: [server.command, ...server.args], environment: env, enabled: true } }
    })
  })

  it("keeps Devin's local project config: AIDE's entry without the tab identity, the user's servers kept", () => {
    const project = tempDir()
    mkdirSync(join(project, '.git', 'info'), { recursive: true })
    writeFileSync(join(project, '.git', 'info', 'exclude'), '# local\n')
    mkdirSync(join(project, '.devin'))
    const path = join(project, '.devin', 'mcp_config.local.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { mine: { command: 'node', args: ['x.js'], transport: 'stdio' } } }))

    expect(syncDevinMcpConfig(project, [server], ['aide'])).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers).toEqual({
      mine: { command: 'node', args: ['x.js'], transport: 'stdio' },
      aide: { command: server.command, args: server.args, env: server.env, transport: 'stdio' }
    })
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8')).toBe('# local\n/.devin/mcp_config.local.json\n')
    expect(syncDevinMcpConfig(project, [server], ['aide'])).toBe(false)

    // Turned off: AIDE's entry goes, the user's stays.
    expect(syncDevinMcpConfig(project, [], ['aide'])).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).mcpServers)).toEqual(['mine'])
  })

  it('writes no Devin config when there is nothing to add, and leaves a broken one alone', () => {
    const project = tempDir()
    expect(syncDevinMcpConfig(project, [], ['aide'])).toBe(false)
    expect(existsSync(join(project, '.devin'))).toBe(false)
    mkdirSync(join(project, '.devin'))
    writeFileSync(join(project, '.devin', 'mcp_config.local.json'), '{ broken')
    expect(() => syncDevinMcpConfig(project, [server], ['aide'])).toThrow(/not valid JSON/)
    expect(readFileSync(join(project, '.devin', 'mcp_config.local.json'), 'utf-8')).toBe('{ broken')
  })
})
