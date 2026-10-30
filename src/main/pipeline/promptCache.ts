import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { getSessionsDir } from '../pty/cliTools/claudeCodeScanner'
import { ptyRegistry } from '../pty/registry'

/**
 * Which prompt-cache lifetime a waiting agent's session writes with. A wait that
 * times out keeps a 1-hour cache warm; with a 5-minute cache (Claude Code in usage
 * overage) nothing stays warm and each wake-up rewrites the context, so the agent
 * should stop waiting. Only Claude Code's transcripts tell.
 */

const TAIL_BYTES = 256 * 1024

/** The lifetime in the last transcript entry that wrote to the cache; null when none says. */
export function lastCacheTtl(transcriptTail: string): '5m' | '1h' | null {
  const lines = transcriptTail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cache_creation"')) continue
    try {
      const usage = (JSON.parse(lines[i]) as { message?: { usage?: { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } } } }).message?.usage?.cache_creation
      const short = usage?.ephemeral_5m_input_tokens ?? 0
      const long = usage?.ephemeral_1h_input_tokens ?? 0
      if (long > 0) return '1h'
      if (short > 0) return '5m'
    } catch { /* the first line of the tail is cut */ }
  }
  return null
}

function readTail(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The cache lifetime of the session in this tab, when AIDE can tell. */
export function tabCacheTtl(projectPath: string, tabId: string | null): '5m' | '1h' | null {
  if (!tabId) return null
  for (const manager of ptyRegistry.values()) {
    const tab = manager.getTabs().find((t) => t.tabId === tabId)
    if (!tab) continue
    if (tab.toolId !== 'claude-code' || !tab.sessionId) return null
    try {
      return lastCacheTtl(readTail(join(getSessionsDir(projectPath), `${tab.sessionId}.jsonl`)))
    } catch {
      return null
    }
  }
  return null
}
