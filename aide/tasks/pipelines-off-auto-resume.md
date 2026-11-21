---
id: pipelines-off-auto-resume
title: Do not auto-resume runs while pipelines are turned off
status: backlog
rank: null
tags: [pipeline, settings]
docs: [docs/task-tracker-implementation.md#10-feature-switches]
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
created: 2026-11-20T16:24:35.619Z
closed: null
---

## Description
From the review of the feature switches (e255f19): a run stopped at a usage limit with `limitResumeAt` resumes itself when that time comes (runner.ts), and nothing checks the pipelines switch. Also the window between an Orchestrator decision and the next run's registration lets pipelines be turned off mid-autopilot.

## Journal
- 2026-11-20 created by Allex/tab 2
