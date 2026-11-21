---
id: viewer-image-marks
title: Let users mark up images in the file viewer
status: done
rank: null
tags: [mcp, editor]
docs: [docs/file-viewer-spec.md#marks-on-images]
code: [src/shared/viewer/marks.ts, src/renderer/src/components/viewer/MarkView.tsx]
reason: null
blockedFrom: null
label: Image marks
claim: "`view_show({ marks: true | [...] })` lets the user mark an image up in the viewer (text, arrow, line, rectangle, ellipse; zoom, pan, snap). Send returns the marks in image pixels (viewBox units for SVG) with notes and JSON, plus a PNG with the marks for raster images; a new show drops all marks."
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: null
activeBy: []
created: 2026-11-20T18:59:19.497Z
closed: 2026-11-20T18:59:23.006Z
---

## Description
view_show marks mode: text, arrow, line, rectangle, ellipse marks; sent back as coordinates, notes, JSON and a PNG for raster images. Spec: docs/file-viewer-spec.md, "Marks on images". Commit 008a06e.

## Journal
- 2026-11-20 created by Allex/tab 1
- 2026-11-20 Allex/tab 1: closed done; claim "Image marks"
