import type { HistoryBlock } from './types'
import { openCodeToolView } from './toolViews'

/**
 * Transcript blocks of one OpenCode 2 message part. The same parts arrive in two
 * shapes: stored in the database (`session_message.data.content[]`: a tool has
 * `name` and its result in `state.content[]`) and streamed by `opencode run
 * --format json` (`part`: a tool has `tool` and its result in `state.output`).
 */

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Result text of a finished tool call, or null while it is still running. */
function toolResult(state: Record<string, unknown>): string | null {
  if (typeof state.output === 'string') return state.output
  if (Array.isArray(state.content)) {
    return state.content.map((item) => str(obj(item).text)).filter(Boolean).join('\n')
  }
  const error = state.error
  if (error !== undefined) return typeof error === 'string' ? error : str(obj(error).message) || JSON.stringify(error)
  return state.status === 'completed' || state.status === 'error' ? '' : null
}

export function openCodePartBlocks(value: unknown): HistoryBlock[] {
  const part = obj(value)
  switch (part.type) {
    case 'text':
      return str(part.text).trim() ? [{ type: 'text', text: str(part.text) }] : []
    case 'reasoning':
      return str(part.text).trim() ? [{ type: 'thinking', thinking: str(part.text) }] : []
    case 'tool': {
      const name = str(part.name) || str(part.tool)
      const id = str(part.id) || str(part.callID)
      const state = obj(part.state)
      const result = toolResult(state)
      if (!name || !id || result === null) return []
      const input = obj(state.input)
      return [
        { type: 'tool_use', id, name, input, view: openCodeToolView(name, input) },
        { type: 'tool_result', tool_use_id: id, content: result }
      ]
    }
    default:
      return []
  }
}
