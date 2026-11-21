---
id: feature-switches
title: Feature switches for pipelines, plans and the tracker
status: done
rank: null
tags: [settings]
docs: [docs/task-tracker-implementation.md#10-feature-switches]
code: [src/main/config/features.ts, src/main/pipeline/featureBusy.ts]
reason: null
blockedFrom: null
label: Feature switches
claim: "Pipelines, plans and the tracker can each be turned off; the effective value is the last layer that sets it: built-in on → global app config → project `aide/config.json` (no UI) → personal `.aide/users/<user>/settings.json`. Off hides the feature's MCP tools, instructions text and UI; nothing on disk is deleted."
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: plan task-tracker-v1
activeBy: []
created: 2026-11-20T16:25:39.341Z
closed: 2026-11-20T16:25:39.341Z
---

## Description

## Journal
- 2026-11-20 created by Allex/tab 2
