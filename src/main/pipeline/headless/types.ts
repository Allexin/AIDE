import type { HistoryEntry } from '../../pty/cliTools/types'

/**
 * Headless (non-interactive) execution of an agent CLI for one pipeline node
 * visit. Each CLI adapter maps its native invocation and output to this
 * contract. See docs/headless-cli-matrix.md.
 */

/** `read-only`: may read and run read-only commands. `write`: full workspace access. */
export type PermissionProfile = 'read-only' | 'write'

export interface HeadlessRunOptions {
  /** Project root the agent works in. */
  cwd: string
  /** Directory for this run's artifacts (schema file, last message, logs). Must exist. */
  runDir: string
  prompt: string
  /** Role instructions; appended to the system prompt where the CLI supports it. */
  systemAppend?: string
  permissions: PermissionProfile
  /** JSON Schema the final answer must satisfy. Codex requires a strict schema
   *  (`additionalProperties: false`, every property listed in `required`). */
  outputSchema?: Record<string, unknown>
  model?: string
  /** Reasoning effort (`--effort` for Claude Code, `model_reasoning_effort` for Codex). */
  effort?: string
  /** Continue this CLI session instead of starting a new one. */
  resumeSessionId?: string
  timeoutMs?: number
  /** Claude Code only: spending cap for the run. */
  maxBudgetUsd?: number
  /** Full environment for the child, including the tool's proxy overrides. */
  env: NodeJS.ProcessEnv
  /** Override of the resolved executable (tests: `node fakeCli.cjs`). */
  executable?: { command: string; args?: string[] }
  /** Short label for diagnostics. */
  label: string
  /** Normalized transcript entries as they stream in. */
  onEntry?: (entry: HistoryEntry) => void
  /** Called as soon as the CLI session id is known. */
  onSessionId?: (sessionId: string) => void
}

export type HeadlessErrorCode =
  | 'not_installed'
  | 'spawn_failed'
  | 'timeout'
  | 'cancelled'
  | 'limit'
  | 'prompt_too_large'
  | 'no_output'
  | 'failed'

export interface HeadlessResult {
  ok: boolean
  sessionId: string | null
  /** Parsed final answer when `outputSchema` was given (schema validation is the engine's job). */
  structured: unknown
  finalText: string | null
  costUsd: number | null
  /** Non-fatal warnings reported by the CLI. */
  warnings: string[]
  error: { code: HeadlessErrorCode; message: string } | null
}

export interface HeadlessRun {
  readonly result: Promise<HeadlessResult>
  cancel(): Promise<void>
}

export interface HeadlessCapability {
  run(options: HeadlessRunOptions): HeadlessRun
}
