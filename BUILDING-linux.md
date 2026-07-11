# Building & running AIDE on Linux

The Linux port (Stages 1–3) supports both **running from source** via
`npm run dev` and building a **packaged AppImage / deb** via `npm run pack:linux`.

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

## Packaging (AppImage + deb)

```bash
npm run build          # electron-vite production build
npm run pack:linux     # electron-builder --linux --publish=never
```

Artifacts land in `release/` as `AIDE-<version>-x64.AppImage` and
`AIDE-<version>-x64.deb` (see `electron-builder.yml` → `linux`). The native
modules are unpacked from the asar (`asarUnpack`) so their `.node` binaries load
at runtime.

**Icon:** packaging uses `app_icon.png`. electron-builder expects at least a
512×512 source for crisp Linux desktop icons; the current icon is 388×388 and
will be upscaled with some quality loss. Replace `app_icon.png` with a ≥512²
export when convenient.

## Cross-platform validation

The repo is hosted on gitverse.ru (not GitHub), so there is no GitHub Actions
matrix. To validate a change on both targets before release, run on each OS:

```bash
npm ci
npm run rebuild
npm run typecheck
npm run build
npm run pack        # Windows
npm run pack:linux  # Linux
```

If a gitverse.ru CI pipeline is set up later, mirror these steps in a
`windows` + `ubuntu` matrix.

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

## Platform behavior notes
- Toolbar "Open in file manager" uses `xdg-open .` on Linux (`open .` on macOS,
  `explorer.exe .` on Windows).
- Unreal/Unity integration is Windows-only: their preset groups are hidden and
  project auto-detection is skipped off Windows (registry-based engine discovery
  has no Linux equivalent).
- The updater is notify-only — it parses the releases page for newer versions and
  points you there; the release page hosts both the Windows `.7z` and the Linux
  AppImage/deb. There is no in-app auto-download on any platform.
