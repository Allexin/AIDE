import type { CliTool } from './types'
import { claudeCodeTool } from './claudeCode'
import { qwenCodeTool } from './qwenCode'
import { openCodeTool } from './openCode'
import { cursorAgentTool } from './cursorAgent'
import { codexTool } from './codex'
import { plainShellTool } from './plainShell'

/** AI CLI tools that users can activate (shown in settings, require install). */
const cliToolRegistry: CliTool[] = [claudeCodeTool, qwenCodeTool, openCodeTool, cursorAgentTool, codexTool]

/** Always-available built-in tools (not user-activatable, used as fallback). */
const builtinTools: CliTool[] = [plainShellTool]

export function getRegisteredTools(): CliTool[] {
  return cliToolRegistry
}

export function getToolById(id: string): CliTool | undefined {
  return [...cliToolRegistry, ...builtinTools].find((t) => t.id === id)
}

export function getDefaultTool(activatedTools: string[]): CliTool {
  const first = cliToolRegistry.find((t) => activatedTools.includes(t.id))
  return first ?? plainShellTool
}
