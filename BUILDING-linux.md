# Building & running AIDE on Linux (from source)

Stage 1 of the Linux port targets **running from source** via `npm run dev`
(`electron-vite dev`). No packaged artifact yet — that is Stage 2.

Tested target: x64, glibc-based distros (Ubuntu 22.04+ / Debian 12+ / Fedora).
Wayland and X11 both work.

## System prerequisites

AIDE ships two native modules — `node-pty` and `better-sqlite3` — that must be
compiled against Electron's ABI. You need a working C/C++ toolchain and Python:

### Debian / Ubuntu
```bash
sudo apt install build-essential python3 git
```

### Fedora
```bash
sudo dnf install @development-tools python3 git
```

Electron itself pulls in a few shared libraries at runtime (X11, nss, etc.).
On a minimal/server install add:
```bash
# Debian/Ubuntu
sudo apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 \
     libgbm1 libasound2 libx11-xcb1
```

A login shell is required for the integrated terminal. AIDE spawns
`$SHELL -l` (falling back to `/bin/bash -l`), so make sure `$SHELL` points at a
real interactive shell.

## Build steps

```bash
npm install
npm run rebuild        # electron-rebuild -f -w node-pty,better-sqlite3
npm run dev            # launches the app
```

`npm run rebuild` is **required even for `dev`** — the prebuilt binaries that
`npm install` fetches target Node, not Electron, and will fail to load with an
ABI-mismatch error otherwise. Re-run it after any Electron version bump.

## CLI tools

Session binding and install detection are cross-platform in Stage 1, but AIDE
only *detects* a tool if its binary is on `PATH`. Confirm with e.g.:
```bash
command -v claude
```
For Claude Code, both install detection and automatic tab↔session binding work
on Linux. The other CLI tools (Codex, Cursor Agent, OpenCode, Qwen) are
install-detected and can be launched, but their automatic session binding lands
in Stage 2.

## Known Stage 1 limitations
- No packaged AppImage/deb yet (Stage 2).
- Toolbar defaults still contain Windows commands (`explorer.exe`, etc.) — they
  simply no-op/fail on Linux until Stage 3.
- Unreal/Unity integration is Windows-only and unavailable on Linux (Stage 3).
- Updater advertises Windows artifacts; update via git pull for now (Stage 3).
