# Rendered Preview

Feature: show agent-produced explanation artifacts — Markdown with diagrams, SVG, images,
self-contained HTML pages — rendered inside the editor area, next to the existing
Edit and Diff views.

Status: specification, not implemented.

## Background

More and more explanations from coding agents are not plain text. Common forms are
a Markdown document with a Mermaid diagram, an SVG chart, an interactive HTML page with
an animation. The agent writes these
artifacts to the project, usually into `docs/` or `research/`. Today AIDE shows all of
them as source code:

- `EditorPanel` (`src/renderer/src/components/layout/EditorPanel.tsx`) has two views: Monaco
  `Editor` and Monaco `DiffEditor`. Both stay mounted and are toggled by a local `diffMode`
  boolean.
- `editor:read-file-sync` (`src/main/ipc/index.ts`) marks a file as binary when its first
  512 bytes contain a null byte. `loadFile` then calls `closeEditor()`, so clicking a PNG
  in the file tree does nothing that the user can see.
- Markdown rendering exists only for transcripts (`components/history/markdown.ts`:
  `marked` + `DOMPurify` + Monaco colorizer). Its config fits chat messages: `breaks: true`,
  and `img`, `iframe`, `video`, `style` are forbidden.
- The renderer CSP (`src/renderer/index.html`) is
  `default-src 'self'; img-src 'self' data:`. Project files cannot be loaded as resources.

## Goal

When a file can be rendered, a **Render** view shows it. The design is file-based and
does not depend on the agent: any CLI tool (Claude Code, Codex, Devin, …) that writes a
file gets a rendered view. AIDE does not generate anything. It shows what is on disk.

### Non-goals

- Generating explanations or diagrams from AIDE. No LLM calls.
- Video of any kind: no playback, no generation (Manim, TTS). Video files keep the
  current behaviour (binary → not opened).
- Rendered diff (old and new versions side by side in rendered form).
- Editing in the rendered view. Render is read-only. To change the file, go back to Edit.
- Showing previews in the remote web client (`src/main/remote/`).
- Prompt-style conventions such as "answer in ASD-STE100". They belong in prompts,
  `CLAUDE.md` or a toolbar snippet, not in a viewer.

---

## File kinds

`previewKind(path)` is a pure function in `src/renderer/src/components/preview/previewKind.ts`.
It is unit-tested.

| Kind       | Extensions                                  | Default view | Edit available |
|------------|---------------------------------------------|--------------|----------------|
| `markdown` | `md`, `markdown`                            | Edit         | yes            |
| `svg`      | `svg`                                       | Edit         | yes            |
| `html`     | `html`, `htm`                               | Edit         | yes            |
| `image`    | `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico` | Render | no (render-only) |
| `null`     | everything else                             | Edit         | yes            |

Only a non-null kind shows the Render button.

Within a session, the editor remembers the last view the user chose for each kind. If the
user switches a Markdown file to Render, the next Markdown file opens in Render too. The
choice lives in `useEditorStore` and is not persisted (see Open questions).

---

## View mode

### State

`EditorPanel` replaces `diffMode: boolean` with:

```ts
type ViewMode = 'edit' | 'diff' | 'render'
const [viewMode, setViewMode] = useState<ViewMode>('edit')
```

All current `setDiffMode(true|false)` calls map to `'diff'` / `'edit'`.

`useEditorStore` gets:

```ts
openRenderOnLoad: boolean               // like openDiffOnLoad; used by follow mode
lastViewByKind: Partial<Record<PreviewKind, 'edit' | 'render'>>
setOpenRenderOnLoad: (val: boolean) => void
setLastViewForKind: (kind: PreviewKind, view: 'edit' | 'render') => void
```

### Header

The header row gets one more button, placed before **Diff**:

- Edit view of a renderable file: `Render` (title: "Show rendered view").
- Render view: `Source` (title: "Back to editor").
- Render-only kinds: no Render or Diff button, because no text view exists.

HTML files get one more button while in Render view. See [HTML](#html).

### Content source: disk, not the buffer

Render always shows **disk content**, like Diff (Diff compares HEAD with
`diskContentRef`). Why:

- HTML and images load through a URL (see the protocol below), so they can only show disk.
  If Markdown showed the buffer and HTML showed disk, the user would get two different rules.
- Leaving Edit blurs Monaco. The existing blur flow then shows the Save dialog for a dirty
  buffer. So when Render opens, disk and buffer are the same in practice.

### Live reload

The `onFsChanged` handler in `EditorPanel` already reloads the open file silently when the
buffer is not dirty. In Render view the same event also re-renders:

- `markdown` / `svg`: re-render from the new `diskContentRef` value.
- `html`: reload the iframe. Also reload it when a changed path is inside the HTML file's
  directory, because pages often load sibling `.css` / `.js` files. Debounce: 300 ms.
- `image`: bump a cache-busting `?v=<n>` on the URL.

Known limit: the watcher skips dot-prefixed paths. Files under `.aide/` or other dot
directories render, but do not reload live.

### Monaco stays mounted

`Editor` and `DiffEditor` stay mounted (hidden with `display: none`) while Render is
visible. This keeps undo history, dirty state and cursor position. The preview pane is a
third absolutely positioned layer in the editor area.

Edit-menu commands (`onMenuEditCommand`) in Render view: `copy` calls
`document.execCommand('copy')` on the preview selection. `undo`/`redo`/`cut`/`paste` do
nothing. For an HTML iframe, copy is out of scope.

### Status bar

In Render view, `currentLanguage` shows the kind label (`Markdown`, `SVG`, `HTML`,
`Image`). Cursor position is cleared (`null`).

---

## Loading project files: `aide-preview://` protocol

Images in Markdown, the HTML page with its CSS/JS, and images all need a URL that
points to a project file. `file://` is not usable: the dev renderer is served from
`http://localhost`, and opening `file://` broadly would expose the whole disk to rendered
content.

### Scheme

Register a privileged scheme in `src/main/index.ts` before `app.whenReady()`:

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'aide-preview',
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}])
```

### URL shape and scoping

```
aide-preview://<token>/<project-relative path>
```

- `<token>` is a random 128-bit hex string. It is created per open project in
  `openProjectAndTrack` and revoked in the window's `closed` handler. The protocol only
  resolves tokens that are currently registered. Because the token is per project, a
  rendered file from project A cannot read project B or any other path on disk.
- New module `src/main/preview/previewProtocol.ts`:
  - `registerPreviewRoot(projectPath): string` → token
  - `revokePreviewRoot(token)`
  - `installPreviewProtocol()` → `protocol.handle('aide-preview', …)`, called once in
    `whenReady`.
- New IPC handler `preview:get-base-url` returns `aide-preview://<token>/` for the
  requesting window's project. Expose it in `src/preload/editor.ts` as `previewBaseUrl()`
  (update both the `EditorAPI` interface and the object) and in
  `src/renderer/src/env.d.ts`.

### Handler rules

1. Look up the token. Unknown token → `404`.
2. Decode the path and resolve it against the project root.
3. **Containment check** on the `realpath` of the result. Compare paths case-insensitively
   on Windows. The check must defeat `..`, absolute paths, and junctions/symlinks that
   point out of the project. Failure → `403`, and record
   `logEvent('preview-denied', { path })`.
4. Serve with `net.fetch(pathToFileURL(resolved))`. Set `Content-Type` from the extension.
5. For `text/html` responses, add the CSP header described in [HTML](#html).

The containment function (`resolveInsideRoot(root, relPath): string | null`) is pure
apart from `realpath`. It is unit-tested with `..`, `%2e%2e`, absolute paths, UNC paths,
mixed separators, and case differences.

### Renderer CSP

Extend the meta CSP in `src/renderer/index.html`:

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: aide-preview:;
frame-src aide-preview:
```

Remote `http(s)` images in Markdown stay blocked: no tracking pixels and no network
traffic from merely opening a document. They show as a broken image with the `alt` text.

---

## Renderers

All renderers live in `src/renderer/src/components/preview/`. `PreviewPane.tsx` selects
the renderer by kind. Errors go to the Log Panel on the `Preview` channel through
`logManager.append`.

### Markdown

`documentMarkdown.ts` uses its own `Marked` instance. The transcript config does not fit
documents:

| Option                | Transcript (`history/markdown.ts`) | Document preview |
|-----------------------|------------------------------------|------------------|
| `breaks`              | `true`                             | `false` (standard Markdown) |
| `img`                 | forbidden                          | allowed; `src` rewritten (below) |
| Mermaid fences        | shown as code                      | rendered as a diagram |
| Heading ids           | none                               | GitHub-style slugs, so `#anchor` links work |

Share code instead of copying it: move `colorize()` and `LANGUAGE_ALIASES` out of
`history/markdown.ts` into a shared module (e.g. `src/renderer/src/markdown/colorize.ts`),
and have both renderers import it.

**Pipeline**

1. `marked.parse(text)`, where the `code` renderer emits `<pre class="md-mermaid">` for the
   `mermaid` language and `<pre class="md-code">` for everything else, as today.
2. `DOMPurify.sanitize` with a document profile. Forbid `script`, `iframe`, `form`,
   `input`, `button`, `textarea`, `select`, `object`, `embed` and event-handler attributes.
   Allow `img`. Allow `style` attributes only if Open question 3 says so.
3. A DOMPurify `afterSanitizeAttributes` hook rewrites relative `img[src]` to
   `<baseUrl><dir of the .md>/<src>`. Absolute `http(s)` stays as written (CSP blocks it).
   `data:` stays.
4. Async pass: Monaco-colorize the `md-code` blocks (same as transcripts), then render the
   `md-mermaid` blocks.

**Mermaid**

- Add the `mermaid` npm dependency and load it with a dynamic `import('mermaid')` on the
  first diagram, so it lands in its own chunk and costs nothing until it is used.
- `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })`.
- Each block: `mermaid.render(id, source)`. Pass the resulting SVG through
  `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })` and put it
  in place of the `<pre>`.
- Parse error: keep the source code block and add a one-line error caption below it
  (`Mermaid: <message>`). One broken diagram must not stop the rest of the document from
  rendering.

**Links**

A delegated click handler on the preview root sorts links into kinds. This is a pure
`classifyLink(href, currentRelPath)`, unit-tested:

- `#slug` → scroll to the element inside the preview.
- Relative path to a project file (with an optional `#slug`) → `openFileInEditor`, then
  open in Render view if the target has a kind.
- `http(s):` / `mailto:` → `editorApi.openExternal(url)`. This is a new IPC call
  `shell:open-external` that allows only these schemes.
- Anything else → ignore.

Always `preventDefault()`. A click must never navigate the editor window.

**Styling**: `preview.css`, based on the `.md` rules in `history/transcript.css` (dark
palette, code blocks). Content is limited to a readable width (~ 860 px) and centred.

### SVG

Render it as `<img src="<baseUrl><path>?v=n">`. When SVG is used as an image, the browser
does not run its scripts and does not load external resources, so no sanitizer is needed.
Background: a neutral checkerboard, so transparent SVGs stay visible on the dark theme.
Fit to the pane; click toggles 1:1 zoom.

### Image

Same as SVG: `<img>`, checkerboard background, fit/1:1 toggle. A footer line shows the
natural pixel size and the file size.

### HTML

The page runs in an iframe:

```html
<iframe sandbox="allow-scripts" src="aide-preview://<token>/<path>"></iframe>
```

- **No `allow-same-origin`.** The page gets an opaque origin. It cannot reach the parent
  document, `window.editorApi`, cookies or storage. Preload scripts do not run in
  sub-frames (`nodeIntegrationInSubFrames` stays at its default, `false`).
- No `allow-popups`, `allow-top-navigation`, `allow-forms`. The page cannot open windows
  or navigate the editor.
- Relative resources (`style.css`, `app.js`, images) resolve against the iframe URL, go
  through the same protocol handler, and stay inside the project.

**Network toggle.** Generated pages often load libraries from a CDN (d3, three.js,
KaTeX). The protocol handler sends one of two CSP headers on HTML responses:

- Offline (default):
  `default-src aide-preview: data: blob: 'unsafe-inline' 'unsafe-eval'`
- Network allowed: the same, plus `https:`.

The HTML header shows a `Network: off` / `Network: on` button. The choice goes into the
iframe URL as a query flag (`?net=1`), and the handler reads it. The setting is per file
and per session and is not persisted. It resets when another file opens. Why off by
default: opening a file must not cause network traffic that the user did not ask for.

**Reload** button (`⟳`) in the header: reloads the iframe. Useful for pages with state or
animations.

---

## Follow mode

Opt-in. When it is on, AIDE opens new agent output in Render view as soon as it appears.
This is for the flow "the agent writes an explanation, I read it", without searching the
file tree.

- Toggle: a header button in the file tree panel, or a View-menu item (decide during
  implementation). Persisted per user in `.aide/users/<user>/settings.json` as
  `previewFollow?: boolean` (`ProjectSettings` in `src/main/config/projectConfig.ts`).
- Scope: app config `editor.previewFollowGlobs`, default `["docs/**", "research/**"]`.
  Only files with a non-null kind match.
- Trigger: `filetree:fs-changed` with a matching path. Wait 1 s after the last matching
  event, then open the **most recent** matching path. Agents write files in bursts, and
  the editor must not jump between them.
- Guards, so the user is not interrupted:
  - Never switch while the current buffer is dirty or a dialog is open.
  - Never switch while the editor panel has focus (the user is typing). Keep the pending
    path, and act on it the next time the panel loses focus.
  - Saves made by AIDE itself are not followed (the `mtime` check in `onFsChanged`
    already does this for the open file. Follow mode needs the same guard for the path
    that was just written).
- Opening uses `openRenderOnLoad = true` + `openFileInEditor`. This is the same pattern as
  `openDiffOnLoad`.

---

## Files

**New**

- `src/main/preview/previewProtocol.ts` — scheme handler, token registry, containment check
- `src/renderer/src/components/preview/PreviewPane.tsx`
- `src/renderer/src/components/preview/MarkdownPreview.tsx`
- `src/renderer/src/components/preview/ImagePreview.tsx` — image / SVG
- `src/renderer/src/components/preview/HtmlPreview.tsx`
- `src/renderer/src/components/preview/documentMarkdown.ts`
- `src/renderer/src/components/preview/previewKind.ts`
- `src/renderer/src/components/preview/links.ts` — `classifyLink`
- `src/renderer/src/components/preview/preview.css`
- `src/renderer/src/markdown/colorize.ts` — moved out of `history/markdown.ts`
- Tests: `previewKind.test.ts`, `links.test.ts`, `documentMarkdown.test.ts`,
  `src/main/preview/previewProtocol.test.ts` (containment)

**Modified**

- `src/main/index.ts` — `registerSchemesAsPrivileged`, `installPreviewProtocol()`
- `src/main/windows/editor.ts` — register/revoke the project token
- `src/main/ipc/index.ts` — `preview:get-base-url`, `shell:open-external`
- `src/preload/editor.ts` + `src/renderer/src/env.d.ts` — `previewBaseUrl`, `openExternal`
- `src/renderer/index.html` — CSP
- `src/renderer/src/components/layout/EditorPanel.tsx` — `viewMode`, header buttons,
  render-only kinds skip `readFile` and the binary/large-file paths
- `src/renderer/src/store/useEditorStore.ts` — `openRenderOnLoad`, `lastViewByKind`
- `src/renderer/src/components/history/markdown.ts` — import the shared colorizer
- `src/main/config/projectConfig.ts`, `src/main/config/appConfig.ts` — follow-mode settings
- `package.json` — `mermaid`

### Render-only loading path

`loadFile` checks `previewKind` **before** `readFile`. For `image` it must not
read the file: a large image would be pulled synchronously over IPC and then thrown away
by the binary check. It sets `loadedFileRef`, resets `dirtyRef`, sets `viewMode = 'render'`,
and stops. The large-file dialog does not apply to render-only kinds.

---

## Phases

Each phase ends with `npm run typecheck`, `npm test`, `npm run build`, and a visual test
by the user. After that, update `STAGES.md` and commit.

1. **View mode + Markdown.** `viewMode` refactor, Render/Source button, document
   Markdown renderer, Mermaid, links, live reload. No local images yet; relative `img`
   shows `alt` text.
2. **Protocol + images.** `aide-preview://` with containment, CSP, local images in
   Markdown, SVG / image views, render-only loading path.
3. **HTML.** Sandboxed iframe, CSP header, network toggle, reload button, reload on
   directory changes.
4. **Follow mode.** Settings, glob matching, debounce, guards.

Phase 1 is useful without the others, and it carries the largest share of the value:
Mermaid diagrams in `docs/`.

---

## Open questions

1. **Persist `lastViewByKind`?** The proposal is session-only. Persist it per user if
   users find themselves pressing Render on every Markdown file.
2. **Follow-mode toggle location.** File tree header button vs. View menu vs. status-bar
   sensor.
3. **Inline `style` attributes in Markdown.** Agents sometimes emit
   `<div style="…">` callouts. Allowing `style` brings back CSS-based layout breakage, but
   not script execution. Proposal: forbid in phase 1, revisit after real documents are tried.
4. **Math (KaTeX).** Not in scope. Add as a lazy chunk, like Mermaid, if `$…$` shows up
   in agent output often enough.
5. **Scroll sync between Source and Render.** Not in scope. Switching views keeps each
   view's own scroll position.
