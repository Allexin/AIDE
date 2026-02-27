import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CliTool, CliSession } from './types'
import { scanSessions as scanDiskSessions, watchSessionsDir, getSessionsDir } from '../sessionScanner'

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
