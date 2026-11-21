---
id: file-index-incremental
title: Update the file index incrementally
status: planned
rank: 6
tags: [filetree]
docs: [docs/file-index-incremental-plan.md]
code: [src/main/filetree/fileIndex.ts]
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
source: CLAUDE.md (Planned rework), docs/file-index-incremental-plan.md
activeBy: []
created: 2026-11-20T16:24:35.493Z
closed: null
---

## Description
The file index is rebuilt in full on every FS change. Replace it with incremental updates as specified; claim drift (tracker-drift) also needs the changed paths this produces.

## Journal
- 2026-11-20 created by Allex/tab 2
