# get-aide.org landing

- `index.html` — the page (no build step). Showcase frames are configured in the `scenarios` array at the bottom.
- `ru/index.html` — the Russian page, generated: `python tools/build.py` applies `i18n/ru.json` (exact English fragment → translation) to `index.html`. Edit the English page and the dictionary, then rebuild; the build fails if a dictionary fragment is no longer in `index.html`, but a new English string must be added to the dictionary by hand. The server sends `/` to `/ru/` when the browser's first language is Russian, unless the visitor picked a language with the EN|RU switcher (`lang` cookie).
- `img/` — published images: icon, download QR, showcase screenshots.
- `deploy.sh`, `publish.sh`, `server/` — deployment scripts. They name the server account, so they are git-ignored and kept locally only.
- `public/` on the server holds demo files; anything copied there is served at `https://get-aide.org/public/<name>`.

## Screenshot list

Desktop frames: Full HD, 16:9, the AIDE window at the same size in every shot — 1920×1080. Save PNG into `shots/` (not published); `python tools/to-webp.py` writes `img/*.webp` (quality 88).
The frame box is 16:9 and letterboxes anything else, so portrait phone shots are fine.

| File | Content |
|---|---|
| `shots/cli-1-claude.png` | Tabs: Claude Code, Codex, Cursor Agent, OpenCode. Claude Code tab active, agent working |
| `shots/cli-2-codex.png` | Same window, Codex tab active, working |
| `shots/cli-3-cursor.png` | Same window, Cursor Agent tab active, working |
| `shots/cli-4-opencode.png` | Same window, OpenCode tab active, working |
| `shots/orch-1-prompt.png` | Orchestrator agent, the game task typed in |
| `shots/orch-2-run.png` | Orchestra / pipeline run view: code, tests, review, graphics, visual review stages |
| `shots/remote-1-desktop.png` | A CLI session working in AIDE |
| `shots/remote-2-phone.png` | The same session on a phone (portrait) |
| `shots/remote-3-browser.png` | The same session in a desktop browser |
| `shots/toolbar-1-prompt.png` | Project open, toolbar empty, toolbar request typed to the agent |
| `shots/toolbar-2-result.png` | Toolbar filled with project buttons, one running, log panel open |

Each frame's caption text lives next to its file name in `scenarios`; edit it there if the shot shows something else.
