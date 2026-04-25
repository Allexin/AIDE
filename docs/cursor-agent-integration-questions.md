# Cursor Agent CLI Integration: Open Questions

This document tracks non-obvious items for full Cursor Agent CLI support in AIDE.

## Implemented baseline

- Registered new tool: `cursor-agent` (`Cursor Agent CLI`)
- Install detection via `where agent` + PowerShell `Get-Command agent`
- New session command: `agent`
- Resume command: `agent --resume "<sessionId>"`
- Startup health check with basic dead/ready heuristics
- Proxy settings support (`HTTP_PROXY`, `HTTPS_PROXY`, lowercase variants)
- Tool appears in CLI Tools manager and can be activated
- Session discovery from local Cursor storage:
  - `~/.cursor/projects/<project-slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl`
  - `scanSessions` and `watchForNewSessions` use transcript files (no `agent ls` shell calls)
- Session data support from transcript JSONL:
  - `getSessionPreview`
  - `getSessionHistory`
  - `subscribeToSessionHistory`
  - `getSessionFilePath`
  - `parseThinkingBlocks`
- Account system implemented (`hasAccountSystem() === true`)
- Login state + identifier:
  - `isLoggedIn` checks Cursor token presence
  - `getLoginIdentifier` returns `cursorAuth/cachedEmail` (fallback to `null`)
- Credential export/import/clear implemented by synchronizing both Cursor storages:
  - `%APPDATA%/Cursor/auth.json`
  - `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (`ItemTable`)
- Account switch writes `cursorAuth/*` keys + updates
  - `membershipType`
  - `subscriptionStatus`
  - `aiSettings.teamIds`
  in `src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser`
- Usage integration implemented (`getUsageInfo`) via Cursor Dashboard API:
  - `POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage`
  - `POST /aiserver.v1.DashboardService/GetPlanInfo`
- OAuth refresh flow implemented for expired access token:
  - `POST /oauth/token` with `grant_type=refresh_token`
  - on success, refreshed tokens are persisted back to both Cursor storages
- Usage cache/backoff implemented:
  - shared cache file: `~/.aide/cursor-agent-usage.json`
  - cache TTL: 5 minutes
  - account-aware cache ownership (`account` field)
  - 429 backoff: exponential, up to 30 minutes
  - cache is intentionally shared across multiple AIDE instances

## Open questions

1. Storage contract stability (CLOSED for current scope)
- Decision: no active fallback beyond best-effort parsing.
- Implemented behavior: emit AIDE log warnings when transcript/store format looks incompatible, continue soft-fail parsing.

2. New session ID assignment (CLOSED for current scope)
- AIDE assigns tab `sessionId` by observing newly created session artifacts.
- Implemented now:
  - transcript-directory watcher emits new `sessionId` from storage
  - `resolveOwnerPid` for Cursor Agent maps new sessions to correct waiting PTY tab
- Decision for hard case:
  - if Cursor changes process naming/launch chain, keep warn-only diagnostics in AIDE logs.

3. Account management semantics (CLOSED for current scope)
- AIDE-side account save/load is implemented and working on current Cursor storage schema.
- Decision:
  - keep best-effort compatibility and emit warnings when state/auth schema access fails.
- Existing safety:
  - writes are scoped to known keys only;
  - operations are idempotent;
  - unknown JSON fields in `applicationUser` are preserved.

4. Login identifier quality (CLOSED for current scope)
- Identifier now uses persisted account email (`cursorAuth/cachedEmail`) instead of static tool label.
- Optional future enhancement: cross-check with live CLI/API identity if Cursor adds a stable endpoint.

5. Context insert format (CLOSED)
- Verified: sending `@path` to Cursor Agent does not auto-attach file contents (unlike Claude Code behavior).
- Decision: `contextInsert` is enabled and inserts `@<relativePath>` as a lightweight file reference.
- Note: this is prompt convenience only, not guaranteed automatic content attachment.

6. Completion signaling (CLOSED)
- Decision: use fixed inactivity timeout (same approach as Qwen Code) to emit `completeAndWait`.

7. History fidelity details (CLOSED for current scope)
- Current parser support is accepted as sufficient for now.

## Suggested closure order

1. Resume reliability across app restarts
2. Ongoing monitoring of Cursor schema drift via warn logs
