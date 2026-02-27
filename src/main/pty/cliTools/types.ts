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
}
