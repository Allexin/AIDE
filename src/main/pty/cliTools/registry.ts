import type { CliTool } from './types'
import { claudeCodeTool } from './claudeCode'

const cliToolRegistry: CliTool[] = [claudeCodeTool]

export function getRegisteredTools(): { id: string; name: string }[] {
  return cliToolRegistry.map((t) => ({ id: t.id, name: t.name }))
}

export function getToolById(id: string): CliTool | undefined {
  return cliToolRegistry.find((t) => t.id === id)
}
