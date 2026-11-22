import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LaunchMcpServer } from './types'
import { shellLiteral } from './launchFiles'
import { syncDevinMcpConfig } from './devinMcp'
import { syncAntigravityMcpConfig } from './antigravityMcp'
import { buildAntigravityTabSettings } from './antigravityHooks'
import { codexMcpArgs } from './codex'
import { claudeMcpConfig, claudeMcpEnv } from './claudeCode'
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
  toolTimeoutSec: 3100
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
      " -c 'mcp_servers.aide.tool_timeout_sec=3100'"
    )
    expect(() => codexMcpArgs([{ ...server, command: String.raw`C:\O'Brien\AIDE.exe` }], 'win32')).toThrow(/single quote/)
  })

  it('gives Claude Code, Cursor and OpenCode the server with the tab identity', () => {
    const env = { ...server.env, ...server.tabEnv }
    expect(JSON.parse(claudeMcpConfig([server]))).toEqual({ mcpServers: { aide: { type: 'stdio', command: server.command, args: server.args, env } } })
    expect(claudeMcpEnv([server], {})).toBeUndefined()
    expect(claudeMcpEnv([{ ...server, eagerTools: ['task_snapshot'] }], {})).toEqual({ ENABLE_TOOL_SEARCH: 'false' })
    expect(claudeMcpEnv([{ ...server, eagerTools: ['task_snapshot'] }], { ENABLE_TOOL_SEARCH: 'auto:5' })).toBeUndefined()
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

  it("keeps Antigravity's .agents/mcp_config.json with timeoutSeconds, excludes it from git, and builds per-tab settings", () => {
    const project = tempDir()
    mkdirSync(join(project, '.git', 'info'), { recursive: true })
    writeFileSync(join(project, '.git', 'info', 'exclude'), '# local\n')
    mkdirSync(join(project, '.agents'))
    const path = join(project, '.agents', 'mcp_config.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { mine: { command: 'node', args: ['x.js'] } } }))

    const agyServer: LaunchMcpServer = { ...server, eagerTools: ['task_snapshot', 'agent_list', 'agent_send'] }
    expect(syncAntigravityMcpConfig(project, [agyServer], ['aide'])).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers).toEqual({
      mine: { command: 'node', args: ['x.js'] },
      aide: {
        command: server.command,
        args: server.args,
        env: server.env,
        timeoutSeconds: 3100,
        tools: {
          task_snapshot: { eager: true },
          agent_list: { eager: true },
          agent_send: { eager: true }
        }
      }
    })
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8')).toBe('# local\n/.agents/mcp_config.json\n')
    expect(syncAntigravityMcpConfig(project, [agyServer], ['aide'])).toBe(false)

    // Turned off: AIDE's entry goes, user's stays.
    expect(syncAntigravityMcpConfig(project, [], ['aide'])).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).mcpServers)).toEqual(['mine'])

    // Per-tab --settings merges permissions, trusts workspace, and wires title hook only when user has none.
    const winSettings = buildAntigravityTabSettings({
      tabId: 'tab-3',
      projectPath: project,
      hook: { port: 12345, token: 'tok' },
      mcpServerNames: ['aide'],
      userSettings: { permissions: { allow: ['command(git)'], deny: ['write_file(.env)'] }, trustedWorkspaces: ['C:\\Other'] },
      curlPath: 'C:\\Windows\\System32\\curl.exe',
      platform: 'win32'
    })
    expect(winSettings).toMatchObject({
      trustedWorkspaces: ['C:\\Other', project],
      permissions: { allow: ['command(git)', 'mcp(aide/*)'], deny: ['write_file(.env)'] },
      title: { type: 'command', enabled: true }
    })
    const winCmd = (winSettings?.title as { command: string }).command
    expect(winCmd).toBe('C:\\Windows\\System32\\curl.exe -s -m 2 -X POST http://127.0.0.1:12345/hook?tab=tab-3^&event=Title^&token=tok --data-binary @-')
    expect(winCmd).not.toContain('"')

    const linuxSettings = buildAntigravityTabSettings({
      tabId: 'tab-3',
      projectPath: project,
      hook: { port: 12345, token: 'tok' },
      mcpServerNames: [],
      userSettings: { trustedWorkspaces: [project] },
      curlPath: '/usr/bin/curl',
      platform: 'linux'
    })
    expect((linuxSettings?.title as { command: string }).command).toBe(
      '"/usr/bin/curl" -s -m 2 -X POST "http://127.0.0.1:12345/hook?tab=tab-3&event=Title&token=tok" --data-binary @-'
    )

    // Preserves a user-configured title command.
    const withUserTitle = buildAntigravityTabSettings({
      tabId: 'tab-3',
      projectPath: project,
      hook: { port: 12345, token: 'tok' },
      mcpServerNames: [],
      userSettings: { trustedWorkspaces: [project], title: { type: 'command', command: '~/my-title.sh' } },
      curlPath: 'curl'
    })
    expect(withUserTitle).toBeNull()
  })
})
