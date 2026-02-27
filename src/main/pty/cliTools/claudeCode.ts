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
