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
  /** A persistent directory AIDE owns for this CLI, for adapters that keep their
   *  own config home across runs (Cursor). Set by `startHeadless`. */
  stateDir?: string
  /** Override of the resolved executable (tests: `node fakeCli.cjs`). */
  executable?: { command: string; args?: string[] }
  /** Short label for diagnostics. */
  label: string
  /** Normalized transcript entries as they stream in. */
  onEntry?: (entry: HistoryEntry) => void
  /** Called as soon as the CLI session id is known. */
  onSessionId?: (sessionId: string) => void
  /** An MCP endpoint whose `submit_result` tool takes the final answer, for adapters that declare
   *  `resultTool` (set by the pipeline when an output schema is asked and its server runs). */
  resultTool?: ResultTool
}

/**
 * The final answer of a step as a tool call instead of JSON in the last message:
 * the CLI checks the call's arguments and the tool checks them against the schema,
 * so the agent corrects a malformed answer in the same turn.
 */
export interface ResultTool {
  /** MCP server name the adapter registers the endpoint under (its tool is `submit_result`). */
  serverName: string
  url: string
  headers: Record<string, string>
  /** The last answer that matched the schema, or undefined when none was submitted. */
  submitted(): unknown
}

export type HeadlessErrorCode =
  | 'not_installed'
  | 'spawn_failed'
  | 'timeout'
  | 'cancelled'
  | 'limit'
  /** The service is temporarily unavailable (model at capacity, overloaded, network): the engine retries. */
  | 'unavailable'
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
  /** The adapter can take the final answer through `HeadlessRunOptions.resultTool`. */
  readonly resultTool?: boolean
}
