import { app } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Per-tab files a CLI launch reads (hook settings, MCP configs, plugin
 * directories), under AIDE's user data. Written before each spawn, removed when
 * the tab closes.
 */

export function launchFilesDir(): string {
  return join(app.getPath('userData'), 'aide-hooks')
}

/** `<launch files>/<prefix>-<tab><suffix>` — a file, or a directory when `suffix` is empty. */
export function tabLaunchPath(prefix: string, tabId: string, suffix: string): string {
  return join(launchFilesDir(), `${prefix}-${tabId.replace(/[^a-zA-Z0-9_-]/g, '_')}${suffix}`)
}

export function writeLaunchFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  return path
}

export function removeLaunchPath(path: string): void {
  try { rmSync(path, { recursive: true, force: true }) } catch { /* best-effort */ }
}

/**
 * One literal argument for the PTY's shell: PowerShell on Windows, sh elsewhere.
 * The value must not contain a double quote: Windows PowerShell 5.1 mangles
 * embedded double quotes when it passes arguments on to a program.
 */
export function shellLiteral(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.includes('"')) throw new Error(`the value ${value} cannot be passed through the shell (it contains a double quote)`)
  return platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`
}
