---
id: viewer-mermaid-images
title: Render Mermaid and local images in viewer Markdown
status: active
rank: null
tags: [mcp, editor]
docs: [docs/file-viewer-spec.md, docs/rendered-preview-spec.md]
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
activeBy: [Allex]
created: 2026-11-20T19:04:37.240Z
closed: null
---

## Description
Markdown in the viewer shows Mermaid blocks as code and relative images as their alt text. Mermaid: a lazy chunk on the first diagram, `securityLevel: 'strict'`, a broken diagram keeps its source with an error line; a changed diagram shows before (removed) and after (added). Images: through `aide-preview://` (shared with viewer-html-pages). Design notes in docs/rendered-preview-spec.md (Markdown).

## Journal
- 2026-11-20 created by Allex/tab 1
- 2026-11-20 Allex/tab 1: started (planned → active)
