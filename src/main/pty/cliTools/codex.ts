/**
 * Codex CLI tool integration.
 *
 * Codex (https://github.com/openai/codex) is OpenAI's terminal coding agent.
 *
 * Codex stores sessions as JSONL files under ~/.codex/sessions/YYYY/MM/DD and
 * file-based auth in ~/.codex/auth.json when not using a system keyring.
 */

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { CliTool, CliSession, SettingsField, HistoryEntry, UsageInfo } from './types'
import { getToolConfig, updateToolConfig } from '../../config/appConfig'
import {
  findCodexSessionFile,
  findCodexSessionFileSync,
  parseCodexHistoryLine,
  readCodexSessionHistory,
  readCodexSessionPreview,
  scanCodexSessionIdsSync,
  scanCodexSessions,
  watchCodexSessionFile,
  watchCodexSessions
} from './codexScanner'
import { getCodexUsageInfo } from './codexUsage'
import { cliLog } from './cliLogger'
import { createJsonlSmartCompactCapability, runProcess } from './smartCompactJsonl'

const TOOL_ID = 'codex'
const TOOL_NAME = 'Codex'
const LOG_CH = 'Codex'
const CODEX_HOME = join(homedir(), '.codex')
const AUTH_JSON = join(CODEX_HOME, 'auth.json')
const CONFIG_TOML = join(CODEX_HOME, 'config.toml')

function smartCompactText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((item) => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    const block = item as Record<string, unknown>
    if (typeof block.text === 'string') return block.text
    if (typeof block.input_text === 'string') return block.input_text
    return ''
  }).join('')
}

function codexUserText(record: { value: Record<string, unknown> | null }): string {
  const obj = record.value
  const payload = obj?.payload as Record<string, unknown> | undefined
  if (obj?.type === 'event_msg' && payload?.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : ''
  }
  if (obj?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
    return smartCompactText(payload.content)
  }
  return ''
}

function isCodexUserTurnStart(records: Array<{ value: Record<string, unknown> | null }>, index: number): boolean {
  const record = records[index]
  const next = records[index + 1]
  if (!record || !next) return false
  const obj = record.value
  const payload = obj?.payload as Record<string, unknown> | undefined
  if (obj?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') return false
  const text = codexUserText(record)
  return text.length > 0 && codexUserText(next) === text
}

function codexCompletedTurnLink(
  records: Array<{ line: number; value: Record<string, unknown> | null }>,
  index: number
): string | null {
  let start = -1
  for (let i = index; i >= 0; i--) {
    if (isCodexUserTurnStart(records, i)) { start = i; break }
  }
  if (start < 0) return null

  let end = -1
  for (let i = start + 2; i < records.length; i++) {
    if (isCodexUserTurnStart(records, i)) break
    const obj = records[i].value
    const payload = obj?.payload as Record<string, unknown> | undefined
    if (obj?.type === 'event_msg' && payload?.type === 'task_complete') {
      end = i
      break
    }
  }
  if (end < 0 || index < start || index > end) return null
  return `turn:${records[start].line}`
}

const signalByTab = new Map<string, (event: string) => void>()

function normalizeProjectKey(projectPath: string): string {
  return projectPath.replace(/\//g, '\\').toLowerCase()
}

function escapeTomlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

async function ensureProjectTrusted(projectPath: string): Promise<void> {
  const key = normalizeProjectKey(projectPath)
  const header = `[projects.'${escapeTomlLiteral(key)}']`
  let content = ''

  if (existsSync(CONFIG_TOML)) {
    try {
      content = readFileSync(CONFIG_TOML, 'utf-8')
    } catch {
      content = ''
    }
  }

  const headerPattern = new RegExp(`^\\[projects\\.'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "''")}'\\]\\s*$`, 'mi')
  const match = headerPattern.exec(content)

  if (!match) {
    const prefix = content.trimEnd()
    const next = `${prefix}${prefix ? '\n\n' : ''}${header}\ntrust_level = "trusted"\n`
    mkdirSync(dirname(CONFIG_TOML), { recursive: true })
    writeFileSync(CONFIG_TOML, next, 'utf-8')
    return
  }

  const blockStart = match.index
  const nextHeader = content.slice(blockStart + match[0].length).search(/\n\[/)
  const blockEnd = nextHeader === -1
    ? content.length
    : blockStart + match[0].length + nextHeader + 1
  const block = content.slice(blockStart, blockEnd)

  if (/^\s*trust_level\s*=\s*"trusted"\s*$/mi.test(block)) return

  const updatedBlock = /^\s*trust_level\s*=/mi.test(block)
    ? block.replace(/^\s*trust_level\s*=.*$/mi, 'trust_level = "trusted"')
    : `${block.trimEnd()}\ntrust_level = "trusted"\n`

  mkdirSync(dirname(CONFIG_TOML), { recursive: true })
  writeFileSync(CONFIG_TOML, content.slice(0, blockStart) + updatedBlock + content.slice(blockEnd), 'utf-8')
}

function loadAuthJson(): Record<string, unknown> | null {
  if (!existsSync(AUTH_JSON)) return null
  try {
    return JSON.parse(readFileSync(AUTH_JSON, 'utf-8')) as Record<string, unknown>
  } catch (e) {
    cliLog(LOG_CH, `[auth] failed to read auth.json: ${e}`)
    return null
  }
}

function getNestedString(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : null
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function getAuthIdentifier(auth: Record<string, unknown>): string | null {
  const apiKey = getNestedString(auth, ['OPENAI_API_KEY'])
  if (apiKey) return 'OpenAI API key'

  const idToken = getNestedString(auth, ['tokens', 'id_token'])
  if (idToken) {
    const payload = decodeJwtPayload(idToken)
    const email = getNestedString(payload, ['email'])
    if (email) return email
  }

  return getNestedString(auth, ['tokens', 'account_id']) ?? getNestedString(auth, ['auth_mode'])
}

function hasUsableCredentials(auth: Record<string, unknown> | null): boolean {
  if (!auth) return false
  if (getNestedString(auth, ['OPENAI_API_KEY'])) return true
  return !!(
    getNestedString(auth, ['tokens', 'access_token']) ||
    getNestedString(auth, ['tokens', 'refresh_token'])
  )
}

function getCodexLoginStatus(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('codex', ['login', 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const text = stdout.trim()
      resolve(text || null)
    })
  })
}

function isCodexBusyTitle(title: string): boolean {
  const trimmed = title.trimStart()
  if (!trimmed) return false

  const first = trimmed.codePointAt(0) ?? 0
  if (first >= 0x2800 && first <= 0x28ff) return true // Braille spinner frames.

  const spinnerChars = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◴◷◶◵⣾⣽⣻⢿⡿⣟⣯⣷'
  if (spinnerChars.includes(String.fromCodePoint(first))) return true

  const leadingDotRun = /^[.·•∙●]{2,}/.exec(trimmed)
  return leadingDotRun !== null
}

export const codexTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,

  smartCompact: createJsonlSmartCompactCapability({
    locateSessionFile: findCodexSessionFileSync,
    getStorageInstructions: (sessionFile) => `Codex stores this rollout as JSONL at ${sessionFile}.
The session_meta record identifies the session and must never be selected. Conversation records are
event_msg records with payload.type=user_message and response_item records whose payload.type is
message, reasoning, function_call, or function_call_output. Match function_call.call_id to
function_call_output.call_id and always select both records. Other records are operational metadata
and must not be selected.`,
    runAutonomous: ({ workspace, prompt, onOutput }) => runProcess(
      'codex',
      ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--skip-git-repo-check', prompt],
      { cwd: workspace.directory, env: codexTool.getEnvOverrides?.(), onOutput }
    ),
    describeRecord: (record, records) => {
      const obj = record.value
      const payload = obj?.payload as Record<string, unknown> | undefined
      const index = record.line - 1
      const turnLink = codexCompletedTurnLink(records, index)
      if (turnLink) {
        const isUserRecord = obj?.type === 'event_msg' && payload?.type === 'user_message'
          || obj?.type === 'response_item' && payload?.type === 'message' && payload.role === 'user'
        const isAssistantRecord = obj?.type === 'event_msg' && payload?.type === 'agent_message'
          || obj?.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant'
        const preview = isUserRecord || isAssistantRecord ? codexUserText(record).trim().slice(0, 500) : ''
        return {
          removable: true,
          role: isUserRecord ? 'user' : isAssistantRecord ? 'assistant' : 'operation',
          preview,
          links: [turnLink]
        }
      }

      return { removable: false, role: 'metadata', preview: '', links: [] }
    }
  }),
  installUrl: 'https://github.com/openai/codex',

  // ── Install check ───────────────────────────────────────────────────────────

  async isInstalled(): Promise<boolean> {
    const inPath = await new Promise<boolean>((resolve) => {
      execFile('where', ['codex'], { timeout: 3000 }, (err) => resolve(!err))
    })
    if (inPath) return true
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-Command codex -ErrorAction SilentlyContinue'],
        { timeout: 5000 },
        (err, stdout) => resolve(!err && stdout.trim().length > 0)
      )
    })
  },

  // ── Commands ──────────────────────────────────────────────────────────────

  newSessionCommand(): string {
    return 'codex'
  },

  resumeCommand(sessionId: string): string {
    return `codex resume ${sessionId}`
  },

  exitCommand(): string {
    return '/exit'
  },

  interactiveSubmitSequence(): string {
    return '\r'
  },

  // ── Startup health ────────────────────────────────────────────────────────

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (
      accumulated.includes('command not found') ||
      accumulated.includes('is not recognized') ||
      accumulated.includes('Cannot find module')
    ) return 'dead'

    // Codex renders its TUI with ANSI escape sequences immediately on start.
    if (
      accumulated.includes('\x1b[') ||
      accumulated.includes('codex') ||
      accumulated.includes('Codex')
    ) return 'ok'

    if (elapsedMs > 15000) return 'ok'
    return 'pending'
  },

  // ── Project setup ─────────────────────────────────────────────────────────

  async prepareProject(projectPath: string): Promise<void> {
    await ensureProjectTrusted(projectPath)
  },

  // ── Sessions ──────────────────────────────────────────────────────────────

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const sessions = await scanCodexSessions(projectPath)
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      slug: session.title || TOOL_NAME,
      firstMessage: session.firstMessage || undefined,
      lastModified: new Date(session.mtime)
    }))
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    // Establish the baseline synchronously before Codex is started. Otherwise a
    // newly-created rollout can be absorbed by the asynchronous baseline scan
    // and never reported to PtyManager.
    const knownIds = scanCodexSessionIdsSync(projectPath)

    return watchCodexSessions(projectPath, knownIds, (session) => {
      onNew({
        sessionId: session.sessionId,
        slug: session.title || TOOL_NAME,
        firstMessage: session.firstMessage || undefined,
        lastModified: new Date(session.mtime)
      })
    })
  },

  async getSessionPreview(projectPath: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    const filePath = await findCodexSessionFile(projectPath, sessionId)
    return filePath ? readCodexSessionPreview(filePath) : []
  },

  async getSessionHistory(projectPath: string, sessionId: string): Promise<HistoryEntry[]> {
    const filePath = await findCodexSessionFile(projectPath, sessionId)
    return filePath ? readCodexSessionHistory(filePath) : []
  },

  subscribeToSessionHistory(
    projectPath: string,
    sessionId: string,
    onEntry: (entry: HistoryEntry) => void
  ): () => void {
    const filePath = findCodexSessionFileSync(projectPath, sessionId)
    return filePath ? watchCodexSessionFile(filePath, onEntry) : () => {}
  },

  getSessionFilePath(projectPath: string, sessionId: string): string | null {
    return findCodexSessionFileSync(projectPath, sessionId)
  },

  parseThinkingBlocks(line: string): string[] {
    const entry = parseCodexHistoryLine(line)
    if (!entry) return []
    return entry.blocks
      .filter((block): block is { type: 'thinking'; thinking: string } => block.type === 'thinking')
      .map((block) => block.thinking)
  },

  detectTitleEvent(tabId: string, prevTitle: string | null, newTitle: string): void {
    if (prevTitle === null) return
    if (isCodexBusyTitle(prevTitle) && !isCodexBusyTitle(newTitle)) {
      signalByTab.get(tabId)?.('completeAndWait')
    }
  },

  registerSignalHandler(tabId: string, handler: (event: string) => void): void {
    signalByTab.set(tabId, handler)
  },

  deregisterTab(tabId: string): void {
    signalByTab.delete(tabId)
  },

  async resolveOwnerPid(candidatePids: number[]): Promise<number | null> {
    if (candidatePids.length === 0) return null
    try {
      const json = await new Promise<string>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
          ],
          { timeout: 5000 },
          (err, stdout) => {
            if (err) reject(err)
            else resolve(stdout.trim())
          }
        )
      })
      if (!json) return null

      const parsed = JSON.parse(json)
      const allProcs: Array<{ ProcessId: number; ParentProcessId: number; Name: string }> = Array.isArray(parsed)
        ? parsed
        : [parsed]

      const parentMap = new Map<number, number>()
      for (const proc of allProcs) {
        parentMap.set(proc.ProcessId, proc.ParentProcessId)
      }

      const candidateSet = new Set(candidatePids)
      const findAncestorInSet = (startPid: number): number | null => {
        let pid = startPid
        const visited = new Set<number>()
        while (pid && !visited.has(pid)) {
          if (candidateSet.has(pid)) return pid
          visited.add(pid)
          pid = parentMap.get(pid) ?? 0
        }
        return null
      }

      const matches: Array<{ pid: number; ancestor: number }> = []
      for (const proc of allProcs) {
        if (!(proc.Name ?? '').toLowerCase().startsWith('codex')) continue
        const ancestor = findAncestorInSet(proc.ParentProcessId)
        if (ancestor !== null) matches.push({ pid: proc.ProcessId, ancestor })
      }

      if (matches.length === 0) return null
      matches.sort((a, b) => b.pid - a.pid)
      return matches[0].ancestor
    } catch (e) {
      cliLog(LOG_CH, `[resolveOwnerPid] failed: ${e}`)
      return null
    }
  },

  // ── Context insert ──────────────────────────────────────────────────────────

  contextInsert(relPath: string): string {
    // Codex uses "@" prefix for file references.
    return `@${relPath}`
  },

  // ── Settings (proxy) ──────────────────────────────────────────────────────

  settingsFields(): SettingsField[] {
    return [
      {
        key: 'proxy',
        label: 'Proxy address',
        description: 'Leave empty to use no proxy (e.g. http://127.0.0.1:1080)',
        type: 'string',
        default: ''
      }
    ]
  },

  async getSettings(): Promise<Record<string, unknown>> {
    return getToolConfig(TOOL_ID)
  },

  async updateSettings(values: Record<string, unknown>): Promise<void> {
    updateToolConfig(TOOL_ID, values)
  },

  getEnvOverrides(): Record<string, string> {
    const proxy = (getToolConfig(TOOL_ID).proxy as string) ?? ''
    if (!proxy) return {}
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      // reqwest's system proxy resolution routes loopback traffic through the
      // proxy unless NO_PROXY explicitly excludes it, breaking local MCP servers.
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1'
    }
  },

  // ── Accounts ──────────────────────────────────────────────────────────────

  hasAccountSystem(): boolean {
    return true
  },

  async isLoggedIn(): Promise<boolean> {
    if (hasUsableCredentials(loadAuthJson())) return true
    const status = await getCodexLoginStatus()
    return !!status && /^logged in\b/i.test(status)
  },

  async getLoginIdentifier(): Promise<string | null> {
    const auth = loadAuthJson()
    const identifier = auth ? getAuthIdentifier(auth) : null
    if (identifier) return identifier

    const status = await getCodexLoginStatus()
    const match = /^logged in using\s+(.+)$/i.exec(status ?? '')
    return match ? match[1].trim() : null
  },

  async exportCredentials(): Promise<Record<string, unknown> | null> {
    const auth = loadAuthJson()
    if (!hasUsableCredentials(auth)) return null
    return { authJson: auth }
  },

  async importCredentials(credentials: Record<string, unknown>): Promise<void> {
    const auth = credentials.authJson
    if (!auth || typeof auth !== 'object') return
    mkdirSync(CODEX_HOME, { recursive: true })
    writeFileSync(AUTH_JSON, JSON.stringify(auth, null, 2), 'utf-8')
  },

  async clearCredentials(): Promise<void> {
    if (!existsSync(AUTH_JSON)) return
    try {
      unlinkSync(AUTH_JSON)
    } catch (e) {
      cliLog(LOG_CH, `[auth] failed to clear auth.json: ${e}`)
    }
  },

  async getUsageInfo(): Promise<UsageInfo | null> {
    return getCodexUsageInfo()
  }
}
