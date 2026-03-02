# AIDE — AI-Driven Code Editor

A lightweight desktop code editor built with Electron, React, and Monaco Editor. Designed as a native shell for AI-assisted coding workflows (e.g. Claude Code), with an integrated terminal, file tree, and diff view.

## Features

- **Monaco Editor** — syntax highlighting, IntelliSense, auto-save, large file handling
- **Integrated Terminal** — multiple sessions via xterm.js + node-pty, tab management
- **File Tree** — lazy-loaded directory tree with live git status indicators
- **Diff View** — side-by-side diff for reviewing AI-generated changes
- **Git Integration** — branch display, file status tracking, auto-refresh on file changes
- **Resizable Panels** — flexible layout with draggable splitters
- **Multi-Account Support** — switch between API accounts with hot-restart for CLI tabs

## Tech Stack

| Layer | Technology |
|-------|------------|
| Shell | Electron 33 |
| UI | React 18, Zustand 5 |
| Editor | Monaco Editor |
| Terminal | xterm.js 6, node-pty |
| Build | electron-vite, Vite 5 |
| Language | TypeScript |

## Prerequisites

- **Node.js** 18+
- **npm** 9+
- **Windows** — currently the only supported platform
- **C++ Build Tools** — required for native module `node-pty` compilation. Install via:
  ```
  npm install -g windows-build-tools
  ```
  or install "Desktop development with C++" workload from Visual Studio Installer.

## Building from Source

```bash
# Clone the repository
git clone https://gitverse.ru/basovav/AIDE.git
cd aide

# Install dependencies
npm install

# Rebuild native modules for Electron
npm run rebuild

# Type-check
npm run typecheck

# Development mode (hot-reload)
npm run dev

# Production build
npm run build
```

The production build output will be in the `out/` directory. To package an installer, use [electron-builder](https://www.electron.build/):

```bash
npx electron-builder --win
```

This produces an NSIS installer for Windows x64 in the `dist/` directory.

## Project Structure

```
src/
├── main/           # Electron main process (IPC, file watcher, git, menus)
├── preload/        # Context bridge scripts
└── renderer/src/   # React UI
    ├── components/ # Layout, file tree, git, editor panels
    └── store/      # Zustand stores (editor, file tree, panels, terminal)
```

## License

[MIT](LICENSE)
