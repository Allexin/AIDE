# Smart Compact - Autonomous CLI Prototype

## Goal

Smart Compact selectively removes completed or irrelevant parts of an existing CLI session
without replacing the remaining context with a summary.

The analyzer is the same CLI tool that owns the session. AIDE does not call an external model,
does not require separate API settings, and does not use the history viewer abstraction.

The first implementation supports:

- Claude Code JSONL sessions
- Codex JSONL rollout sessions

OpenCode and other database-backed session stores are out of scope for this prototype.

## User Flow

1. A Smart Compact button is shown next to History for supported terminal tabs.
2. The user enters a cleanup task, for example:

   ```text
   We spent a lot of time investigating feature X. Remove the conversation related to that
   investigation so we can continue with the primary task.
   ```

3. AIDE blocks the editor UI and sends the adapter-provided exit command to the interactive CLI.
   The PowerShell PTY, xterm, tab ID, session ID, title, and tab position remain unchanged.
4. AIDE waits until the CLI process disappears from the PTY process tree, confirming that the
   session file is no longer being written.
5. AIDE copies the target JSONL into a temporary workspace containing `session.jsonl` and
   `report.json`.
6. AIDE starts a separate autonomous invocation of the same CLI and waits for it to exit.
7. The autonomous CLI reads the snapshot and writes candidate groups to `report.json`. It rereads
   and may correct that file before exiting.
8. AIDE streams stdout/stderr into the blocking progress dialog. After completion, the review
   dialog retains the complete stdout in a readable expandable section; stdout is never parsed as
   the report.
9. AIDE validates the result and shows candidate groups with checkboxes.
10. The user may deselect groups that must remain, then approves the deletion.
11. The CLI adapter atomically rewrites the JSONL file, removing the selected physical records.
12. AIDE writes the adapter's existing `resumeCommand(sessionId)` into the same PowerShell PTY and
   unblocks the UI. No tab or PTY is created, closed, or replaced.

Cancelling the review leaves the file unchanged and resumes the original session.

## Architectural Boundary

Smart Compact does not use `HistoryEntry`, `getSessionHistory`, the history viewer, or normalized
conversation indices. Those APIs intentionally discard or reshape storage records and therefore
cannot safely identify physical JSONL lines for deletion.

Each CLI adapter owns:

- locating its session file;
- describing its storage format to an autonomous invocation;
- launching the CLI in autonomous mode;
- mapping returned record numbers to review data;
- expanding selections to atomic record groups;
- validating that the file did not change;
- atomically applying deletions.

The renderer only receives universal review DTOs and never sees CLI-specific JSON.

## CLI Interface

```typescript
interface SmartCompactCandidate {
  id: string
  reason: string
  selected: boolean
  messages: Array<{
    role: string
    preview: string
  }>
}

interface SmartCompactAnalysis {
  analysisId: string
  candidates: SmartCompactCandidate[]
}

interface SmartCompactCapability {
  getStorageInstructions(sessionFile: string): string

  runAutonomous(options: {
    projectPath: string
    workspace: {
      directory: string
      sessionFile: string
      reportFile: string
    }
    prompt: string
  }): Promise<void>

  analyzeSession(options: {
    projectPath: string
    sessionId: string
    task: string
  }): Promise<SmartCompactAnalysis>

  applyDeletions(options: {
    projectPath: string
    sessionId: string
    analysisId: string
    candidateIds: string[]
    force: boolean
  }): Promise<SmartCompactApplyResult>

  discardAnalysis(analysisId: string): void
}

interface CliTool {
  smartCompact?: SmartCompactCapability
  exitCommand?(): string
  interactiveSubmitSequence?(): string
}
```

The optional capability controls button availability. Unsupported tools do not expose Smart
Compact.

Input tracing confirmed that physical typing arrives one character at a time, bracketed paste uses
`ESC[200~...ESC[201~`, and physical Enter is carriage return. `PtyManager.submitInteractiveInput()`
therefore has two explicit modes: short slash commands are typed character by character, while long
toolbar assistant prompts use bracketed paste. Both are submitted with the adapter-provided Enter
sequence, currently carriage return for Claude and Codex.

## Autonomous Invocation

The analyzer runs as a normal child process in a new non-persistent autonomous session. It must
never resume the target session,
because doing so would append the analyzer prompt and response to the history being cleaned.

The prototype uses the CLI's existing non-interactive command and waits for process completion:

- Claude Code: print mode with session persistence disabled;
- Codex: `exec` mode with an ephemeral session.

This is not a separate execution subsystem. Each adapter supplies its command-line arguments and
the shared process helper captures the final response.

Before launch, AIDE creates an isolated temporary directory:

```text
aide-smart-compact-<random>/
  session.jsonl
  report.json
```

`session.jsonl` is an exact snapshot of the target session. The autonomous CLI may read the
snapshot and read/write `report.json`, but it cannot access or modify the original session file.

The prompt contains:

- the snapshot filename and report filename;
- a CLI-specific plain-text description of the JSONL format;
- the user's cleanup task;
- conservative deletion rules;
- a strict JSON response schema.

The analyzer must reread `report.json`, validate it, and correct it when necessary. Stdout is
diagnostic only and is never parsed as the report. AIDE performs all original-session writes after
user approval and removes the temporary workspace after loading the report.

Expected response:

```json
{
  "groups": [
    {
      "lines": [5, 6, 7, 8],
      "reason": "Completed investigation of feature X"
    }
  ]
}
```

Line numbers are 1-based physical non-empty JSONL record numbers. They are not history-viewer
message indices.

## Validation And Atomic Groups

The adapter parses the original JSONL and treats related records as atomic. At minimum:

- a tool/function call and its result are kept or removed together;
- metadata required to identify or resume the session is never removable;
- malformed, out-of-range, or ambiguous analyzer selections are dropped;
- the trailing active exchange is never removable;
- an empty validated result is valid and does not rewrite the file.

The review UI shows one checkbox per atomic candidate group. Messages inside the group are shown as
previews. Users cannot split a tool call from its result.

Claude Code records form a `uuid`/`parentUuid` chain. After deletion, the Claude adapter rewires
each retained record whose parent was removed to the nearest retained ancestor. Codex duplicate
user records identify the beginning of a user turn when adjacent records contain identical text.
For Codex, the minimum deletion unit is a complete finished turn: from that paired user message
through its `event_msg/task_complete`, including duplicate `agent_message` records, reasoning,
tool/web-search records, token counts, and other operational records. Unpaired user/developer
bootstrap records and an unfinished trailing turn are protected.

## File Safety

Before analysis, the adapter computes a fingerprint of the complete session file and retains the
selected snapshot records in main-process memory under an opaque `analysisId`.

If the original file changed before apply, AIDE warns the user and offers:

- Cancel: keep the current session unchanged.
- Force apply: match selected snapshot records against the current JSONL by exact record content,
  remove only matched records, and preserve newly added records.

Force apply never interprets old line numbers against the changed file. Missing snapshot records
are kept and reported. Duplicate exact matches are reported as ambiguous; the first unused match is
removed. This operation is deliberately available because rerunning analysis can be expensive, but
the dialog clearly warns that the session was modified outside AIDE.

Application uses an atomic replace:

1. Read and validate the current file and fingerprint.
2. Write retained records to a sibling temporary file.
3. Flush and close the temporary file.
4. Rename the original file to a short-lived backup.
5. Rename the temporary file to the original path.
6. Remove the backup after success; restore it if replacement fails.

## UI Locking

Smart Compact has these states:

```text
idle -> stopping -> analyzing -> reviewing -> applying -> restarting -> idle
```

While the state is not `idle`, an application-level overlay blocks terminal input, tab switching,
tab creation/closing, history, account switching, remote input, and editor interaction. During
`reviewing`, only the Smart Compact dialog is interactive.

Errors are displayed in the dialog. AIDE attempts to resume the original session before releasing
the lock.

## Prototype Non-Goals

- External OpenAI-compatible API settings
- OpenCode or other database-backed stores
- History-viewer integration
- Partial deletion inside a physical JSONL record
- Automatic triggering
- Multiple target sessions in one operation
- Analyzer-written original session files
- Chained compaction guarantees
