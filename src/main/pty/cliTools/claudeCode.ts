import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { net, session } from 'electron'
import type { CliTool, CliSession, UsageInfo } from './types'
import { scanSessions as scanDiskSessions, watchSessionsDir, getSessionsDir } from '../sessionScanner'
import { getAppConfig } from '../../config/appConfig'
import { cliLog } from './cliLogger'

const LOG_CH = 'Claude Code Errors'

const CLAUDE_JSON = join(homedir(), '.claude.json')

/** Normalise a project path to the key format Claude uses in ~/.claude.json.
 *  Windows: backslashes → forward slashes. E.g. E:\Projects\X → E:/Projects/X
 */
function normaliseProjectKey(projectPath: string): string {
  return projectPath.replace(/\\/g, '/')
}

/** Ensure ~/.claude.json marks the project as trusted so Claude Code
 *  doesn't show the "Do you trust files in this folder?" prompt.
 */
async function ensureProjectTrusted(projectPath: string): Promise<void> {
  const key = normaliseProjectKey(projectPath)

  let root: Record<string, unknown> = {}
  if (existsSync(CLAUDE_JSON)) {
    try {
      root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
    } catch {
      // corrupt file — leave root as empty object, will be merged below
    }
  }

  const projects = (root.projects ?? {}) as Record<string, Record<string, unknown>>
  const entry = projects[key] ?? {}

  if (entry.hasTrustDialogAccepted === true) return // already trusted, nothing to do

  projects[key] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    ...entry,
    hasTrustDialogAccepted: true,
  }

  root.projects = projects
  writeFileSync(CLAUDE_JSON, JSON.stringify(root, null, 2), 'utf-8')
}

/** Keys from ~/.claude.json that constitute auth credentials. */
const CREDENTIAL_KEYS = ['oauthAccount', 'userID'] as const

/** Path to the separate credentials file (access/refresh tokens). */
const CREDENTIALS_JSON = join(homedir(), '.claude', '.credentials.json')

export const claudeCodeTool: CliTool = {
  id: 'claude-code',
  name: 'Claude Code',

  async prepareProject(projectPath: string): Promise<void> {
    await ensureProjectTrusted(projectPath)
  },

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const sessions = await scanDiskSessions(projectPath)
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      slug: s.title,
      lastModified: new Date(s.mtime)
    }))
  },

  resumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`
  },

  newSessionCommand(): string {
    return 'claude'
  },

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (accumulated.includes('No conversation found with session ID')) return 'dead'
    if (accumulated.includes('? for shortcuts')) return 'ok'
    if (elapsedMs > 15000) return 'ok' // assume ok after 15s
    return 'pending'
  },

  async isLoggedIn(): Promise<boolean> {
    if (!existsSync(CLAUDE_JSON)) return false
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      return !!(root.oauthAccount && root.oauthAccount.emailAddress)
    } catch {
      return false
    }
  },

  async getLoginIdentifier(): Promise<string | null> {
    if (!existsSync(CLAUDE_JSON)) return null
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      return root.oauthAccount?.emailAddress ?? null
    } catch {
      return null
    }
  },

  async credentialsMatch(saved: Record<string, unknown>): Promise<boolean> {
    if (!existsSync(CLAUDE_JSON)) return false
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      const currentOauth = root.oauthAccount
      const savedOauth = saved.oauthAccount as Record<string, unknown> | undefined
      if (!currentOauth || !savedOauth) return false
      return currentOauth.accountUuid === savedOauth.accountUuid
        && currentOauth.emailAddress === savedOauth.emailAddress
    } catch {
      return false
    }
  },

  async exportCredentials(): Promise<Record<string, unknown> | null> {
    if (!existsSync(CLAUDE_JSON)) return null
    try {
      const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      if (!root.oauthAccount) return null
      const creds: Record<string, unknown> = {}
      for (const key of CREDENTIAL_KEYS) {
        if (root[key] !== undefined) creds[key] = root[key]
      }
      // Also export access/refresh tokens from ~/.claude/.credentials.json
      if (existsSync(CREDENTIALS_JSON)) {
        try {
          creds._credentialsJson = JSON.parse(readFileSync(CREDENTIALS_JSON, 'utf-8'))
        } catch { /* ignore */ }
      }
      return creds
    } catch {
      return null
    }
  },

  async importCredentials(credentials: Record<string, unknown>): Promise<void> {
    let root: Record<string, unknown> = {}
    if (existsSync(CLAUDE_JSON)) {
      try {
        root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
      } catch {
        // start fresh
      }
    }
    for (const key of CREDENTIAL_KEYS) {
      if (credentials[key] !== undefined) {
        root[key] = credentials[key]
      }
    }
    writeFileSync(CLAUDE_JSON, JSON.stringify(root, null, 2), 'utf-8')

    // Restore access/refresh tokens to ~/.claude/.credentials.json
    if (credentials._credentialsJson) {
      const dir = join(homedir(), '.claude')
      mkdirSync(dir, { recursive: true })
      writeFileSync(CREDENTIALS_JSON, JSON.stringify(credentials._credentialsJson, null, 2), 'utf-8')
    }
  },

  async clearCredentials(): Promise<void> {
    // Remove auth keys from ~/.claude.json (keep other settings intact)
    if (existsSync(CLAUDE_JSON)) {
      try {
        const root = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'))
        for (const key of CREDENTIAL_KEYS) delete root[key]
        writeFileSync(CLAUDE_JSON, JSON.stringify(root, null, 2), 'utf-8')
      } catch { /* ignore */ }
    }
    // Remove the tokens file entirely
    if (existsSync(CREDENTIALS_JSON)) {
      try { unlinkSync(CREDENTIALS_JSON) } catch { /* ignore */ }
    }
  },

  async getUsageInfo(): Promise<UsageInfo | null> {
    // Access token lives in ~/.claude/.credentials.json
    const credsPath = join(homedir(), '.claude', '.credentials.json')
    let accessToken: string | undefined
    try {
      if (existsSync(credsPath)) {
        const creds = JSON.parse(readFileSync(credsPath, 'utf-8'))
        accessToken = creds?.claudeAiOauth?.accessToken
      } else {
        cliLog(LOG_CH, `[usage] credentials file not found: ${credsPath}`)
      }
    } catch (e) {
      cliLog(LOG_CH, `[usage] failed to read credentials: ${e}`)
    }
    if (!accessToken) {
      cliLog(LOG_CH, '[usage] no access token found in credentials')
      return null
    }

    try {
      // Apply proxy settings if configured
      const proxyConfig = getAppConfig().proxy
      if (proxyConfig.enabled && proxyConfig.address) {
        await session.defaultSession.setProxy({ proxyRules: proxyConfig.address })
      } else {
        await session.defaultSession.setProxy({ proxyRules: '' })
      }

      const res = await net.fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json'
        }
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        cliLog(LOG_CH, `[usage] API returned ${res.status} ${res.statusText}: ${body}`)
        return null
      }
      const data = (await res.json()) as Record<string, unknown>

      // Build summary from whatever fields are present
      const parts: string[] = []
      const tipParts: string[] = []
      let maxUtil = 0

      for (const [key, val] of Object.entries(data)) {
        if (val && typeof val === 'object' && 'utilization' in (val as Record<string, unknown>)) {
          const bucket = val as { utilization: number | null; resets_at?: string }
          if (bucket.utilization == null) continue
          const util = bucket.utilization
          if (util > maxUtil) maxUtil = util
          const label = key.replace(/_/g, ' ')
          parts.push(`${Math.round(util)}%`)
          const resetStr = bucket.resets_at
            ? ` resets ${new Date(bucket.resets_at).toLocaleString()}`
            : ''
          tipParts.push(`${label}: ${Math.round(util)}%${resetStr}`)
        }
      }

      if (parts.length === 0) {
        cliLog(LOG_CH, `[usage] no utilization buckets found in response: ${JSON.stringify(data)}`)
        return null
      }

      const level = maxUtil >= 90 ? 'critical' : maxUtil >= 70 ? 'warn' : 'normal'
      return {
        summary: parts.join(' / '),
        tooltip: tipParts.join('\n'),
        level
      }
    } catch (e) {
      cliLog(LOG_CH, `[usage] fetch error: ${e}`)
      return null
    }
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    const sessionsDir = getSessionsDir(projectPath)
    return watchSessionsDir(sessionsDir, (sessionId: string) => {
      onNew({
        sessionId,
        slug: 'Claude Code',
        lastModified: new Date()
      })
    })
  }
}
