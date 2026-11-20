# File Viewer

Feature: an agent shows the user a project file (a Markdown document, an image, source
text) in a window that floats above its AIDE window, with the changes since the last show
marked. The user collects comments on fragments in a side panel and sends them back to the
agent in one message.

Status: implemented except Markdown images and Mermaid (see Dependency on the rendered preview).

Related: `docs/rendered-preview-spec.md` (Render view inside the editor). The viewer reuses
its document Markdown renderer and its `aide-preview://` protocol. That spec lists
"rendered diff" as a non-goal for the editor; this spec adds a rendered diff to the viewer only.

## Background

Agent and user often edit a shared text together: a spec, a plan, a letter. Today the agent
writes the file and says "look at docs/x.md". The user then finds the file in the tree,
opens it in the single-file editor (which replaces what was open there), and searches for
what changed. To point at a place, the user describes it in words in the terminal.

## Goal

- The agent calls one MCP tool, `view_show`. The viewer window opens (or comes forward)
  with the file rendered and the agent's changes since the previous show marked.
- The user reads, selects fragments, writes comments into a panel on the right, adds free
  text, and presses **Send**. The comments arrive in the agent's terminal tab as one
  submitted message.

### Non-goals

- Editing in the viewer. It is read-only; **Open in editor** opens the file in the editor.
- Comments stored in the document or in files. Comments live in the viewer until they are
  sent or deleted.
- Image diff beyond a before/after toggle.
- Editing images. Marks on images (see Marks on images) are an annotation layer that goes
  back to the agent; the image file is never changed by the viewer.
- Handling an agent that edits the file while it waits for the user's answer. Agents do not
  do this; if one starts, the system prompt will forbid it. No logic for this case.

---

## Window

- One viewer window per AIDE editor window, so one per open project. Two AIDE instances
  on different folders have two viewers.
- Created with `parent: <editor BrowserWindow>`, not modal. On Windows that makes it an
  owned window: always above its own AIDE window, not above other applications, minimized
  and closed together with it. There is no system-wide always-on-top.
- Created on the first `view_show`, hidden (not destroyed) when the user closes it, so the
  next show is instant and pending comments survive. Destroyed with the editor window.
- Bounds are persisted per user in `.aide/users/<user>/settings.json` as
  `viewerBounds?: { x, y, width, height }`. Default: right half of the editor window's
  display area, 900×800 or smaller.
- `view_show` never takes focus (`showInactive()`): the user may be typing anywhere. When
  no AIDE window is in the foreground, the editor's taskbar entry flashes.

### Layout

```
+-----------------------------------------------------------+------------------+
| docs/x.md   [Live ✓]  ‹ 2 of 5 ›   Rendered|Source   Open | Comments (3)     |
+-----------------------------------------------------------+ +--------------+ |
|                                                           | | > quote…     | |
|   rendered document, changes marked                       | | L12–14       | |
|                                                           | | text…    [x] | |
|                                                           | +--------------+ |
|                                                           | ...              |
|                                                           | +--------------+ |
|                                                           | | free text    | |
|                                                           | +--------------+ |
|                                                           | [Send (3)]       |
+-----------------------------------------------------------+------------------+
```

- Header: file path, **Live** checkbox, change navigation (`‹ n of m ›`, also `F7` /
  `Shift+F7`), **Rendered / Source** toggle (Markdown only), **Open in editor**.
- Right: the comments panel, ~320 px wide. It can be collapsed to a narrow strip that shows
  the count.

---

## Snapshots: what the diff is against

The agent controls the base. It edits the file as many times as it wants, then calls
`view_show`; that call is the boundary between one set of changes and the next.

State in main, per project, per project-relative path:

```ts
interface ShownState {
  base: string | null      // content at the previous show (null: never shown)
  shown: string            // content at the latest show = the next base
  shownAt: number
}
```

`view_show(path)`:

1. Read the file from disk: `current`.
2. `base` = the `shown` of the previous show of this path (or `null`).
3. Store `{ base, shown: current }`.
4. The window displays **diff(base → current)**. With `base = null` it displays the
   document without marks.

Live updates, while **Live** is checked: the FS watcher reports a change to the displayed
path; the window re-reads it as `live`.

- `live == shown`: the window keeps showing diff(base → shown), the presented diff.
- `live != shown`: the window shows **diff(shown → live)**, the changes made since the
  show, and the header says `Live: changes since shown`. This is what the user sees while
  the agent works on the comments: exactly the agent's new changes, appearing as it writes.
  The next `view_show` makes them the presented diff.

**Live unchecked** freezes the window: watcher events do not change what is displayed
(useful to copy text while the agent works). The header shows `File changed` when the disk
differs from the display. Checking Live again applies the current state. An explicit
`view_show` always updates the window, whatever the Live checkbox says, and leaves the
checkbox as the user set it.

The diff is by content, not by author: changes the user makes in the editor are included.

**Seen** (header button) clears the marks: what is on screen becomes the local base, and
live changes from then on are marked against it. It is local to the window; the base of the
next `view_show` is still the previous show, since the agent controls it. A new show drops
the Seen state.

**Removed** (header checkbox, on by default): unchecked, removed blocks, lines and words are
hidden and only the current text with its additions is shown. Removed words inside a line
are never part of a selection (`user-select: none`), so quotes and copies carry the text as
it is now; whole removed blocks stay selectable, so they can be commented on.

### Range

A show can be limited to a part of a large file, for example the chapter being worked on.
`range: { from, to }`; each bound is a 1-based line number or a marker, the text of a line
(a heading, or a marker comment the agent puts in, such as `<!-- view:end -->`):

- `from`: a number is the first line shown; text is the first line containing it, shown.
- `to`: a number is the last line shown; text is the first line after `from` containing it,
  not shown (it is where what follows begins). Absent: to the end of the file.

Markers are looked up again on every read (the show, every live update), so the range
follows edits made above it; line numbers do not. The same range is cut from the base, so
the diff compares the part with the same part. A base where the markers are missing is
dropped (shown without marks, and the tool result says so); a current file without them is
an error of `view_show`, and a live update without them shows a problem in the header and
keeps the last display. Comment line numbers are always lines of the whole file.

Implementation: `src/shared/viewer/range.ts`.

Snapshots live in memory in main. They are lost when AIDE restarts; the first show after a
restart has no base. Optional `base` argument values: see the MCP tool.

---

## MCP tool `view_show`

In `src/main/pipeline/mcp/viewTools.ts`, registered with the other AIDE tools. It belongs to
no feature switch. The server instructions carry one sentence about it.

```ts
view_show({
  path: string,                       // project-relative or absolute inside the project
  base?: 'shown' | 'head' | 'none',   // default 'shown' (the previous show)
  range?: { from?: number | string, to?: number | string },  // see Range
  anchor?: string | number            // heading text or a line number to scroll to
})
```

- `'head'`: diff against `git show HEAD:<path>` (5 s timeout, like other git calls); empty
  base if the file is not in HEAD.
- `'none'`: no marks; the content still becomes the next base.
- Scroll: to `anchor` if given, else to the first change, else to the top.
- Paths outside the project root are refused (same containment check as `aide-preview://`).
- A tab taken by a remote client (`remoteServer.isTabLocked`) gets an error: `view_show is not
  available in a remote session`, so the agent tells the user in text instead. Temporary,
  until the remote page can show files.
- The calling tab (`context.tabId`) becomes the window's **reply tab**: the tab that Send
  writes to. A call from outside an AIDE terminal tab shows the file, and Send is disabled
  with `No agent tab to reply to`.
- Result text: `Shown docs/x.md: 5 changes since the previous show. The user's comments
  will arrive as a message.` (or `First show, no base.`). The tool returns at once; it does
  not wait for comments.

Tool description, for the agent: use it when the user should read or review a file you
wrote or changed; call it after you finish a set of edits, not after each edit.

---

## File kinds

The kind comes from the extension (`viewerKind` in `src/main/viewer/viewerFiles.ts`).

| Kind | Display | Diff |
|---|---|---|
| `markdown` | Rendered (default) or Source | Block + word diff (below); Source: line diff |
| `image`, `svg` | Image, fit to window, click for 1:1 | Badge `Changed since last show` + **Before / After** toggle |
| `html` (`.html`, `.htm`) | The page (default) or Source; see HTML pages | Source: line diff |
| text | Source with syntax colors | Line diff |
| binary, not an image | Refused by the tool: `Cannot show a binary file` |  |

Image bases are kept as bytes in the snapshot (images over 20 MB: no base kept, no
toggle). Before/After of an image uses a `data:` URL for the old bytes.

---

## Rendered Markdown diff

A line diff of the source, rendered afterwards, breaks markup (half a `**bold**`, a row cut
out of a table). A diff of rendered HTML is unpredictable on tables and nested lists. The
viewer compares at two levels, and every piece it renders is a whole Markdown block.

### 1. Blocks

`marked.lexer()` splits both versions into a flat list of blocks:

- paragraph, heading, blockquote paragraph, code block, horizontal rule, HTML block;
- each **list item** is its own block, carrying its list type and nesting depth;
- each **table row** is its own block, carrying the table's header and alignment.

Each block keeps its `raw` text and its source line range (from cumulative `raw` lengths).

The two block lists are diffed by `raw` (trimmed) with `diffArrays` from the `diff`
package (jsdiff, new dependency). The result is a sequence of equal, removed and added
blocks.

### 2. Pairing within a change

In each run of removed blocks followed by added blocks, blocks are paired in order when
they have the same type and similar text: word-level similarity ≥ 0.4
(`2 × common words / (words A + words B)`). Paired blocks get a word diff; unpaired
blocks are shown whole as removed or added. Below 0.4 a word diff is unreadable, so
"removed + added" is shown instead.

### 3. Words inside a paired block

The inline tokens of each block (`marked.Lexer.lexInline`) are flattened into **atoms**:
words and whitespace of text tokens, and whole code spans, links, images and line breaks.
Each atom carries its formatting stack (`strong`, `em`, `del`, link href). Atoms are
compared by text + formatting; `diffArrays` gives equal, removed and added atoms.

Each atom is rendered with its own formatting wrappers, inside `<del>` or `<ins>` when
changed. The markup stays balanced whatever the diff is. A word that only changed its
formatting shows as removed + added.

Code blocks in a pair get a line diff inside the `<pre>`. Table rows in a pair get a word
diff per cell when the cell count is equal, else removed + added.

### Rendering

- Removed block: red left bar and muted red background, content struck through.
- Added block: green left bar and muted green background.
- Changed block: no bar color of its own; inline `<del>` (red, struck through) and
  `<ins>` (green).
- Lists and tables are rebuilt from their item and row blocks, so a removed list item shows
  in its place in its list, and a removed row in its table.
- Each change (a removed/added run or a changed block) is one stop for `‹ n of m ›`.

The block diff and atom diff are pure functions in
`src/renderer/src/components/viewer/mdDiff.ts`, unit-tested: insert/delete/modify of
paragraphs, list items at several depths, table rows, code lines, formatting-only changes,
the 0.4 threshold, and balanced HTML for every case.

Rendering of a single block uses the document Markdown renderer
(`documentMarkdown.ts` from the rendered preview spec): same sanitizer, Mermaid, colorized
code, relative images through `aide-preview://`. A changed Mermaid block is shown as two
diagrams, before (removed) and after (added).

---

## Comments

### Adding

1. The user selects text in the document (rendered or Source view). A small **Comment**
   button appears next to the selection.
2. Clicking it adds a card at the bottom of the panel with the quote and an empty text
   field that has focus. `Ctrl+Enter` or a click outside finishes the card.
3. The card shows the quote (cut to 3 lines, full on hover), the source line range, the
   text, and delete. The text stays editable.

Nothing is drawn in the document. Hovering a card scrolls to the blocks of its lines and
outlines them until the pointer leaves; a quote from removed text finds its removed block.

### Source line range

Every rendered block element carries `data-lines="12-14"` (lines of the displayed version).
A selection maps to the union of the ranges of the blocks it touches. In Source view and in
text files, lines come from the line elements directly. A quote taken from removed text has
no current lines and is labeled `in removed text`.

Comments are kept per file: when `view_show` moves the window to another file, the cards
of earlier files stay in the panel, each group under its path.

An empty card (a quote with no text) is sent as it is: the quote alone says "look here".

### Free text and Send

Below the cards there is a free text field. **Send (n)** is enabled when there is at least
one card or free text and the reply tab is open.

Send composes one message, pastes it into the reply tab and submits it at once
(`ptyManager.submitPastedInput`, made public: bracketed paste, then the tool's submit
sequence after the CLI has rendered the paste). If the agent is busy, the CLI queues the
message.

```
Comments on docs/x.md (shown 14:02):

1. Lines 12-14:
> the quoted text, as selected
Comment text.

2. In removed text:
> quoted text
Comment text.

Comments on docs/y.md (shown 13:40):
...

<free text>
```

After a successful send the cards and the free text are cleared, and the panel says `Sent`. If the reply tab is
closed, Send stays disabled with `Agent tab closed`, and the comments are kept.

Unsent comments survive hiding the window and new shows. They are lost when the AIDE window
closes; closing AIDE with unsent comments asks for confirmation.

---

## Marks on images

An agent that wants the user to mark up an image says so: `view_show({ path, marks: true })`
("I show it and wait for marks"), or `marks: [...]` with marks of its own ("here is what I
mean"). Without `marks` an image is view-only. Marks work on images only; on other kinds the
tool refuses the argument.

### Marks

Five kinds, all with an optional note: **text** (a label at a point), **arrow**, **line**,
**rectangle**, **ellipse**. No freehand drawing: a mark is a primitive the agent can read as
data and send back.

```ts
type Mark =
  | { id, by, type: 'text', x, y, text, size? }
  | { id, by, type: 'arrow' | 'line', x1, y1, x2, y2, note? }
  | { id, by, type: 'rect' | 'ellipse', x, y, w, h, note? }
// by: 'agent' | 'user'
```

A text mark is content of the image ("this is the label I want here"), not a remark about
it: its `size` is in image units and it scales with the image when zooming. A new text mark
gets the size that looks 16 px at the current zoom; an agent mark without `size` looks 16 px
at "fit". `[` and `]` resize the selected text mark by 10%. Labels of the other marks are
remarks and keep their screen size.

Coordinates are in image units: pixels of the natural size for raster images, viewBox units
for SVG, so the agent reads them in the coordinate system it drew in. Agent marks get ids
`a1, a2…` when the agent gives none; user marks `u1, u2…`.

### Editing

A tool bar above the image: Select, Text, Arrow, Line, Rectangle, Ellipse. Drawing: press and
drag (a click for Text). Select: click a mark to select it, drag to move it, `Delete` removes
it. Both authors' marks can be moved and deleted; agent and user marks have different colors.
Every mark is a card in the right panel above the comments, with its note (the text of a
text mark) editable; hovering a card selects its mark.

The marks layer covers the whole window, not only the image: marks and their labels may go
beyond its edges (coordinates are then negative or past its size). Zoom: the wheel, around
the pointer; the corner control (−, the zoom in % of actual size, +, Fit); keys 0 (fit) and
1 (actual size). Pan: the middle button, Space + drag, or dragging empty space with Select.
Snap: while drawing or moving, a point within 8 screen pixels of a snap point lands on it
(corners, edge middles and centers of other marks, ends of lines, the image's corners, edge
middles and center), shown by a white ring; Alt draws freely; Shift keeps lines to 45° steps
and makes a rectangle a square, an ellipse a circle. No Before/After while marks are on:
marks belong to the current image. Tool keys: V, T, A, L, R, E; Escape
deselects. After a Send the sent marks become the base, so Send is enabled again only when
the user changes them.

### What the agent gets

Send adds a marks section to the message:

```
Marks on assets/login.svg (shown 14:02), coordinates in viewBox units:
1. arrow u1 (120,40)→(300,200): "bigger"
2. rect u2 (10,10 200×80): "remove"
3. text u3 at (50,60): "Title here"
4. rect a1 (agent's, moved) (40,300 120×40)
Removed agent marks: a2.
Marks JSON: [{"id":"u1","by":"user","type":"arrow",...}, ...]
Image with the marks: .aide/users/<user>/viewer/marks-<time>.png
```

- **No interpretation.** The viewer reports coordinates and the user's text, nothing about
  what lies under a mark. The agent works that out itself: for an SVG from its own source,
  in its own units; for a raster image from the picture below. Guessing elements under marks
  was tried and dropped: its misses (a group instead of the button beside it, a backdrop)
  mislead a weak model more than they help a strong one, which can look or ask.
- **Raster images**: coordinates alone say little without the picture, so the viewer also
  writes a PNG of the image with the marks drawn on it (widened to hold marks beyond the
  image, on a dark field) under
  `.aide/users/<user>/viewer/` and gives its path; the agent opens it with vision and takes
  exact positions from the JSON.
- **Marks JSON** carries all marks in their final state, so the agent can pass them back in
  `view_show({ marks })`, changed or not.

### Lifetime

Marks belong to one show. A new `view_show` drops all marks: what the agent kept became part
of the image or is passed again in `marks`, the rest is gone. Unsent marks count as unsent
work for the close confirmation.

---

## HTML pages

Agents often show their work as a page: a voice review with audio players, a report with
charts, a prototype. The viewer runs the page itself, so the user does not have to open a
browser, and what the user wants to say about it comes back to the agent like comments.

### Loading: `aide-preview://`

`aide-preview://<token>/<project-relative path>` serves project files to pages
(`src/main/viewer/previewProtocol.ts`, the pure part in `previewFiles.ts`). It is a
privileged scheme registered before the app is ready (standard, secure, fetch, CORS,
streaming) and handled once when it is ready.

- **Tokens.** Each open project gets two random 128-bit tokens when its viewer is attached
  and loses them when the project closes: the offline token and the network token. An
  unknown token is `404`. A token names one project, so a page reads the files of its
  project and nothing else on disk.
- **Containment.** The URL path is decoded and checked lexically first, so an absolute or
  UNC path never reaches the disk or the network (a `\\host\share` lookup would otherwise
  connect to that host). Then the real path must be inside the project's real path
  (`resolveProjectFile`, case-insensitive on Windows), which refuses links and junctions
  that point out. Outside → `403` and the diagnostics event `preview-denied`; missing, a
  directory, a bad escape → `404`. Dot paths (`.aide/…`) are served: pages are often there.
- **Responses.** `Content-Type` by extension (pages, scripts, styles, fonts, images, audio,
  video, wasm), `Cache-Control: no-store` (always the file on disk now),
  `Access-Control-Allow-Origin: *` (the page has an opaque origin, so module scripts and
  `fetch` are cross-origin), and byte ranges (`206`, `416`) so audio and video seek.
- **CSP of pages.** HTML responses carry
  `default-src aide-preview: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'`,
  and under the network token also `https: wss:`.

### The page

The page view is an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`: the
page gets an opaque origin and cannot reach the viewer, its bridge, storage or cookies; no
popups, no top navigation, no forms. Preload scripts do not run in frames.

A link that navigates the page frame itself to a website or `mailto:` opens in the browser
and the page stays: a site in the frame would leave no way back. The window CSP lists
`https: http:` in `frame-src` only so that such a navigation reaches `will-frame-navigate`:
Chromium checks `frame-src` before Electron sees the navigation, and a blocked one leaves a
blank frame. Frames inside the page (an embedded map or video) may navigate anywhere
by default; what they load is limited by the page CSP, so by the Network button. The
setting **Keep HTML pages in the viewer inside the project** (Settings → General → Privacy,
`privacy.viewerPagesStayInProject`, off by default) makes the viewer window refuse
navigation of any frame to anything but `aide-preview:`, `about:`, `data:` and `blob:`
(`will-frame-navigate`). It is read on each navigation, so it applies without a restart.
What a page loads (scripts, images, `fetch`) is limited by the Network button either way.

Header of the page view:

- **Page / Source**: the page, or its source with the line diff against the base.
  `range` is refused for pages: a page is shown whole.
- **Network: off / on**: off loads the page under the offline token, on under the network
  token. A page cannot switch the network on itself, because it never learns the network
  token while it is off. Each show starts from the setting **Let HTML pages in the viewer
  use the network** (Settings → General → Privacy, `privacy.viewerPagesNetwork`, on by
  default): who does not want traffic from merely opening a page turns it off and presses
  the button when a page needs it.
- **Reload**: reloads the page.
- **Live**: the page reloads when a file it loaded changes. The protocol reports every file
  it serves; the viewer keeps the set of files the displayed page loaded (the page itself,
  its CSS, scripts, data it fetched, media) and reloads on a change to one of them,
  coalesced over 200 ms. A change to an unrelated file in the folder does not reload it.
  With Live off the header says `File changed` and turning Live on reloads.
  The FS watcher skips dot paths (`.aide`, `.git`, …), so a page there and the files it
  loads from there never reload it; Reload still works. Such folders are not a place for
  pages to review: the tool description tells agents to put them elsewhere.
- Change navigation, Seen and Removed apply to Source only.

### Channel back to the agent

The page cannot be selected for comments (it is another document). Instead it sends text:

```js
parent.postMessage({ aide: 'send', text: 'Take 2 is better: the pause after "but" works.' }, '*')
```

Each message becomes a card `from the page` in the comments panel, with the text as its
quote and a note field for the user. Messages from anything but the page's frame are
ignored; the text is cut at 20 000 characters. Nothing is sent by the page alone: the user
presses Send as for other comments. In the message the card reads `N. From the page:`.

---

## Files

**New**

- `src/shared/viewer/`: `mdDiff.ts` (block + word diff, rendering), `lineDiff.ts`,
  `range.ts`, `compose.ts` (the Send message), `types.ts` (IPC payloads); tests
  `mdDiff.test.ts`, `viewerPure.test.ts`
- `src/main/viewer/viewerService.ts`: snapshots per project and path, the window, reply tab,
  live updates of the displayed path (FS observer), IPC `viewer:*`
- `src/main/viewer/showPrep.ts` (pure: base/shown with range, change count) + test
- `src/main/viewer/viewerFiles.ts`: containment, kinds, reading, `git show HEAD`
- `src/main/windows/fileViewer.ts`: window creation, parent binding, bounds, frame
  navigation guard
- `src/main/viewer/previewProtocol.ts`: `aide-preview://` (tokens, serving, served-file
  observer); `previewFiles.ts` (pure: path resolution, ranges, types, CSP) + test
- `src/main/pipeline/mcp/viewTools.ts`: `view_show`
- `src/preload/fileViewer.ts`: `FileViewerAPI` (interface + object)
- `src/renderer/src/windows/FileViewerApp.tsx` (`?window=file-viewer`, the shared renderer
  entry), `src/renderer/src/components/viewer/`: `DocumentView.tsx`, `CommentsPanel.tsx`,
  `selection.ts`, `viewer.css`

**Modified**

- `src/main/pty/ptyManager.ts`: `submitText` (multi-line paste and submit)
- `src/main/windows/editor.ts`: attach/detach the project's viewer, reply tab closed,
  confirm unsent comments on close
- `src/main/config/projectConfig.ts`: `viewerBounds`
- `src/main/index.ts`: scheme registration before ready, protocol handler
- `src/renderer/index.html`: CSP allows `aide-preview:` images, media and frames (and
  `http(s)` frames, see The page)
- `src/preload/editor.ts`, `src/renderer/src/env.d.ts`, `EditorApp.tsx`: `onViewerOpenFile`
- `src/renderer/src/components/history/markdown.ts`: `colorize` exported
- `electron.vite.config.ts`: the preload entry; `package.json`: `diff`

---

## Images and Mermaid in Markdown

The viewer renders Markdown with its own `marked` instance in `mdDiff.ts` (document
options: no `breaks`) and the transcript colorizer for code. Not there yet: relative images
in Markdown (to be loaded through `aide-preview://`, which the window CSP already allows)
and Mermaid diagrams (shown as code). Task `viewer-mermaid-images`.

## Phases

Each phase ends with `npm run typecheck`, `npm test`, `npm run build`, a visual test by the
user, and a commit.

1. **Done.** Window with parent binding, `view_show` with range, snapshots, Live, rendered
   block/word diff, Source toggle, change navigation, comments and Send, text files with
   line diff, images with Before/After.
2. **Done.** Marks on images.
3. **Done.** HTML pages: `aide-preview://`, the sandboxed page, network toggle, reload on
   changes of loaded files, the channel back to the agent.
4. **Open.** Images and Mermaid in Markdown.

## Open questions

1. **Keep snapshots across restarts?** In memory now. If a review spans an AIDE restart,
   store `ShownState` under `.aide/users/<user>/viewer/`.
2. **Several reply tabs.** Two agents showing files to the same window: the last caller
   wins today. If this happens in practice, group cards by reply tab and send each group to
   its own tab.
