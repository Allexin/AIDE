---
id: viewer-html-pages
title: Show HTML pages in the viewer with a channel back to the agent
status: done
rank: null
tags: [mcp, editor]
docs: [docs/file-viewer-spec.md, docs/rendered-preview-spec.md]
code: [src/main/viewer/previewProtocol.ts, src/main/viewer/previewFiles.ts, src/main/windows/fileViewer.ts, src/renderer/src/windows/FileViewerApp.tsx]
reason: null
blockedFrom: null
label: HTML pages in the file viewer
claim: |-
  view_show of an .html file runs the page in a sandboxed iframe that loads project files through aide-preview:// (per-project offline/network tokens, containment, byte ranges); the Network button starts from a Privacy setting, links open in the browser.
  The page reloads when a file it loaded changes (not in dot folders); parent.postMessage({ aide: 'send', text }) adds a card to the comments panel.
decidedAgainst: null
reopened: false
history: null
confirmed: null
acknowledged: null
check: null
source: null
activeBy: []
created: 2026-11-20T19:04:37.163Z
closed: 2026-11-20T19:34:24.305Z
---

## Description
Agents often build pages they open in a browser: voice reviews, complex explanations. `view_show` of an `.html` file should run the page in the viewer: sandboxed iframe (`allow-scripts`, opaque origin), project files (CSS, JS, audio, video, images) through an `aide-preview://` protocol with a containment check, network off by default with a header toggle for CDNs, reload on changes in the page's folder, Source view with the line diff. The page sends results to the agent with `parent.postMessage({ aide: 'send', text })`: the text joins the Send panel (a card the user sees before sending). The protocol and the sandbox design are in docs/rendered-preview-spec.md (Loading project files, HTML); the viewer side goes into docs/file-viewer-spec.md.

## Journal
- 2026-11-20 created by Allex/tab 1
- 2026-11-20 Allex/tab 1: started (planned → active)
- 2026-11-20 Allex/tab 1: Built: aide-preview:// with two tokens per project (offline/network — a page cannot turn the network on itself), lexical containment before realpath (a UNC path in the URL would otherwise make AIDE connect to that SMB host), reload only on changes of files the page actually loaded (protocol reports served files), postMessage cards 'from the page'. range refused for HTML. Test page: .aide/viewer-test/page/index.html. Awaiting visual test.
- 2026-11-20 Allex/tab 1: closed done; claim "HTML pages in the file viewer"
