import type { ToolView } from './types'

/**
 * Per-CLI mapping of native tool calls to the neutral `ToolView` consumed by the
 * transcript renderer. Unknown tools return `undefined` and render generically.
 */

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function lineRange(offset: unknown, limit: unknown): string | undefined {
  const start = typeof offset === 'number' && offset > 0 ? offset : undefined
  const count = typeof limit === 'number' && limit > 0 ? limit : undefined
  if (start === undefined && count === undefined) return undefined
  const from = start ?? 1
  return count === undefined ? `from line ${from}` : `lines ${from}–${from + count - 1}`
}

export function claudeToolView(name: string, input: unknown): ToolView | undefined {
  const args = obj(input)
  const path = str(args.file_path) ?? str(args.notebook_path) ?? ''
  switch (name) {
    case 'Edit':
      return { kind: 'edit', path, edits: [{ oldText: String(args.old_string ?? ''), newText: String(args.new_string ?? '') }] }
    case 'MultiEdit': {
      const edits = Array.isArray(args.edits) ? args.edits.map((edit) => {
        const e = obj(edit)
        return { oldText: String(e.old_string ?? ''), newText: String(e.new_string ?? '') }
      }) : []
      return { kind: 'edit', path, edits }
    }
    case 'Write':
      return { kind: 'write', path, content: String(args.content ?? '') }
    case 'Read':
      return { kind: 'read', path, range: lineRange(args.offset, args.limit) }
    case 'Bash':
    case 'PowerShell':
      return str(args.command) ? { kind: 'shell', command: String(args.command) } : undefined
    case 'Grep':
    case 'Glob':
      return str(args.pattern) ? { kind: 'search', pattern: String(args.pattern), path: str(args.path) } : undefined
    default:
      return undefined
  }
}

/** File paths named in an `apply_patch` envelope (`*** Update File: path`). */
function patchPaths(patch: string): string[] {
  const paths: string[] = []
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1].trim())
  return paths
}

/** Shell command from a legacy Codex `shell` call: `["powershell", "-Command", "..."]` → the script. */
function shellArray(command: unknown[]): string {
  const parts = command.map(String)
  const flag = parts.findIndex((part) => /^-(?:c|command)$/i.test(part))
  return flag >= 0 && flag < parts.length - 1 ? parts.slice(flag + 1).join(' ') : parts.join(' ')
}

/** String literals passed as `cmd` to `tools.exec_command(...)` inside a Codex `exec` cell. */
function execCommands(code: string): string[] {
  const commands: string[] = []
  for (const match of code.matchAll(/exec_command\(\s*\{\s*["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try { commands.push(JSON.parse(match[1]) as string) } catch { /* not a plain JSON string literal */ }
  }
  return commands
}

export function codexToolView(name: string, input: unknown): ToolView | undefined {
  if (name === 'exec' && typeof input === 'string') {
    const commands = execCommands(input)
    // A cell that is nothing but one wrapped exec_command call is shown as that command.
    if (commands.length === 1 && /^\s*text\(\s*await tools\.exec_command\([^\n]*\)\s*\);?\s*$/.test(input)) {
      return { kind: 'shell', command: commands[0] }
    }
    // Skip comment lines such as the `// @exec: {...}` directive Codex prepends.
    const firstLine = input.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('//')) ?? ''
    return { kind: 'script', language: 'javascript', code: input, summary: commands[0] ?? firstLine }
  }
  if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : str(obj(input).input) ?? ''
    return patch ? { kind: 'patch', paths: patchPaths(patch), patch } : undefined
  }
  const args = obj(input)
  if (name === 'shell' && Array.isArray(args.command)) return { kind: 'shell', command: shellArray(args.command) }
  if (name === 'shell_command' && str(args.command)) return { kind: 'shell', command: String(args.command) }
  if (name === 'exec_command' && str(args.cmd)) return { kind: 'shell', command: String(args.cmd) }
  return undefined
}

/** OpenCode 2 tools. Older sessions name the path `filePath`; current `read` takes `path`. */
export function openCodeToolView(name: string, input: unknown): ToolView | undefined {
  const args = obj(input)
  const path = str(args.path) ?? str(args.filePath) ?? ''
  switch (name) {
    case 'edit':
      return { kind: 'edit', path, edits: [{ oldText: String(args.oldString ?? ''), newText: String(args.newString ?? '') }] }
    case 'write':
      return { kind: 'write', path, content: String(args.content ?? '') }
    case 'read':
      return { kind: 'read', path, range: lineRange(args.offset, args.limit) }
    case 'shell':
    case 'bash':
      return str(args.command) ? { kind: 'shell', command: String(args.command) } : undefined
    case 'grep':
    case 'glob':
      return str(args.pattern) ? { kind: 'search', pattern: String(args.pattern), path: str(args.path) } : undefined
    default:
      return undefined
  }
}
