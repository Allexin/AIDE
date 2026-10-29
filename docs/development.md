# Development

How to build, test and package AIDE from source, and where things live in the code.

## Prerequisites

- **Node.js** 18+ and **npm** 9+
- **C++ build tools** for the native modules (`node-pty`, `better-sqlite3`): on Windows the "Desktop development with C++" workload from the Visual Studio Installer; on Linux `build-essential` and `python3`
- The agent CLIs you want to use, installed and on `PATH`

## Building from source

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

## Platforms

- **Windows** x64: primary platform, portable 7z build
- **Linux** x64: implemented (AppImage and deb targets), on-device testing still pending; see [`BUILDING-linux.md`](../BUILDING-linux.md) and [`linux-migration.md`](linux-migration.md)

## Tech stack

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

## Project structure

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
site/                  # get-aide.org landing page
```

## Further reading

- Adding a CLI: [`new-cli-tool-spec.md`](new-cli-tool-spec.md)
- Pipelines: [`pipeline-orchestration-plan.md`](pipeline-orchestration-plan.md), [`../resources/docs/orchestration-mcp.md`](../resources/docs/orchestration-mcp.md) (for orchestrator agents), [`../resources/docs/pipeline-authoring.md`](../resources/docs/pipeline-authoring.md) (for agents that write machines)
- Remote access: [`remote-access.md`](remote-access.md)
- Crash diagnostics: [`crash-diagnostics.md`](crash-diagnostics.md)
