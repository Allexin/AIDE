---
id: file-viewer
title: Add a file viewer window that agents use to show files with changes and collect comments
status: done
rank: null
tags: [editor, mcp]
docs: [docs/file-viewer-spec.md, docs/rendered-preview-spec.md]
code: [src/main/viewer/**, src/main/windows/fileViewer.ts, src/main/pipeline/mcp/viewTools.ts, src/preload/fileViewer.ts, src/shared/viewer/**, src/renderer/src/components/viewer/**, src/renderer/src/windows/FileViewerApp.tsx]
reason: null
blockedFrom: null
label: File viewer
claim: "`view_show` (MCP) shows a project file, or a range of it by line numbers or marker lines, in a window owned by the AIDE window, with the changes since the previous show marked (rendered Markdown block+word diff, line diff, image Before/After), live updates, Seen and Removed. The user's comments and free text are sent from its panel to the calling tab as one message with quotes and file lines."
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: null
activeBy: []
created: 2026-11-20T16:51:00.284Z
closed: 2026-11-20T18:08:45.137Z
---

## Description
The agent calls `view_show` after a set of edits; a window owned by the AIDE window shows the file (rendered Markdown, image, source) with the changes since the previous show marked, live updates (Live checkbox), and a comments panel on the right whose Send submits all comments plus free text to the agent's tab. Spec: docs/file-viewer-spec.md. Shares the Markdown renderer and `aide-preview://` with rendered-preview.

## Journal
- 2026-11-20 created by Allex/tab 3
- 2026-11-20 Allex/tab 3: started (backlog → active)
- 2026-11-20 Allex/tab 3: Implemented (uncommitted, awaiting visual test): view_show with range markers, owned window, Live, block+word diff, comments panel + Send via ptyManager.submitText. Markdown images and Mermaid wait for rendered-preview.
- 2026-11-20 Allex/tab 2: closed done; claim "File viewer"
