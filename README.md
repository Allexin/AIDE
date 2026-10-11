# AIDE — AI-Driven Code Editor

A desktop code editor built as a native shell for AI coding agents. AIDE runs
agent CLIs (Claude Code, Codex, Cursor Agent, Devin, OpenCode, Qwen Code) in
terminal tabs next to a Monaco editor, a git-aware file tree and a diff view,
keeps their sessions and accounts in order, and can run deterministic
multi-agent **pipelines** driven by an orchestrator agent.

## Features

### Editor and project
- **Monaco Editor** — syntax highlighting, auto-save on focus loss, external-change conflict dialog, large file confirmation
- **Diff view** — HEAD vs disk, for reviewing agent changes
- **File tree** — lazy-loaded, live git status (`●` changed, `?` untracked), "modified only" filter, indexed filtering
- **Git** — branch and file status in the status bar, commit dialog with streamed progress, auto-refresh on file changes
- **Toolbar** — project and personal buttons (`aide/toolbar.json`, `.aide/users/<user>/toolbar.json`) that run commands into log channels
- **Log panel** — channel-based, virtualized, with attention blinking
- **Per-user project state** under `.aide/users/<user>/`, so several people can share a project folder (e.g. over SMB)

### Agent CLIs
- **Multiple CLIs** — Claude Code, Codex, Cursor Agent CLI, Devin, OpenCode, Qwen Code, and a plain terminal; managed in *CLI → Manage CLI Tools*
- **Session tabs** — xterm.js + node-pty; sessions resume on startup, titles persist, the session picker opens any past session
- **Session binding** — tabs are bound to their CLI sessions deterministically (Claude Code and Devin via hooks)
- **History viewer** — past session transcripts rendered as Markdown in a virtualized view
- **Thinking panel** — Claude Code's extended-reasoning blocks of the active tab
- **Multiple accounts** per CLI with hot-restart of the affected tabs; usage display; proxy settings applied to every CLI
- **Smart compact** for direct CLI sessions

### Pipelines and orchestration
- **Pipeline machines** — per-task-type flows in `aide/pipelines/*.json`: a tree of steps (agents, checks, gates, loops, groups, `if`, commit) that AIDE executes deterministically. Each agent runs headless with its role, sees the whole pipeline with "you are here", and gets loop feedback automatically
- **Orchestrator over MCP** — any agent CLI with MCP support connects to AIDE's pipeline server through a stdio shim and decides what to run: picks tasks, starts machines, answers escalations, reads reports. Set up from the main menu → *Orchestration*
- **Run view** — a tab in the terminal panel with the step tree, live transcripts, check logs, controls (pause, stop, resume), escalation answers and the final report; a banner warns while a run executes
- **Robust runs** — run state is persisted after every step and survives an AIDE restart; agents are killed by their own PIDs on stop and on quit
- Headless pipeline steps currently support **Claude Code** and **Codex**

See [`docs/pipeline-orchestration-plan.md`](docs/pipeline-orchestration-plan.md), [`resources/docs/orchestration-mcp.md`](resources/docs/orchestration-mcp.md) (for orchestrator agents) and [`resources/docs/pipeline-authoring.md`](resources/docs/pipeline-authoring.md) (for agents that write machines).

### More
- **Remote access** — continue terminal sessions from a phone or tablet in the browser (QR code connect, see [`docs/remote-access.md`](docs/remote-access.md))
- **Updates** — in-app update check against GitHub releases
- **Crash diagnostics** — an append-only event trail that survives a crash (`npm run diagnose`, see [`docs/crash-diagnostics.md`](docs/crash-diagnostics.md))
- **Unreal Engine** discovery for game projects

## Platforms

- **Windows** x64 — primary platform, portable 7z build
- **Linux** x64 — implemented (AppImage and deb targets), on-device testing still pending; see [`BUILDING-linux.md`](BUILDING-linux.md) and [`docs/linux-migration.md`](docs/linux-migration.md)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Shell | Electron 33 |
| UI | React 18, Zustand 5 |
| Editor | Monaco Editor |
| Terminal | xterm.js 6, node-pty |
| Storage | better-sqlite3 |
| Build | electron-vite, Vite 5, electron-builder |
| Tests | Vitest |
| Language | TypeScript |

## Prerequisites

- **Node.js** 18+ and **npm** 9+
- **C++ build tools** for the native modules (`node-pty`, `better-sqlite3`): on Windows the "Desktop development with C++" workload from the Visual Studio Installer; on Linux `build-essential` and `python3`
- The agent CLIs you want to use, installed and on `PATH`

## Building from Source

```bash
git clone https://github.com/Allexin/AIDE.git
cd AIDE

npm install
npm run rebuild      # rebuild native modules for Electron

npm run typecheck
npm test             # unit tests (Vitest)
npm run dev          # development mode with hot reload
npm run build        # production build into out/ (bumps the patch version)
```

Packaging:

```bash
npm run pack         # Windows: release/AIDE-<version>-portable.7z
npm run pack:linux   # Linux: AppImage and deb in release/
```

Live tests that call real agent CLIs (and spend a little on their accounts) are
opt-in: `AIDE_LIVE_CLAUDE=1`, `AIDE_LIVE_CODEX=1`, `AIDE_LIVE_PIPELINE=1`,
`AIDE_LIVE_ORCHESTRATOR=1` before `npx vitest run <name>.live`.

## Usage

```
aide [<projectPath>] [options]
aide --project <projectPath> [options]

  --no-restore         Exclude saved AIDE tabs from startup suggestions
  --cli <toolId>       Use this CLI for the initial tab during this launch only
  --no-global-state    Do not touch recent projects or saved open sessions
  --help, -h           Show help
```

Without a path AIDE opens the project picker; started inside a folder with
`.aide/` it opens that project directly.

## Project Structure

```
src/
├── main/              # Electron main process
│   ├── ipc/           # IPC handlers
│   ├── pty/           # terminal tabs, CLI tool integrations (cliTools/)
│   ├── pipeline/      # pipeline engine, headless agents, MCP server, orchestration
│   ├── remote/        # remote access server
│   ├── filetree/      # FS watcher, git status
│   ├── config/        # app, project and toolbar config
│   ├── platform/      # Windows/Linux abstraction
│   └── …              # windows, menu, updater, diagnostics, hooks, thinking, unreal
├── preload/           # context bridge scripts per window
├── renderer/src/      # React UI: components, Zustand stores, windows
└── shared/            # types shared by main and renderer
resources/
├── mcp/aide-mcp.cjs   # stdio shim agents use to reach AIDE's pipeline server
└── docs/              # docs deployed for agents (orchestration, pipeline authoring)
docs/                  # design documents and specs
```

## License

[MIT](LICENSE)
