import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { pruneStaleRuntimes, removeProjectRuntime, shimLaunch, writeLauncher, writeProjectRuntime } from './runtimeFiles'

const SHIM = resolve(__dirname, '../../../../resources/mcp/aide-mcp.cjs')
const root = mkdtempSync(join(tmpdir(), 'aide-runtime-files-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('runtime files', () => {
  it('writes and removes a per-project discovery file', () => {
    const dir = join(root, 'rt1')
    writeProjectRuntime(dir, 'C:\\Projects\\Foo', 1234, 'secret')
    expect(readdirSync(join(dir, 'projects'))).toHaveLength(1)
    removeProjectRuntime(dir, 'C:\\Projects\\Foo')
    expect(readdirSync(join(dir, 'projects'))).toHaveLength(0)
  })

  it('prunes discovery files of dead processes', () => {
    const dir = join(root, 'rt2')
    mkdirSync(join(dir, 'projects'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'dead.json'), JSON.stringify({ projectPath: 'x', port: 1, token: 't', pid: 999999 }))
    writeFileSync(join(dir, 'projects', 'live.json'), JSON.stringify({ projectPath: 'y', port: 1, token: 't', pid: process.pid }))
    pruneStaleRuntimes(dir, (pid) => pid === process.pid)
    expect(readdirSync(join(dir, 'projects'))).toEqual(['live.json'])
  })

  it('describes the MCP launch without ports or secrets', () => {
    const launch = shimLaunch('C:\\AIDE\\AIDE.exe', 'C:\\AIDE\\shim.cjs', 'C:\\rt')
    expect(launch).toEqual({ command: 'C:\\AIDE\\AIDE.exe', args: ['C:\\AIDE\\shim.cjs', 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', AIDE_RUNTIME_DIR: 'C:\\rt' } })
  })

  it('writes a launcher that runs the shim', () => {
    const dir = join(root, 'rt3')
    const launcher = writeLauncher(dir, process.execPath, SHIM)
    expect(existsSync(launcher)).toBe(true)
    // No AIDE serves this directory, so `wait` must fail fast with exit code 3.
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/c', launcher, 'wait', '--run', 'x'], { cwd: root, encoding: 'utf8' })
      : spawnSync(launcher, ['wait', '--run', 'x'], { cwd: root, encoding: 'utf8' })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('not running')
  })
})
