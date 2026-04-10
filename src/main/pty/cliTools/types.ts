import type { SettingsField } from '../../../shared/settingsTypes'
export type { SettingsField }

export interface CliSession {
  sessionId: string
  slug: string          // human-readable label (used as tab title until OSC title arrives)
  summary?: string      // optional AI-generated session title (e.g. from Claude Code custom-title entry)
  firstMessage?: string // first real user message (for session list display)
  lastModified: Date
}

export interface CliTool {
  readonly id: string
  readonly name: string

  /** URL shown in CLI Tools Manager when the tool is not installed. */
  readonly installUrl?: string

  /** Returns true if the CLI binary is present on the system. */
  isInstalled(): Promise<boolean>

  /** Declares configurable fields rendered in Settings UI. */
  settingsFields?(): SettingsField[]

  /** Load current settings values. */
  getSettings?(): Promise<Record<string, unknown>>

  /** Persist updated settings values. */
  updateSettings?(values: Record<string, unknown>): Promise<void>

  /** Return additional environment variables to inject into the PTY shell.
   *  Called synchronously at spawn time; reads from in-memory config only.
   */
  getEnvOverrides?(): Record<string, string>

  /** Find existing sessions for a project on disk, sorted newest first. */
  scanSessions(projectPath: string): Promise<CliSession[]>

  /** Command to resume an existing session (written to PTY stdin). */
  resumeCommand(sessionId: string): string

  /** Command to start a new session (written to PTY stdin). */
  newSessionCommand(): string

  /** Watch for new sessions appearing on disk (e.g. a new .jsonl file).
   *  Calls onNew when a session is created.
   *  Returns an unsubscribe function.
   */
  watchForNewSessions(
    projectPath: string,
    onNew: (session: CliSession) => void
  ): () => void

  /** Optionally watch for label updates for a running session.
   *  Returns an unsubscribe function.
   */
  watchSessionLabel?(
    projectPath: string,
    sessionId: string,
    onLabel: (label: string) => void
  ): () => void

  /** Optionally run any one-time setup before the first session starts
   *  (e.g. writing trust config so the tool doesn't prompt the user).
   */
  prepareProject?(projectPath: string): Promise<void>

  /** Check whether the CLI has finished starting up by inspecting accumulated output.
   *  Returns 'ok' when ready, 'dead' if the session is invalid, 'pending' otherwise.
   */
  checkStartupHealth?(
    accumulated: string,
    elapsedMs: number
  ): 'ok' | 'dead' | 'pending'

  /** Given a set of candidate PTY PIDs (powershell), resolve which one
   *  is the parent of a currently running CLI process.
   *  Used when multiple tabs exist and a new session file appears.
   *  Returns the matching PTY PID or null.
   */
  resolveOwnerPid?(candidatePids: number[]): Promise<number | null>

  /** Check if the user is currently logged in to this CLI tool. */
  isLoggedIn?(): Promise<boolean>

  /** Return a human-readable identifier for the currently logged-in user
   *  (e.g. email address). Returns null if not logged in.
   */
  getLoginIdentifier?(): Promise<string | null>

  /** Check whether the given saved credentials match the currently active ones.
   *  Used to find the matching saved account for status display.
   */
  credentialsMatch?(saved: Record<string, unknown>): Promise<boolean>

  /** Export the current credentials as a serialisable object.
   *  Returns null if not logged in.
   */
  exportCredentials?(): Promise<Record<string, unknown> | null>

  /** Import previously exported credentials, overwriting the current ones. */
  importCredentials?(credentials: Record<string, unknown>): Promise<void>

  /** Clear local credentials so the CLI tool prompts for a new login.
   *  Unlike the CLI's own logout, this does NOT revoke tokens server-side.
   */
  clearCredentials?(): Promise<void>

  /** Return current usage/limit info for display in the status bar.
   *  The implementation decides what to show — the caller treats it opaquely.
   */
  getUsageInfo?(): Promise<UsageInfo | null>

  /** Inspect a tab title transition and return a named event string if something notable
   *  happened, or null if the transition is unremarkable.
   *  prevTitle is null on the very first title assignment.
   */
  detectTitleEvent?(prevTitle: string | null, newTitle: string): string | null

  /** Return the last few conversation messages for a session, for preview in the session picker.
   *  Returns an empty array if the tool does not support session preview.
   */
  getSessionPreview?(projectPath: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>>

  /** Return the full conversation history for a session, for display in the history viewer.
   *  Returns an empty array if the tool does not support session history.
   */
  getSessionHistory?(projectPath: string, sessionId: string): Promise<HistoryEntry[]>

  /** Return the absolute path to the session data file for the given session.
   *  Used by ThinkingWatcher and other components that need to read session files directly.
   *  Returns null if the tool does not use file-based session storage.
   */
  getSessionFilePath?(projectPath: string, sessionId: string): string | null

  /** Start streaming new history entries for a session.
   *  Calls `onEntry` whenever a new entry arrives (e.g. from file watch, API, etc).
   *  Returns a cleanup function to stop the subscription.
   *  Tools that don't support live updates can omit this.
   */
  subscribeToSessionHistory?(
    projectPath: string,
    sessionId: string,
    onEntry: (entry: HistoryEntry) => void
  ): () => void

  /** Return the text to insert into the terminal to reference a file in AI context
   *  (e.g. Claude Code uses "@relativePath").
   *  Returns null if the tool does not support this feature — the context menu item is hidden.
   */
  contextInsert?(relPath: string): string | null

  /** Parse a single JSONL session line and return thinking block texts.
   *  Returns [] if the line has no thinking content or the tool doesn't support it.
   *  Each tool knows its own format — Claude uses message.content[], Qwen uses message.parts[] with thought flag.
   */
  parseThinkingBlocks?(line: string): string[]
}

export type HistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
  | { type: 'thinking'; thinking: string }

export interface HistoryEntry {
  role: 'user' | 'assistant'
  blocks: HistoryBlock[]
}

export interface UsageInfo {
  /** Short text for the status bar (e.g. "37% / 26%"). */
  summary: string
  /** Longer text shown on hover. */
  tooltip: string
  /** Colour hint: normal = white, warn = yellow, critical = red. */
  level: 'normal' | 'warn' | 'critical'
  /** Epoch ms when the data was actually fetched from the API. */
  fetchedAt: number
  /** When false, there is no usage limit — callers should not color-code based on level. */
  hasLimit?: boolean
}
