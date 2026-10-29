# AIDE's MCP server in CLI tabs

AIDE gives its MCP server (`aide`) to every CLI tab it launches. Nothing is
registered in a CLI's own config: the server is added to each launch with the
paths of the running AIDE, so a moved or updated AIDE, a dev build next to a
stable one, or a renamed project folder never leaves a stale entry behind. The
server carries pipeline orchestration today and is meant to carry other AIDE
tools later; nothing in the mechanism is specific to orchestration.

This replaced the Orchestration setup wizard, which asked an agent to register
the server in its own config.

## How it works

- **Spec.** When AIDE's server is up, `startPipelineServer` registers a
  provider with the PTY manager (`setLaunchMcpProvider`). Before every spawn
  `PtyManager.prepareLaunch` asks it for the tab's servers
  (`aideMcpServers`, `src/main/aideMcp/launch.ts`): AIDE's executable running
  the shim (`resources/mcp/aide-mcp.cjs mcp`) with `ELECTRON_RUN_AS_NODE` and
  `AIDE_RUNTIME_DIR` in `env`, the tab and project in `tabEnv`
  (`AIDE_TAB_ID`, `AIDE_PROJECT`), and a tool timeout of 1900 s (waiting for a
  run blocks a call for up to 30 minutes).
- **Module.** `CliTool.prepareLaunch(ctx)` (it replaced `hookLaunchArgs`)
  returns what to add to the launch, `{ args?, env? }`, for the hook wiring
  (`ctx.hook`) and for the servers (`ctx.mcpServers`). The module knows only how
  its CLI takes an MCP server; it does not know what the server is.
  `CliTool.aideMcp` declares whether the CLI supports it, with an optional note
  for the setting.
- **Setting.** A per-CLI checkbox, *Give AIDE's MCP server to this CLI*, on by
  default (`aideMcpServer` in the tool config), added to every CLI that
  declares `aideMcp` (`aideMcpField`). Unsupported CLIs show it disabled with
  the reason. Turning it off gives the CLI no server at its next launch.
- **The server says when to use it**: its `instructions` (`serverInstructions`)
  and the `pipeline_hello` description tell the agent to turn to orchestration
  when the user asks for it or a task needs several agent steps with checks and
  review. Not every client shows server instructions; every client shows tool
  descriptions.

A tab started before AIDE's server came up has no server; AIDE starts the
server before it opens any project.

## Per CLI

Verified live on 2026-10-29 with a probe server that reports its environment.

| CLI | How the server is added | Verified |
|---|---|---|
| Claude Code | per-tab JSON file, `--mcp-config "<file>"` | print and interactive: loaded without an approval prompt, `AIDE_TAB_ID` arrives |
| Codex | `-c mcp_servers.aide.command=…`, `.args`, `.env`, `.tool_timeout_sec` | `codex exec` through Windows PowerShell (`-EncodedCommand`, as AIDE launches), paths with spaces; overrides a same-named `[mcp_servers.aide]` of the user's config |
| OpenCode | `OPENCODE_CONFIG_CONTENT` in the tab's environment (merged over an existing value) | `opencode run --standalone` |
| Cursor Agent | a per-tab plugin directory (`.cursor-plugin/plugin.json` with `mcpServers`), `--plugin-dir "<dir>"` | print and interactive: loaded without an approval prompt, nothing stored in `~/.cursor` |
| Devin | the project's `.devin/mcp_config.local.json` | print and interactive: loaded without an approval prompt; `AIDE_TAB_ID` arrives from Devin's own environment |
| Qwen Code | not supported (legacy) | — |

Notes:

- **Claude Code**: `--mcp-config` takes several values, so it must stay the
  last argument of the command line (prompts are typed into the tab, never
  appended).
- **Codex**: values are TOML literal strings, so paths need no escaping; a
  value with a single quote cannot be passed and the server is left out (logged).
  The arguments contain no double quotes, which Windows PowerShell 5.1 would
  mangle on the way to the program.
- **Cursor**: Cursor reads MCP servers only from `mcp.json` files, but a local
  plugin can carry them, and `--plugin-dir` loads one for a single launch.
- **Devin**: Devin takes MCP servers only from files (`~/.claude.json`,
  `~/.cursor/mcp.json`, its user, project and local configs). `--config`
  ignores `mcpServers`; `DEVIN_CONFIG_HOME` does load a per-tab
  `mcp_config.json`, but Devin then behaves as a fresh install (onboarding) and
  moves its sessions and state. So AIDE keeps its entry in Devin's local, not
  committed project config before each Devin launch, keeping the user's other
  servers there, and removes it when the setting is off. The file is shared by
  the project's Devin tabs, so it carries no `tabEnv`; Devin passes its own
  environment, with the tab's `AIDE_TAB_ID`, to MCP servers. In a git repository
  rooted at the project, AIDE adds the file to `.git/info/exclude`. The setting
  says so.

## Existing entries

Entries named `aide` that an agent registered earlier (through the old wizard)
are left alone. Codex's `-c` overrides a same-named entry for AIDE's launches.
Claude Code used the `--mcp-config` server over a same-named entry in the
project's `.mcp.json` (an unapproved one, so this may only show that unapproved
project servers do not load); a same-named user-scope entry was not tested. If
one wins over `--mcp-config`, AIDE's server needs another name.
