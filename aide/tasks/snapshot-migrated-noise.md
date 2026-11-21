---
id: snapshot-migrated-noise
title: Leave migrated tasks out of "closed in the last 7 days"
status: backlog
rank: null
tags: [tracker]
docs: []
code: [src/main/tasks/taskSnapshot.ts]
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
created: 2026-11-20T16:25:47.295Z
closed: null
---

## Description
After migrating AIDE (2026-11-20) the snapshot's section 4 listed all 22 migrated claims as closed today. A task created already done with a `source` was not closed by work; leave it out of that section (and out of the tail).

## Journal
- 2026-11-20 created by Allex/tab 2
