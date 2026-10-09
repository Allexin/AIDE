import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * Discovery files and launchers that let agents reach a running AIDE without
 * ever storing a port or a secret in their own configuration.
 *
 * <runtimeDir>/projects/<hash>.json   one per open project: { projectPath, port, token, pid }
 * <runtimeDir>/bin/aide-pipeline(.cmd) shell launcher for `events` / `wait`
 */

export interface ShimLaunch {
  /** Executable that runs the shim (the AIDE / Electron binary in Node mode). */
  command: string
  args: string[]
  env: Record<string, string>
}

function projectFileName(projectPath: string): string {
  const key = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath
  return createHash('sha256').update(key).digest('hex').slice(0, 16) + '.json'
}

export function writeProjectRuntime(runtimeDir: string, projectPath: string, port: number, token: string): void {
  const dir = join(runtimeDir, 'projects')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, projectFileName(projectPath)), JSON.stringify({ projectPath, port, token, pid: process.pid }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

export function removeProjectRuntime(runtimeDir: string, projectPath: string): void {
  rmSync(join(runtimeDir, 'projects', projectFileName(projectPath)), { force: true })
}

/** Remove discovery files left by this process (called on quit). */
export function removeAllProjectRuntimes(runtimeDir: string, projectPaths: Iterable<string>): void {
  for (const projectPath of projectPaths) removeProjectRuntime(runtimeDir, projectPath)
}

/** Remove discovery files whose owning process is gone (left by a crash). */
export function pruneStaleRuntimes(runtimeDir: string, isAlive: (pid: number) => boolean): void {
  const dir = join(runtimeDir, 'projects')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const match = /"pid":\s*(\d+)/.exec(safeRead(join(dir, name)))
    if (match && !isAlive(Number(match[1]))) rmSync(join(dir, name), { force: true })
  }
}

function safeRead(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** How an agent CLI should launch the shim as a stdio MCP server. */
export function shimLaunch(executable: string, shimPath: string, runtimeDir: string, mode: 'mcp' | 'events' | 'wait' = 'mcp'): ShimLaunch {
  return {
    command: executable,
    args: [shimPath, mode],
    env: { ELECTRON_RUN_AS_NODE: '1', AIDE_RUNTIME_DIR: runtimeDir }
  }
}

/**
 * Write the shell launcher (`aide-pipeline events --run <id>`). Rewritten on every
 * start because the AIDE executable path can change after an update.
 * Returns the launcher path.
 */
export function writeLauncher(runtimeDir: string, executable: string, shimPath: string): string {
  const dir = join(runtimeDir, 'bin')
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const path = join(dir, 'aide-pipeline.cmd')
    writeFileSync(path, [
      '@echo off',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      `set "AIDE_RUNTIME_DIR=${runtimeDir}"`,
      `"${executable}" "${shimPath}" %*`,
      ''
    ].join('\r\n'), 'utf8')
    return path
  }
  const path = join(dir, 'aide-pipeline')
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  writeFileSync(path, [
    '#!/bin/sh',
    `ELECTRON_RUN_AS_NODE=1 AIDE_RUNTIME_DIR=${quote(runtimeDir)} exec ${quote(executable)} ${quote(shimPath)} "$@"`,
    ''
  ].join('\n'), 'utf8')
  chmodSync(path, 0o755)
  return path
}
