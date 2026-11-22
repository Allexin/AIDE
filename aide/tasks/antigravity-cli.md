---
id: antigravity-cli
title: Integrate Google Antigravity CLI and show unsupported CLIs in Account Manager
status: done
rank: null
tags: [cli]
docs: [docs/multi-cli-architecture.md, docs/new-cli-tool-spec.md, docs/aide-mcp-launch.md, docs/headless-cli-matrix.md, resources/docs/pipeline-authoring.md]
code: [src/main/pty/cliTools/antigravity*.ts, src/main/pipeline/headless/antigravityHeadless.ts, src/renderer/src/windows/AccountManagerApp.tsx]
reason: null
blockedFrom: null
label: Google Antigravity CLI
claim: |-
  Terminal tabs and pipelines run Google Antigravity CLI (`agy`) with SQLite session scanning, transcript history and ToolView mapping, Thinking Panel, per-tab `--settings` title hooks, `.agents/mcp_config.json` AIDE MCP wiring, active `/usage` quota polling, and headless execution.
  Account management and pipeline account pooling are unsupported (`hasAccountSystem() -> false`, OS keyring without CLI credential export/import); its dedicated Account Manager tab shows the current login email (when known) and the unsupported reason without account-management controls.
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: null
activeBy: []
created: 2026-11-22T06:21:53.805Z
closed: 2026-11-22T06:28:28.111Z
---

## Description
Integrate Google Antigravity CLI (`agy`) into AIDE: interactive PTY sessions, SQLite session scanner, transcript history and `ToolView` mapping, Thinking Panel, per-tab `--settings` with `title.command` hook (Windows quote-free `cmd /c` formatting), `.agents/mcp_config.json` AIDE MCP wiring, active quota polling via `agy -p /usage --output-format json`, and headless execution adapter for pipelines and plans.

Account management is not supported (`hasAccountSystem() -> false`) because Antigravity stores OAuth tokens in the OS secure keyring shared with the Antigravity App and IDE without CLI credential export/import. Account Manager includes an "Unsupported CLIs" tab listing CLIs without account management and explaining why.

## Journal
- 2026-11-22 created by Allex/tab 2
- 2026-11-22 Allex/tab 2: started (planned → active)
- 2026-11-22 Allex/tab 2: closed done; claim "Google Antigravity CLI"
- 2026-11-22 Allex/tab 2: reopened: Update Account Manager UX to show a dedicated per-CLI tab for unsupported CLIs instead of a grouped Unsupported CLIs tab
- 2026-11-22 Allex/tab 2: closed done; claim "Google Antigravity CLI"
