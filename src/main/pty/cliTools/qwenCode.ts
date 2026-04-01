import { existsSync, readdirSync, readFileSync, statSync, watch as fsWatch } from 'fs'
import { execFile } from 'child_process'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { CliTool, CliSession } from './types'
import { cliLog } from './cliLogger'

const LOG_CH = 'Qwen Code'
const TOOL_NAME = 'Qwen Code'
const TOOL_ID = 'qwen-code'

/**
 * Compute the project directory slug the same way Qwen Code does:
 * sanitizeCwd(targetDir) → lowercase on Windows, then replace non-alphanumeric with '-'
 */
function getChatsDir(projectPath: string): string {
  const normalized = platform() === 'win32' ? projectPath.toLowerCase() : projectPath
  const slug = normalized.replace(/[^a-zA-Z0-9]/g, '-')
  return join(homedir(), '.qwen', 'projects', slug, 'chats')
}

interface QwenRecord {
  sessionId: string
  timestamp: string
  type: 'user' | 'assistant' | 'system'
  message?: {
    role: string
    parts: Array<{ text?: string }>
  }
}

/** Extract plain text from a JSONL record's message parts. */
function extractText(record: QwenRecord): string {
  return (record.message?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()
}

/** Read one JSONL file and return parsed records (skips malformed lines). */
function readJsonl(filePath: string): QwenRecord[] {
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as QwenRecord
        } catch {
          return null
        }
      })
      .filter((r): r is QwenRecord => r !== null)
  } catch {
    return []
  }
}

export const qwenCodeTool: CliTool = {
  id: TOOL_ID,
  name: TOOL_NAME,

  installUrl: 'https://www.npmjs.com/package/@qwen-code/qwen-code',

  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('where', ['qwen'], { timeout: 3000 }, (err) => resolve(!err))
    })
  },

  newSessionCommand(): string {
    return 'qwen'
  },

  resumeCommand(sessionId: string): string {
    return `qwen --resume ${sessionId}`
  },

  checkStartupHealth(accumulated: string, elapsedMs: number): 'ok' | 'dead' | 'pending' {
    if (
      accumulated.includes('command not found') ||
      accumulated.includes('is not recognized') ||
      accumulated.includes('Cannot find module')
    ) {
      return 'dead'
    }
    // Qwen Code prints its name in the startup banner
    if (accumulated.includes('Qwen Code') || accumulated.includes('qwen-code')) {
      return 'ok'
    }
    if (elapsedMs > 15000) return 'ok'
    return 'pending'
  },

  detectTitleEvent(prevTitle: string | null, newTitle: string): string | null {
    if (prevTitle === null) return null
    // Qwen Code sets title with ✳ (U+2733) when waiting for input, same as Claude Code
    const isWaiting = (t: string): boolean => t.codePointAt(0) === 0x2733
    if (!isWaiting(prevTitle) && isWaiting(newTitle)) {
      return 'completeAndWait'
    }
    return null
  },

  contextInsert(relPath: string): string {
    return `@${relPath}`
  },

  async scanSessions(projectPath: string): Promise<CliSession[]> {
    const chatsDir = getChatsDir(projectPath)
    if (!existsSync(chatsDir)) return []

    const sessions: CliSession[] = []

    for (const file of readdirSync(chatsDir)) {
      if (!file.endsWith('.jsonl')) continue
      const sessionId = file.slice(0, -'.jsonl'.length)
      const filePath = join(chatsDir, file)

      let lastModified: Date
      try {
        lastModified = statSync(filePath).mtime
      } catch {
        continue
      }

      // Use first user message text as session slug
      let slug = TOOL_NAME
      try {
        const records = readJsonl(filePath)
        const firstUser = records.find((r) => r.type === 'user')
        if (firstUser) {
          const text = extractText(firstUser)
          if (text) slug = text.slice(0, 80)
        }
      } catch (e) {
        cliLog(LOG_CH, `[scanSessions] failed to read ${filePath}: ${e}`)
      }

      sessions.push({ sessionId, slug, lastModified })
    }

    return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
  },

  watchForNewSessions(projectPath: string, onNew: (session: CliSession) => void): () => void {
    const chatsDir = getChatsDir(projectPath)

    if (!existsSync(chatsDir)) {
      // Directory doesn't exist yet — nothing to watch
      return () => {}
    }

    const known = new Set(readdirSync(chatsDir).filter((f) => f.endsWith('.jsonl')))

    const watcher = fsWatch(chatsDir, { persistent: false }, (event, filename) => {
      if (event !== 'rename' || !filename?.endsWith('.jsonl')) return
      if (known.has(filename)) return

      const filePath = join(chatsDir, filename)
      if (!existsSync(filePath)) return // deletion, not creation

      known.add(filename)
      const sessionId = filename.slice(0, -'.jsonl'.length)
      onNew({ sessionId, slug: TOOL_NAME, lastModified: new Date() })
    })

    return () => watcher.close()
  },

  async getSessionPreview(
    projectPath: string,
    sessionId: string
  ): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    const filePath = join(getChatsDir(projectPath), `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []

    const records = readJsonl(filePath).filter((r) => r.type === 'user' || r.type === 'assistant')
    return records.slice(-3).map((r) => ({
      role: r.type as 'user' | 'assistant',
      text: extractText(r).slice(0, 200)
    }))
  },

  getSessionFilePath(projectPath: string, sessionId: string): string | null {
    return join(getChatsDir(projectPath), `${sessionId}.jsonl`)
  }
}
