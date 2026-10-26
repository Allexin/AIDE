# Headless CLI Matrix

> Status: **Phase 0 spike result** (2026-10-09) for `docs/pipeline-orchestration-plan.md` §5.2.
> Each fact is marked with its source: **live** (run by us against the installed
> CLI), **help** (`--help` of the installed version), **prod** (in production use
> by the rutracker metadata pipeline on this machine), **docs/memory** (not yet
> verified here).

Installed versions at the time of the spike: Claude Code **2.1.295**, Codex **0.160.1**.
OpenCode column verified 2026-10-24 against OpenCode **2.1.4** (1.x is not supported); Devin and Cursor
columns verified 2026-10-25 against Devin **3000.11.92** and Cursor Agent **2026.09.26**.

## Summary

| | Claude Code | Codex | Devin | Cursor | OpenCode 2 |
|---|---|---|---|---|---|
| Headless invocation | `-p` (**live**) | `exec` (**prod**) | `-p --prompt-file <file>` (**live**) | `--print`, prompt on stdin (**live**) | `run --standalone`, prompt on stdin (**live**) |
| Event stream | `--output-format stream-json --verbose` (**live**) | `--json` JSONL (**prod**) | none; stdout is the final message, `--export <file>` writes ATIF at the end (**live**) | `--output-format stream-json`: `system/init` / `thinking` / `assistant` / `tool_call` / `result` (**live**) | `--format json` JSONL: `step_start` / `text` / `tool_use` / `step_finish` / `error` (**live**) |
| Structured final answer | `--json-schema <inline JSON>` → `result.structured_output` (**live**) | `--output-schema <file>` + `-o <file>` (**prod**) | none; schema as a prompt instruction, final message parsed (**live**) | none; schema as a prompt instruction, final message parsed (**live**) | no native mode; the answer is a call of AIDE's `submit_result` MCP tool (remote server `aide_step` in the per-run config), checked against the schema; final message parsed as a fallback (**live**) |
| Session id | pre-assign `--session-id <uuid>` (**live**) | `thread.started.thread_id` (**prod**) | `session_id` of the export, a name such as `thoughtful-papyrus` (**live**) | `session_id` of `system/init` (**live**) | `sessionID` on every event (**live**) |
| Resume headless | `--resume <id>` keeps context (**live**) | `exec resume <id>` keeps context (**live**) | `--resume <id>` keeps context (**live**) | `--resume <id>` keeps context, also from the other permission profile (**live**) | `--session <id>` keeps context (**live**) |
| System prompt append | `--append-system-prompt-file` (**live**) | none that appends; prepend to prompt | none; prepend to prompt | none; prepend to prompt | none; prepend to prompt |
| Read-only profile | `--permission-mode dontAsk --allowedTools … --disallowedTools Edit Write NotebookEdit` blocks writes (**live**) | `--sandbox read-only` + on Windows `-c windows.sandbox='elevated'`: reads allowed, writes denied (**live**) | `--permission-mode auto`: read-only tools and commands run, the rest is rejected in print mode (**live**) | own `CURSOR_CONFIG_DIR` whose permissions allow `Read(**)` and `Shell(git status/diff/log/show)`, deny `Write(**)`; no `--force`, so other commands are rejected (**live**) | own agent via `OPENCODE_CONFIG_CONTENT` (`edit: deny`, shell only `git status/diff/log/show`): writes denied (**live**) |
| Write profile | `--permission-mode bypassPermissions` (**live**) | `--dangerously-bypass-approvals-and-sandbox` (**prod**) | `--permission-mode dangerous` (**live**) | `--force --sandbox disabled` (**live**) | `--auto` (**live**) |
| Spending / turn cap | `--max-budget-usd` (**help**); no `--max-turns` in help | none; wall-clock timeout only | none; wall-clock timeout only | none; wall-clock timeout only | none; wall-clock timeout only |
| Executable on this machine | `~/.local/bin/claude.exe` (native) | `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe` (native) | `%LOCALAPPDATA%/devin/cli/bin/devin.exe` (native) | `%LOCALAPPDATA%/cursor-agent/versions/<newest>/node.exe index.js` (what `agent.cmd` runs) | npm shim `opencode.cmd` → native `node_modules/@opencode/cli/bin/opencode.exe`, resolved from the shim |

Adapters implemented: **Claude Code** (`src/main/pipeline/headless/claudeHeadless.ts`,
verified live), **Codex** (`codexHeadless.ts`, verified live), **OpenCode 2**
(`openCodeHeadless.ts`, verified live), **Cursor** (`cursorHeadless.ts`, verified live) and
**Devin** (`devinHeadless.ts`, verified live).

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
- It also drops `model` and `model_reasoning_effort` (**prod**, SpaceHospital
  2026-10-15: implementer sessions ran with near-zero reasoning tokens;
  `gpt-6.1-sol` defaults to effort `low` per `models_cache.json`). The adapter
  passes both explicitly: the step's `model` / `effort`, else the user's
  top-level config values; `-c model_reasoning_effort='high'` shows up as
  `effort: "high"` in the session's `turn_context` (**live**, codex-cli 0.162.1).
- **Reasoning summaries are not available in `exec`:** `turn_context.summary` is
  `"none"` with `-c model_reasoning_summary='detailed'|'auto'`, and also without
  `--ignore-user-config` with the user's `model_reasoning_summary = "detailed"`
  (**live**, 0.162.1). `model_supports_reasoning_summaries` is reported as an
  unrecognized setting. So the transcript of a Codex step shows no reasoning.
- Claude Code: `--effort <low|medium|high|xhigh|max>` (**help**, 2.1.300); the
  user's settings still apply to headless runs.
- **Daemon:** `codex exec` has no `--no-daemon` flag, unlike the interactive
  `codex` / `codex resume` (**help**), which suggests exec runs in-process and is
  unaffected by AIDE stopping the shared daemon on account switch. The live
  test ran fine next to a background rutracker pipeline issuing its own
  `codex exec` calls; the account-switch interaction itself was not tested.
- `model_instructions_file` (`-c`) replaces Codex's base instructions, so role
  instructions are prepended to the prompt instead.

## OpenCode 2

Verified live against 2.1.4 (`AIDE_LIVE_OPENCODE=1 npx vitest run opencode.live`).

- `opencode run --standalone --format json --thinking --auto [--agent aide-read-only]
  [--model provider/model#variant] [--session <id>]`, prompt on stdin (multi-line is kept).
- `--standalone` is required: without it the run attaches to the shared background
  service (`opencode serve --service`), which has its own config and environment — the
  per-run config would not apply, and MCP servers would inherit the environment of
  whichever process started the service (the same reason PTY tabs use it).
- OpenCode takes its working directory from `PWD` when it is set, over the real cwd
  of the process: the adapter (and the PTY) set `PWD` to the project.
- Per-run config through `OPENCODE_CONFIG_CONTENT`, merged over the user's and project's:
  - the read-only agent `aide-read-only` (`edit: deny`, `webfetch: deny`, shell `*: deny`
    except `git status/diff/log/show`). `--auto` approves what is not denied; denied
    calls come back as `Permission denied: shell`. The built-in `plan` agent is not
    enough: it allows arbitrary shell commands.
  - every MCP server named in the user, `OPENCODE_CONFIG` and project configs switched off.
    The override must be a complete entry (`{ type, command, enabled: false }`); a bare
    `{ enabled: false }` is ignored.
- Effort is the model variant (`#high`); an unknown variant fails the run with
  `provider.no-route` "Variant unavailable".
- Events: `text` parts belong to a `messageID`; the final answer is the text of the
  last message. `tool_use` carries the finished call (`part.tool`, `state.input`,
  `state.output` or `state.error`). `error` (`error.type`, `error.message`) comes
  with exit code 1.
- The stream ends before the last step's `step_finish`, so its cost is missing from
  the stream; the adapter reads the run's cost from the database
  (`session_message.data.cost` of the assistant turns of the run).

## Cursor Agent

Verified live against 2026.09.26 (`AIDE_LIVE_CURSOR=1 npx vitest run cursor.live`).

- `node.exe index.js --print --output-format stream-json --trust --workspace <dir>
  [--force --sandbox disabled] [--model M] [--resume <id>]`, prompt on stdin. On Windows
  only `agent.cmd` / `cursor-agent.ps1` are on PATH; the adapter runs what they run: the
  newest `versions/<YYYY.MM.DD[-HH-MM-SS]-commit>/node.exe` with its `index.js`.
- `CURSOR_CONFIG_DIR` (default `~/.cursor`) holds `cli-config.json` (permissions, default
  model), `mcp.json` and `chats/`. Each profile gets its own directory under
  `<userData>/headless/cursor-agent/<profile>/`, whose `chats` is a junction to one shared
  `chats/` — a session continues across profiles. Its `cli-config.json` is rewritten
  before every run: the profile's `permissions` plus the user's `model` / `selectedModel` /
  `modelParameters` (without them the model is "Auto"). The user's MCP servers, rules and
  skills stay out.
- Permissions are enforced by the tools, not by the model: a denied write comes back as
  `writePermissionDenied`, a command blocked by a rule as `permissionDenied`, a command no
  rule allows (without `--force`) as `rejected`. `Shell(git)` allows every git command,
  `git checkout` included; `Shell(git diff)` allows only that subcommand, and a chain
  (`git diff && echo x > f`) is rejected. A deny of `Shell(*)` overrides every allow.
- `--mode plan` / `--mode ask` are not a read-only profile: the model declines writes,
  nothing enforces it.
- Effort is part of the model id (`grok-4.7-high`, `gpt-5.3-codex-xhigh`); the bracket
  form from `--help` (`model[reasoning_effort=high]`) was rejected for grok-4.7. An unknown
  model fails with "Cannot use this model" and exit code 1. The step `effort` is not
  supported for Cursor.
- The final answer is the assistant text after the last `tool_call`; `result.result`
  concatenates every assistant message of the turn.
- `create-chat` prints an id but did not exit with a fresh config directory; it is not
  needed, since `system/init` carries the session id.
- No cost in the stream (token usage only).

## Devin

Verified live against 3000.11.92 (`AIDE_LIVE_DEVIN=1 npx vitest run devin.live`).

- `devin -p --prompt-file <file> --config <file> --respect-workspace-trust false
  --permission-mode auto|dangerous --export <file> [--model M] [--resume <id>]`.
- stdout carries only the final message. `--export` writes the session as ATIF
  (`session_id`, `steps[]` with `source` user / agent / system, `message`,
  `reasoning_content`, `tool_calls`, `observation.results`); for a resumed session it holds
  every turn, so the adapter keeps the steps after the run started. The transcript of a
  Devin visit therefore appears when the run ends, not while it streams.
- Devin imports MCP servers, rules (`~/.claude/CLAUDE.md`) and skills from Claude Code
  and Cursor. `--config <file>` replaces the user config (`%APPDATA%\devin\config.json`)
  for the run; the adapter writes the user's settings with `mcpServers: {}` and
  `read_config_from: { "claude": false, "cursor": false }`, which removes them. A list
  value (`["devin"]`) is ignored with a warning.
- `--permission-mode auto` runs what Devin classifies as read-only (`git diff`, `ls`, file
  reads) and rejects the rest in print mode ("rejected a tool call that requires
  confirmation"). `accept-edits` would also reject running tests, so writes use `dangerous`.
- An unknown model fails with "Unknown model" and exit code 1. No cost in the export.
- `devin rm --force <id>` deletes a session (without `--force` it needs a terminal).

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
AIDE_LIVE_OPENCODE=1 npx vitest run opencode.live  # on the model of the user's OpenCode config; deletes its sessions
AIDE_LIVE_CURSOR=1   npx vitest run cursor.live    # on the user's default Cursor model; chats in a temporary state dir
AIDE_LIVE_DEVIN=1    npx vitest run devin.live     # on the account's default model; deletes its sessions
# Behind a proxy, add AIDE_LIVE_PROXY=http://host:port (the tests call the adapters directly, without AIDE's per-CLI proxy).
```

## Open items

- Cursor, Devin: no structured-output mode; a schema is an instruction only.
- Devin: no live transcript while a step runs (the export is written at the end).
- OpenCode 2: no structured-output mode. The answer goes through AIDE's result tool: the
  pipeline server opens a per-visit MCP endpoint (`POST /step`, header `x-aide-step`) whose
  `submit_result` tool takes the schema as parameters and reports violations back, so the
  agent corrects the answer in the same turn. OpenCode 2 exposes MCP tools through its
  `execute` code tool (`tools.aide_step.submit_result({...})`). Without the server, the
  schema is an instruction and the final message is parsed.
