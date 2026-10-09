import type { CliTool } from '../../pty/cliTools/types'
import { failedRun } from './common'
import type { HeadlessRun, HeadlessRunOptions } from './types'

export type { HeadlessRun, HeadlessRunOptions, HeadlessResult, HeadlessCapability, PermissionProfile } from './types'

/**
 * Start a headless run of `tool`. The child environment is built the same way
 * as for the tool's PTY sessions: AIDE's environment plus the tool's own
 * overrides — notably the proxy configured for that CLI in AIDE settings.
 */
export function startHeadless(tool: CliTool, options: Omit<HeadlessRunOptions, 'env'> & { env?: NodeJS.ProcessEnv }): HeadlessRun {
  if (!tool.headless) return failedRun('not_installed', `${tool.name} does not support headless runs`)
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}), ...(tool.getEnvOverrides?.() ?? {}) }
  return tool.headless.run({ ...options, env })
}
