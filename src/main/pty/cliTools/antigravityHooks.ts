import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getAntigravityDataDir } from './antigravityScanner'
import { removeLaunchPath, tabLaunchPath, writeLaunchFile } from './launchFiles'

/**
 * Per-tab `--settings <file>` wiring for interactive Antigravity CLI tabs.
 *
 * `--settings` applies session-only overrides without ever mutating the user's
 * `~/.gemini/antigravity-cli/settings.json`. We use it for three things:
 *   1. Pre-trust `projectPath` (`trustedWorkspaces`) so the CLI does not block
 *      on a workspace trust prompt.
 *   2. Auto-allow AIDE's MCP servers (`permissions.allow: ["mcp(aide/*)"]`),
 *      merging with the user's own permission rules from `settings.json`.
 *   3. Wire Antigravity's `title.command` hook to POST the JSON session state
 *      (`session_id`, `transcript_path`, `agent_state`, `conversation_title`,
 *      `email`, `quota`) to AIDE's HookServer and echo back the formatted
 *      window title — only when the user has not configured their own `title`.
 */

function settingsFilePath(tabId: string): string {
  return tabLaunchPath('antigravity-settings', tabId, '.json')
}

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

function readUserSettings(): Record<string, unknown> | null {
  const path = join(getAntigravityDataDir(), 'settings.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function hasUserTitleCommand(userSettings: Record<string, unknown>): boolean {
  const title = userSettings.title
  if (!title || typeof title !== 'object' || Array.isArray(title)) return false
  const t = title as { command?: unknown; enabled?: unknown }
  return typeof t.command === 'string' && t.command.trim().length > 0 && t.enabled !== false
}

export interface AntigravityTabSettingsInput {
  tabId: string
  projectPath: string
  hook: { port: number; token: string } | null
  mcpServerNames: string[]
  userSettings: Record<string, unknown> | null
  curlPath?: string
  platform?: NodeJS.Platform
}

/**
 * Format the shell command for Antigravity's `title.command` hook.
 *
 * On Windows, Antigravity invokes `title.command` via `cmd /c <command>` where
 * double quotes are escaped or stripped by cmd.exe — so any `"` in the command
 * breaks execution. Keep the Windows command completely quote-free and escape
 * `&` query separators with `^&`.
 */
export function buildTitleHookCommand(curl: string, url: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const exe = /\s/.test(curl) ? 'curl.exe' : curl
    const escapedUrl = url.replace(/&/g, '^&')
    return `${exe} -s -m 2 -X POST ${escapedUrl} --data-binary @-`
  }
  return `"${curl}" -s -m 2 -X POST "${url}" --data-binary @-`
}

/** Build the session-only `--settings` JSON object for one Antigravity tab, or null if nothing needs overriding. */
export function buildAntigravityTabSettings(input: AntigravityTabSettingsInput): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  const user = input.userSettings

  // Only override array/object keys when user settings were readable so we never
  // accidentally drop user-configured rules from an unparseable settings.json.
  if (user !== null) {
    const trusted = stringArray(user.trustedWorkspaces)
    const norm = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p)
    if (!trusted.some((p) => norm(p) === norm(input.projectPath))) {
      patch.trustedWorkspaces = [...trusted, input.projectPath]
    }

    if (input.mcpServerNames.length > 0) {
      const existingPerms = (user.permissions && typeof user.permissions === 'object' && !Array.isArray(user.permissions))
        ? (user.permissions as Record<string, unknown>)
        : {}
      const allow = stringArray(existingPerms.allow)
      const needed = input.mcpServerNames.map((name) => `mcp(${name}/*)`)
      const mergedAllow = [...allow]
      for (const rule of needed) {
        if (!mergedAllow.includes(rule)) mergedAllow.push(rule)
      }
      patch.permissions = {
        ...existingPerms,
        allow: mergedAllow
      }
    }
  }

  if (input.hook && (user === null || !hasUserTitleCommand(user))) {
    const curl = input.curlPath ?? resolveCurl()
    const url = `http://127.0.0.1:${input.hook.port}/hook?tab=${encodeURIComponent(input.tabId)}&event=Title&token=${input.hook.token}`
    patch.title = {
      type: 'command',
      enabled: true,
      command: buildTitleHookCommand(curl, url, input.platform)
    }
  }

  return Object.keys(patch).length > 0 ? patch : null
}

const writtenSettingsByTab = new Map<string, string>()

/** Write the per-tab `--settings` file and return its path, or null if no override is needed. */
export function writeAntigravityTabSettings(
  tabId: string,
  projectPath: string,
  hook: { port: number; token: string } | null,
  mcpServerNames: string[]
): string | null {
  const settings = buildAntigravityTabSettings({
    tabId,
    projectPath,
    hook,
    mcpServerNames,
    userSettings: readUserSettings()
  })
  if (!settings) return null
  const written = writeLaunchFile(settingsFilePath(tabId), JSON.stringify(settings, null, 2))
  writtenSettingsByTab.set(tabId, written)
  return written
}

/** Delete a tab's session settings file when the tab closes. */
export function cleanupAntigravityTabSettings(tabId: string): void {
  const path = writtenSettingsByTab.get(tabId)
  if (!path) return
  writtenSettingsByTab.delete(tabId)
  removeLaunchPath(path)
}
