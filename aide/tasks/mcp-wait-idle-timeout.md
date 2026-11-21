---
id: mcp-wait-idle-timeout
title: Keep long pipeline waits under Claude Code's MCP idle timeout
status: planned
rank: 1
tags: [pipeline, mcp]
docs: [docs/plan-mode-spec.md#waiting, docs/aide-mcp-launch.md]
code: []
reason: null
blockedFrom: null
label: null
claim: null
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: null
activeBy: []
created: 2026-11-20T16:24:25.394Z
closed: null
---

## Description
Claude Code aborts an MCP tool call that sends no response or progress for 1800 s ("sent no response or progress for 1800s; aborting", seen 2026-11-20 on `plan_run` with `wait`). AIDE's `pipeline_wait` / `plan_run` / `pipeline_start` with `wait` block up to 3000 s (`MAX_WAIT_SEC`), so long waits fail. Fix: send MCP progress notifications while a wait blocks (preferred: keeps the 50-min wait and the warm cache), or cap the wait below 1800 s; also check whether AIDE's per-server tool timeout (3100 s in the launch spec) still applies alongside the idle timeout.

## Journal
- 2026-11-20 created by Allex/tab 2
