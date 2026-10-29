<p align="center">
  <img src="site/img/icon.png" width="96" alt="AIDE">
</p>

<h1 align="center">AIDE — AI-Driven Code Editor</h1>

<p align="center">A desktop editor built as a native shell for AI coding agents.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/open_source-MIT-3fb950" alt="Open source, MIT license"></a>
  <img src="https://img.shields.io/badge/100%25_free-no_paid_plans,_no_trial-3fb950" alt="100% free: no paid plans, no trial">
  <img src="https://img.shields.io/badge/platform-Windows-4fa3ff" alt="Platform: Windows">
  <a href="https://github.com/Allexin/AIDE/releases/latest"><img src="https://img.shields.io/github/v/release/Allexin/AIDE?label=release&color=7c5cff" alt="Latest release"></a>
</p>

<p align="center">
  <a href="https://github.com/Allexin/AIDE/releases/latest"><b>⬇ Download for Windows</b></a>
  &nbsp;·&nbsp;
  <a href="https://get-aide.org"><b>get-aide.org</b></a>
</p>

<p align="center">
  <img src="site/img/readme-agents.webp" alt="AIDE with an orchestrator, two Claude Code sessions, Codex, OpenCode and Cursor in tabs of one window">
</p>

## One sentence in. A working setup out.

Tell the agent what you want. AIDE gives it the tools to wire up your workspace.

### “I want all my agents in one window”

Claude Code, Codex, Cursor Agent, OpenCode and more run as real terminal sessions in tabs, next to the editor, the file tree and git. Several sessions of the same CLI, each with its own title, resumed on startup.

<details>
<summary>Four agents at work on one Unreal Engine project</summary>

| | |
|---|---|
| <img src="site/img/cli-1-claude.webp" alt="Claude Code tab"><br>Claude Code adds a sprint to the character… | <img src="site/img/cli-2-codex.webp" alt="Codex tab"><br>…Codex writes an automation test… |
| <img src="site/img/cli-3-cursor.webp" alt="Cursor Agent tab"><br>…Cursor Agent reviews for frame-rate bugs… | <img src="site/img/cli-4-opencode.webp" alt="OpenCode tab"><br>…and OpenCode documents the classes. |

</details>

### “I want a toolbar”

| You say | You get |
|---|---|
| <img src="site/img/toolbar-1-prompt.webp" alt="The toolbar request typed into the toolbar AI helper"> | <img src="site/img/toolbar-2-result.webp" alt="Toolbar filled with Unreal Engine buttons, a build streaming into the log"> |
| *I want a toolbar for working with this Unreal Engine project* | Build, clean, run, test, package: one click each, output in the log. |

### “I want to control it from my phone”

Remote Connect: scan the QR code or open the link, and the same session continues in a phone or any browser.

| In AIDE | In a browser | On a phone |
|---|---|---|
| <img src="site/img/remote-1-desktop.webp" alt="An agent session in AIDE with the Remote Connect QR code"> | <img src="site/img/remote-3-browser.webp" alt="The same session in a desktop browser, with the project files"> | <img src="site/img/remote-2-phone.webp" width="160" alt="The same session on a phone"> |
| Scan the QR or open the link. | The same session, plus the project files. | The same session, with keys to drive it. |

### “I want an orchestra”

| You say | You get |
|---|---|
| <img src="site/img/orch-1-prompt.webp" alt="The task given to the orchestrator agent"> | <img src="site/img/orch-2-run.webp" alt="Pipeline run view with the feature stages"> |
| *I want to make a game out of this project. First feature: a dash, with a trail texture and a HUD icon.* | OpenCode codes, Claude reviews, Codex draws: code → tests → review → art → visual review → commit. |

## Getting started

1. [Download the latest release](https://github.com/Allexin/AIDE/releases/latest): a portable build, nothing to install.
2. Unpack it anywhere and run `AIDE.exe`.
3. Open a project folder. AIDE starts an agent session in it.

The agent CLIs themselves (Claude Code, Codex, …) need to be installed and signed in; AIDE finds them on `PATH`.

## Supported agents

`Claude Code` · `Codex` · `Cursor Agent` · `Devin` · `OpenCode` · `Qwen Code` · `Terminal` · **+ any other**

Missing yours? Ask your agent to add itself to AIDE: there is a [step-by-step guide](docs/new-cli-tool-spec.md), and any top model handles it.

## Features

<details>
<summary><b>Agent CLIs</b>: tabs, sessions, accounts, history</summary>

- **Session tabs**: real terminals (xterm.js + node-pty); sessions resume on startup, titles persist, the session picker opens any past session
- **Session binding**: every tab is bound to its CLI session deterministically
- **Accounts**: several per CLI, hot switching, usage and limits display; proxy settings applied to every CLI
- **Thinking panel**: the agent's extended reasoning, live
- **History viewer**: any past session rendered as Markdown
- **Smart compact** for direct CLI sessions

</details>

<details>
<summary><b>Pipelines and orchestration</b>: deterministic multi-agent flows</summary>

- **Pipeline machines**: per-task-type flows in `aide/pipelines/*.json`, a tree of steps (agents, checks, gates, loops, groups, `if`, commit) that AIDE executes deterministically. Each agent runs headless with its role, sees the whole pipeline with "you are here", and gets loop feedback automatically
- **Orchestrator over MCP**: any agent CLI with MCP support connects to AIDE, set up automatically with nothing to configure, and decides what to run: picks tasks, starts machines, answers escalations, reads reports
- **Run view**: the step tree, live transcripts, check logs, pause / stop / resume, escalation answers and the final report
- **Robust runs**: run state is saved after every step and survives an AIDE restart

</details>

<details>
<summary><b>Editor and project</b>: Monaco, diff, git, toolbar</summary>

- **Monaco Editor**: auto-save on focus loss, external-change conflict dialog, large file confirmation
- **Diff view**: HEAD vs disk, to review what the agent changed
- **File tree**: live git status, "modified only" filter, fast filtering
- **Git**: branch and file status in the status bar, commit dialog with streamed progress
- **Toolbar as code**: project and personal buttons in `toolbar.json`; the agent writes them, you click them, output lands in log channels
- **Shared projects**: per-user state under `.aide/users/<user>/`, so several people can work in one project folder (e.g. over SMB)

</details>

<details>
<summary><b>More</b>: remote access, updates, diagnostics</summary>

- **Remote access**: continue a session from a phone, tablet or any browser via a QR code ([`docs/remote-access.md`](docs/remote-access.md))
- **Updates**: in-app update check against GitHub releases
- **Crash diagnostics**: an event trail that survives a crash ([`docs/crash-diagnostics.md`](docs/crash-diagnostics.md))
- **Unreal Engine** project discovery

</details>

## Command line

```
aide [<projectPath>] [options]
aide --project <projectPath> [options]

  --no-restore         Exclude saved AIDE tabs from startup suggestions
  --cli <toolId>       Use this CLI for the initial tab during this launch only
  --no-global-state    Do not touch recent projects or saved open sessions
  --help, -h           Show help
```

Without a path AIDE opens the project picker; started inside a folder with `.aide/` it opens that project directly.

## Development

Building from source, tests, packaging and the code layout: [`docs/development.md`](docs/development.md). Linux builds are implemented and awaiting on-device testing.

## License

[MIT](LICENSE)
