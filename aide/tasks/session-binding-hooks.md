---
id: session-binding-hooks
title: Deterministic session binding via CLI hooks
status: done
rank: null
tags: [terminal, cli]
docs: [docs/session-binding-and-lifecycle-events-spec.md, docs/session-binding-and-needs-input-refactor.md]
code: [src/main/hooks/hookServer.ts, src/main/pty/cliTools/claudeHooks.ts, src/main/pty/cliTools/devinHooks.ts]
reason: null
blockedFrom: null
label: Session binding via hooks
claim: AIDE wires per-tab SessionStart/Stop hooks for Claude Code and Devin back to its hook server, binding each tab to its CLI session (also after clear, branch and compact) without guessing from files.
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: docs/session-binding-and-lifecycle-events-spec.md; agent memory
activeBy: []
created: 2026-11-20T16:25:39.483Z
closed: 2026-11-20T16:25:39.483Z
---

## Description

## Journal
- 2026-11-20 created by Allex/tab 2
