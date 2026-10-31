import { spawn, spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The real helper against a fake install folder: a copy of cmd.exe stands in for AIDE.exe.
const SCRIPT = resolve(__dirname, '../../../resources/updater/apply-update.ps1')
const CMD = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')

let root: string
let install: string
let update: string
let build: string

function config(args: string[], limits: { exit?: number; start?: number } = {}): string {
  const path = join(update, 'apply.json')
  writeFileSync(path, JSON.stringify({
    installDir: install,
    newDir: build,
    exeName: 'AIDE.exe',
    args,
    workingDir: root,
    exitLimitSeconds: limits.exit ?? 10,
    startLimitSeconds: limits.start ?? 10
  }))
  return path
}

function runHelper(configPath: string): void {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ConfigPath', configPath], { encoding: 'utf8', timeout: 60_000 })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}

const result = (): { ok: boolean; error: string } => JSON.parse(readFileSync(join(update, 'result.json'), 'utf8'))
const marker = (name: string): string => readFileSync(join(install, name), 'utf8')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aide-apply-'))
  install = join(root, 'AIDE')
  update = join(install, '.update')
  build = join(update, 'staging-1', 'unpacked')
  mkdirSync(join(install, 'resources'), { recursive: true })
  mkdirSync(join(build, 'resources'), { recursive: true })
  copyFileSync(CMD, join(install, 'AIDE.exe'))
  copyFileSync(CMD, join(build, 'AIDE.exe'))
  writeFileSync(join(install, 'resources', 'version.txt'), 'old')
  writeFileSync(join(build, 'resources', 'version.txt'), 'new')
  writeFileSync(join(install, 'keep-me.txt'), 'user file')
})

afterEach(() => {
  // The fake app has just run: an antivirus may hold the fresh executable for a while.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // Left in the temp folder.
  }
})

describe.runIf(process.platform === 'win32')('apply-update.ps1', () => {
  it('swaps the build, starts it and removes the old files', () => {
    // "AIDE" reports in as the new version does, and stays for a moment.
    runHelper(config(['/c', `echo 1> ${join(update, 'started')}`]))
    expect(result().ok).toBe(true)
    expect(marker('resources/version.txt')).toBe('new')
    expect(marker('keep-me.txt')).toBe('user file')
    expect(existsSync(join(update, 'old'))).toBe(false)
  }, 60_000)

  it('restores the old build when the new one exits without reporting in', () => {
    runHelper(config(['/c', 'exit 1']))
    expect(result().ok).toBe(false)
    expect(result().error).toContain('previous version was restored')
    expect(marker('resources/version.txt')).toBe('old')
    expect(existsSync(join(build, 'resources', 'version.txt'))).toBe(true)
  }, 60_000)

  it('waits for the running app and gives up at the limit without touching anything', async () => {
    // cmd.exe with an open stdin: runs until killed, with no child to outlive it.
    const running = spawn(join(install, 'AIDE.exe'), ['/k'], { stdio: ['pipe', 'ignore', 'ignore'] })
    try {
      runHelper(config(['/c', 'exit 0'], { exit: 1 }))
    } finally {
      running.kill()
      await new Promise((done) => running.once('exit', done))
    }
    expect(result().ok).toBe(false)
    expect(result().error).toContain('still running')
    expect(marker('resources/version.txt')).toBe('old')
  }, 60_000)

  it('stops an MCP shim, which only holds the files', () => {
    const shim = spawn(join(install, 'AIDE.exe'), ['/k', 'rem aide-mcp.cjs'], { stdio: ['pipe', 'ignore', 'ignore'] })
    const exited = new Promise((done) => shim.once('exit', done))
    runHelper(config(['/c', `echo 1> ${join(update, 'started')}`]))
    expect(result().ok).toBe(true)
    expect(marker('resources/version.txt')).toBe('new')
    return exited
  }, 60_000)
})
