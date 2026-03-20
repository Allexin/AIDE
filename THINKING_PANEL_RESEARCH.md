# Thinking Panel — Research Notes

## What was attempted

The goal was to display Claude Code's extended thinking (reasoning) blocks in a dedicated
collapsible panel in AIDE, allowing the user to read the model's internal reasoning in
real time while Claude Code processes a request.

## Architecture implemented

A full end-to-end pipeline was built:

1. **`src/main/thinking/thinkingWatcher.ts`** — tail-reads the Claude Code JSONL session
   file, parses `{"type":"thinking","thinking":"..."}` blocks, tracks them per tab, emits
   `thinking:update` IPC events to the renderer.

2. **`src/main/thinking/thinkingRegistry.ts`** — maps each `BrowserWindow` to its
   `ThinkingWatcher` instance.

3. **`src/main/pty/ptyManager.ts`** — two new callbacks: `onSessionAssigned` (fires when a
   PTY tab gets a Claude Code session UUID) and `onTabClosed` (fires on tab close), used to
   start/stop the watcher per tab.

4. **`src/main/windows/editor.ts`** — wires `ThinkingWatcher` to `PtyManager` callbacks.

5. **`src/main/ipc/index.ts`** — `thinking:get-block` handler (renderer asks for a specific
   block by index or `'last'`), `pty:set-raw-log` handler (debug toggle).

6. **`src/preload/editor.ts`** + **`src/renderer/src/env.d.ts`** — context bridge additions:
   `thinkingGetBlock`, `onThinkingUpdate`, `setPtyRawLog`.

7. **`src/renderer/src/store/useThinkingStore.ts`** — Zustand store: current block text,
   index, total, expanded state.

8. **`src/renderer/src/components/thinking/ThinkingPanel.tsx`** — collapsible panel above
   LogPanel. Navigation buttons (◀/▶), block counter (X/total), auto-advance when on last
   block, resize handle. Includes a **RAW** debug button that enables raw PTY logging.

9. **`src/renderer/src/windows/EditorApp.tsx`** — `<ThinkingPanel />` inserted above
   `<LogPanel />`.

## The problem: thinking content is not accessible

### Claude Code v2.1.51 and earlier

JSONL session files stored full thinking content:
```json
{"type":"thinking","thinking":"The user wants to...","signature":"..."}
```
The watcher successfully reads and displays these blocks.

### Claude Code v2.1.80 and later (current)

Anthropic changed the storage format. Thinking blocks now have an **empty string**:
```json
{"type":"thinking","thinking":"","signature":"..."}
```
The actual reasoning text is not persisted anywhere on disk. This is an intentional
architectural decision by Anthropic — possibly for privacy, API continuity, or to prevent
reasoning from being used as a prompt injection vector.

### PTY output (terminal stream)

The raw PTY data was investigated via a debug logging mode (`pty:set-raw-log`). The PTY
stream contains only:
- Terminal animation (spinning Unicode characters: ✶ ✻ ✽ * ✢ ·)
- Status text ("Leavening…")
- ANSI color and cursor positioning sequences (`\x1b[?2026h/l`, `\x1b[38;2;...m`, etc.)

No thinking text is transmitted through the PTY channel.

### stream-json mode

`claude --print --output-format stream-json --verbose` outputs structured JSON including
assistant messages, but:
- Requires `--print` (non-interactive, single-shot mode)
- Incompatible with the interactive PTY session model used in AIDE
- Even in this mode, thinking blocks appear to use the same empty-string format

## Current state

The ThinkingPanel UI is fully implemented and functional. It correctly reads and displays
thinking blocks from older session files (v2.1.51 and earlier). For current Claude Code
versions (v2.1.80+) it shows "No thinking blocks yet" because no thinking content is stored
anywhere accessible.

## Potential future paths

1. **Wait for Anthropic** — if they re-enable thinking storage in JSONL, the watcher will
   pick it up automatically with no changes needed.

2. **Hybrid process mode** — spawn a second non-interactive Claude Code process in
   `stream-json` mode alongside the interactive PTY session, intercept thinking blocks from
   its output, correlate by session. Very complex, uncertain feasibility.

3. **Remove the panel** — until thinking content is accessible again, the panel adds
   complexity with no benefit for current Claude Code versions.

## Files added/modified

```
src/main/thinking/thinkingWatcher.ts         (new)
src/main/thinking/thinkingRegistry.ts        (new)
src/main/pty/ptyManager.ts                   (modified)
src/main/windows/editor.ts                   (modified)
src/main/ipc/index.ts                        (modified)
src/preload/editor.ts                        (modified)
src/renderer/src/env.d.ts                    (modified)
src/renderer/src/store/useThinkingStore.ts   (new)
src/renderer/src/components/thinking/ThinkingPanel.tsx  (new)
src/renderer/src/windows/EditorApp.tsx       (modified)
docs/thinking-panel.md                       (new — architecture spec)
```
