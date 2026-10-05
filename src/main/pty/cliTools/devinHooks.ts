import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { cliLog } from './cliLogger'

/**
 * Devin hook wiring for a single PTY tab.
 *
 * Devin supports Claude-format lifecycle hooks. User-level hooks live in the
 * `"hooks"` key of the user config file, and `devin --config <path>` overrides
 * that file's location — so per tab we write a merged copy of the user's
 * config (their settings plus our hook entries appended) and pass it via
 * --config. Nothing inside the project directory is touched.
 *
 * The hook command POSTs the event's stdin payload (contains `session_id`) to
 * AIDE's hook server with the per-tab id + token baked into the URL, giving a
 * deterministic tabId -> sessionId binding even when several Devin tabs start
 * concurrently — the one thing the lock-file/scan approach cannot decide.
 */

const LOG_CH = 'Devin'

// SessionStart binds on launch (and re-binds if devin re-fires it); Stop is a
// cheap belt-and-suspenders refresh at each turn boundary.
const BINDING_EVENTS = ['SessionStart', 'Stop'] as const

function hooksDir(): string {
  return join(app.getPath('userData'), 'aide-hooks')
}

function configPath(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(hooksDir(), `devin-${safe}.json`)
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

/** The user's own Devin config (%APPDATA%\devin\config.json on Windows). */
function userConfigPath(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '.', '.config'))
  return join(base, 'devin', 'config.json')
}

/** JSONC: Devin config files allow comments. Strip them before JSON.parse. */
function stripJsonComments(src: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < src.length) {
    const c = src[i]
    if (inString) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') { inString = true; out += c; i++; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Write the per-tab merged config file and return its absolute path, or null
 * when the user's own config exists but cannot be parsed (safer to skip hook
 * wiring than to silently drop their user-level settings via --config).
 */
export function writeTabHookConfig(tabId: string, port: number, token: string): string | null {
  const curl = resolveCurl()
  const ourHooks: Record<string, unknown> = {}
  for (const event of BINDING_EVENTS) {
    const url = `http://127.0.0.1:${port}/hook?tab=${encodeURIComponent(tabId)}&event=${event}&token=${token}`
    ourHooks[event] = [{ hooks: [{ type: 'command', command: `"${curl}" -s -m 2 -X POST "${url}" --data-binary @-` }] }]
  }

  let root: Record<string, unknown> = {}
  const userCfg = userConfigPath()
  if (existsSync(userCfg)) {
    try {
      root = JSON.parse(stripJsonComments(readFileSync(userCfg, 'utf-8'))) as Record<string, unknown>
    } catch (err) {
      cliLog(LOG_CH, `[hooks] user config.json unparseable, skipping hook wiring: ${err}`)
      return null
    }
  }

  const existing = (root.hooks ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...existing }
  for (const event of BINDING_EVENTS) {
    const prev = Array.isArray(existing[event]) ? (existing[event] as unknown[]) : []
    merged[event] = [...prev, ...(ourHooks[event] as unknown[])]
  }
  root.hooks = merged

  const dir = hooksDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = configPath(tabId)
  writeFileSync(path, JSON.stringify(root, null, 2), 'utf-8')
  return path
}

/** Delete a tab's config file when the tab closes. */
export function cleanupTabHookConfig(tabId: string): void {
  try {
    rmSync(configPath(tabId), { force: true })
  } catch {
    // best-effort
  }
}
