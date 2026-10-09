# Headless CLI Matrix

> Status: **Phase 0 spike result** (2026-10-09) for `docs/pipeline-orchestration-plan.md` §5.2.
> Each fact is marked with its source: **live** (run by us against the installed
> CLI), **help** (`--help` of the installed version), **prod** (in production use
> by the rutracker metadata pipeline on this machine), **docs/memory** (not yet
> verified here).

Installed versions at the time of the spike: Claude Code **2.1.295**, Codex **0.160.1**.

## Summary

| | Claude Code | Codex | Devin | Cursor | OpenCode |
|---|---|---|---|---|---|
| Headless invocation | `-p` (**live**) | `exec` (**prod**) | `-p --prompt-file` (**prod**) | `--print` (**prod**) | `run` (docs/memory) |
| Event stream | `--output-format stream-json --verbose` (**live**) | `--json` JSONL (**prod**) | none (text) | none (text) | ? |
| Structured final answer | `--json-schema <inline JSON>` → `result.structured_output` (**live**) | `--output-schema <file>` + `-o <file>` (**prod**) | agent writes a file | agent writes a file | ? |
| Session id | pre-assign `--session-id <uuid>` (**live**) | `thread.started.thread_id` (**prod**) | ? | ? | ? |
| Resume headless | `--resume <id>` keeps context (**live**) | `exec resume <id>` keeps context (**live**) | ? | ? | ? |
| System prompt append | `--append-system-prompt-file` (**live**) | none that appends; prepend to prompt | — | — | ? |
| Read-only profile | `--permission-mode dontAsk --allowedTools … --disallowedTools Edit Write NotebookEdit` blocks writes (**live**) | `--sandbox read-only` + on Windows `-c windows.sandbox='elevated'`: reads allowed, writes denied (**live**) | — | — | ? |
| Write profile | `--permission-mode bypassPermissions` (**live**) | `--dangerously-bypass-approvals-and-sandbox` (**prod**) | `--permission-mode accept-edits` (**prod**) | `--sandbox disabled --trust` (**prod**) | ? |
| Spending / turn cap | `--max-budget-usd` (**help**); no `--max-turns` in help | none; wall-clock timeout only | — | — | ? |
| Executable on this machine | `~/.local/bin/claude.exe` (native) | `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe` (native) | `%LOCALAPPDATA%/devin/cli/bin/devin` | `%LOCALAPPDATA%/cursor-agent` | npm shim `opencode.cmd` (needs a shell) |

Adapters implemented: **Claude Code** (`src/main/pipeline/headless/claudeHeadless.ts`,
verified live) and **Codex** (`codexHeadless.ts`, verified live).

## Claude Code

```
claude -p --output-format stream-json --verbose
       (--session-id <uuid> | --resume <id>)
       [--model <alias>] [--append-system-prompt-file <file>]
       [--json-schema '<schema JSON>'] [--max-budget-usd <n>]
       --permission-mode (dontAsk --allowedTools … --disallowedTools … | bypassPermissions)
       < prompt on stdin
```

- Stream line types seen: `system` (`init`, `thinking_tokens`), `assistant`, `user`,
  `rate_limit_event`, `result`. `assistant`/`user` lines have the same shape as
  the session JSONL, so `parseHistoryLine` normalizes them unchanged.
- `result`: `subtype` (`success` / `error_*`), `is_error`, `result` (final text),
  `structured_output`, `total_cost_usd`, `num_turns`, `session_id`.
- Structured output is produced through an internal `StructuredOutput` tool call;
  the schema is passed inline.
- `--resume` with a new prompt returned the same `session_id` and remembered the
  previous turn without re-reading files.
- In `dontAsk` mode, read-only tools outside `--allowedTools` (e.g. `Glob`) were
  still allowed; writes were refused.
- Sessions are persisted under `~/.claude/projects/<encoded cwd>/` like
  interactive ones, so AIDE's existing scanners can read them.

## Codex

```
codex exec --json --skip-git-repo-check --ignore-user-config
           --color never --cd <dir> [--model M]
           (--sandbox read-only | --dangerously-bypass-approvals-and-sandbox)
           [--output-schema <schema.json>] -o <last-message.txt> -
codex exec resume --json --skip-git-repo-check --ignore-user-config [--model M]
           (-c sandbox_mode='read-only' | --dangerously-bypass-approvals-and-sandbox)
           [--output-schema <file>] -o <file> <session-id> -
```

- `--json` events (**prod** fixture): `thread.started {thread_id}`, `turn.started`,
  `item.completed {item}`, `turn.completed {usage}`; failures as `turn.failed {error}`
  or `error {message}`. Item types handled: `agent_message`, `reasoning`,
  `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `error`
  (non-fatal warnings). Types other than `agent_message`/`error` are from
  docs/memory and should be confirmed by the live test.
- `--output-schema` requires an OpenAI strict schema: `additionalProperties: false`
  and every property listed in `required` (**prod**).
- **stdin limit ≈ 1 MiB**; the adapter refuses prompts above 900 000 characters.
- `exec resume` has no `--sandbox` and no `--cd` (**help**); `-c sandbox_mode='read-only'`
  plus the spawn cwd work (**live**).
- **Windows sandbox:** with `--ignore-user-config` the default Windows sandbox
  blocks *every* command, reads included ("blocked by policy") in both
  `read-only` and `workspace-write`, even with `approval_policy="never"` (**live**).
  The user config had `[windows] sandbox = "elevated"`; passing
  `-c windows.sandbox='elevated'` restores reads and still denies writes (**live**).
  The adapter adds it to sandboxed runs on Windows. Unsandboxed runs
  (`--dangerously-bypass-approvals-and-sandbox`) are unaffected.
- `command_execution` items carry the shell wrapper (`"…\pwsh.exe" -Command '…'`),
  `aggregated_output` and `exit_code` (**live**); the adapter unwraps the
  PowerShell wrapper for display.
- `--ignore-user-config` skips `~/.codex/config.toml` (models, profiles, MCP
  servers); auth still comes from `CODEX_HOME` (**help**). It is not related to
  the app-server daemon.
- **Daemon:** `codex exec` has no `--no-daemon` flag, unlike the interactive
  `codex` / `codex resume` (**help**), which suggests exec runs in-process and is
  unaffected by AIDE stopping the shared daemon on account switch. The live
  test ran fine next to a background rutracker pipeline issuing its own
  `codex exec` calls; the account-switch interaction itself was not tested.
- `model_instructions_file` (`-c`) replaces Codex's base instructions, so role
  instructions are prepended to the prompt instead.

## Devin, Cursor, OpenCode

Recipes from the rutracker pipeline (**prod**); no adapters yet.

- Devin: `devin --model M --permission-mode accept-edits --respect-workspace-trust false --prompt-file <file> -p`.
  Models: `devin models list`.
- Cursor: `cursor-agent --print --auto-review --sandbox disabled --trust --output-format text --model M --workspace <dir>` (prompt on stdin).
  Models: `cursor-agent --list-models`.
- Neither emits structured output: the agent writes a result file which the
  caller validates. Live transcripts would come from their session files via the
  existing AIDE scanners.
- OpenCode is an npm `.cmd` shim; spawning it without a shell needs resolving the
  underlying script. Not investigated.

## Environment and proxy

Headless runs go through `startHeadless(tool, …)`
(`src/main/pipeline/headless/index.ts`), which builds the child environment
exactly like PTY sessions: AIDE's environment plus `tool.getEnvOverrides()` —
the per-CLI proxy from AIDE settings (`HTTP(S)_PROXY`, and `NO_PROXY` for
loopback so local MCP servers keep working).

## Running the live tests

```
AIDE_LIVE_CLAUDE=1 npx vitest run claude.live   # a few cents on haiku; cleans up its sessions
AIDE_LIVE_CODEX=1  npx vitest run codex.live    # run only when no interactive Codex session matters
```

## Open items

- Devin and Cursor: resume support, session-id discovery.
- OpenCode: everything.
