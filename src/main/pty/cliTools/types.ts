export interface CliSession {
  sessionId: string
  slug: string        // human-readable label (used as tab title until OSC title arrives)
  lastModified: Date
}

export interface CliTool {
  readonly id: string
  readonly name: string

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
}
