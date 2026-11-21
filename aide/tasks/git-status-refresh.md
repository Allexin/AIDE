---
id: git-status-refresh
title: Background git status
status: done
rank: null
tags: [git]
docs: []
code: [src/main/filetree/gitStatus.ts, src/main/filetree/watcher.ts]
reason: null
blockedFrom: null
label: Background git status
claim: Any file change triggers a git status refresh after a 300 ms debounce; refreshes run serially with one pending slot; git calls have timeouts (15 s status, 5 s branch).
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: CLAUDE.md (Git Integration); agent memory (Stage 4 extra requirement)
activeBy: []
created: 2026-11-20T16:24:51.251Z
closed: 2026-11-20T16:24:51.251Z
---

## Description

## Journal
- 2026-11-20 created by Allex/tab 2
