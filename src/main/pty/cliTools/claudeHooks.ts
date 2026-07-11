import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'

/**
 * Claude Code hook wiring for a single PTY tab.
 *
 * We inject hooks via `claude --settings <file>` (verified: this MERGES with the
 * user's project `.claude/settings.json`, it does not replace it — so the repo is
 * never touched and the user's own hooks keep working). Each tab gets its own
 * settings file with the tabId, hook-server port and token baked directly into a
 * literal `curl` command, so there is zero dependency on shell env-var expansion,
 * PATH, node, or PowerShell. `curl` ships in Windows System32 and is the natural
 * transport on Linux too.
 *
 * Minimal event set: SessionStart (initial bind + re-bind on clear/branch/compact,
 * every source carries the current transcript_path) and Stop (belt-and-suspenders
 * refresh at each turn boundary). Both are the oldest, most stable hook events.
 */

// Events whose payload we forward to AIDE for binding.
const BINDING_EVENTS = ['SessionStart', 'Stop'] as const

function hooksDir(): string {
  return join(app.getPath('userData'), 'aide-hooks')
}

function settingsPath(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(hooksDir(), `${safe}.json`)
}

/** Resolve a curl executable. Prefer the OS-bundled one; fall back to PATH. */
function resolveCurl(): string {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const sys32 = join(sysRoot, 'System32', 'curl.exe')
    if (existsSync(sys32)) return sys32
    return 'curl'
  }
  for (const p of ['/usr/bin/curl', '/bin/curl']) {
    if (existsSync(p)) return p
  }
  return 'curl'
}

function buildSettings(tabId: string, port: number, token: string): string {
  const curl = resolveCurl()
  const hooks: Record<string, unknown> = {}
  for (const event of BINDING_EVENTS) {
    const url = `http://127.0.0.1:${port}/hook?tab=${encodeURIComponent(tabId)}&event=${event}&token=${token}`
    const command = `"${curl}" -s -m 2 -X POST "${url}" --data-binary @-`
    hooks[event] = [{ hooks: [{ type: 'command', command }] }]
  }
  // JSON.stringify escapes the inner double-quotes of the command strings.
  return JSON.stringify({ hooks }, null, 2)
}

/**
 * Write the per-tab settings file and return its absolute path.
 * The caller appends `--settings "<path>"` to the launch command.
 */
export function writeTabHookSettings(tabId: string, port: number, token: string): string {
  const dir = hooksDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = settingsPath(tabId)
  writeFileSync(path, buildSettings(tabId, port, token), 'utf-8')
  return path
}

/** Delete a tab's settings file when the tab closes. */
export function cleanupTabHookSettings(tabId: string): void {
  try {
    rmSync(settingsPath(tabId), { force: true })
  } catch {
    // best-effort
  }
}
