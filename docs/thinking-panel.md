# Thinking Panel

Feature: display Claude Code's "thinking" (extended reasoning) blocks in a dedicated UI panel.

## Background

Claude Code stores conversation history as JSONL files in `~/.claude/projects/{encoded-path}/{sessionUUID}.jsonl`. Each assistant message that used extended thinking contains a content block with `"type": "thinking"` and the full reasoning text. This data is not surfaced anywhere in the Claude Code UI — the thinking panel makes it visible.

## Goal

Show thinking blocks from the active terminal tab in a collapsible panel, with prev/next navigation. Auto-advance to the newest block while the user is on the last one.

---

## Architecture

Two independent layers that communicate only via IPC.

### Layer 1 — Main process: ThinkingWatcher

**Location:** `src/main/thinking/thinkingWatcher.ts`

Responsibilities:
- Receives `tabId → sessionId` mappings from `PtyManager` (already available via `assignNewSession` and `spawnResumeTab`)
- Opens a tail-watch on `~/.claude/projects/{encoded}/{sessionId}.jsonl` for each active tab
- Parses newly appended lines, extracts `type: "thinking"` content blocks
- Maintains `Map<tabId, string[]>` — array of thinking texts in order of appearance
- On new block: sends `thinking:update { tabId, total }` to renderer window
- Stops watching when a tab is closed

**Session directory encoding** (already implemented in `sessionScanner.ts`):
- `E:\Projects\AIDE\AIDE` → `E--Projects-AIDE-AIDE`
- Drive colon → `-`, path separators → `-`

**IPC handlers exposed:**

| Channel | Input | Output |
|---------|-------|--------|
| `thinking:get-block` | `{ tabId: string, index: number \| 'last' }` | `{ thinking: string, index: number, total: number } \| null` |

**IPC events emitted:**

| Channel | Payload |
|---------|---------|
| `thinking:update` | `{ tabId: string, total: number }` |

**Integration with PtyManager:**
- After `assignNewSession(sessionId)` maps to a tab → call `thinkingWatcher.startWatching(tabId, sessionId)`
- After `spawnResumeTab(sessionId)` → call `thinkingWatcher.startWatching(tabId, sessionId)` (sessionId known immediately)
- After `closeTab(tabId)` → call `thinkingWatcher.stopWatching(tabId)`

**JSONL parsing notes:**
- Each line is a complete JSON object
- Thinking blocks are inside `message.content[]` array of `type: "assistant"` records
- A single assistant message can contain multiple thinking blocks (extract all)
- Lines are written after Claude Code receives the full streamed response from the API — not mid-stream
- Tail strategy: track file byte offset per tabId, on file change read from offset to EOF

---

### Layer 2 — Renderer: ThinkingPanel

**Store:** `src/renderer/src/store/useThinkingStore.ts`

```ts
interface ThinkingState {
  thinking: string | null   // text of currently displayed block
  index: number             // 0-based index of displayed block
  total: number             // total blocks available for active tab
  isExpanded: boolean

  // actions
  setExpanded: (v: boolean) => void
  setBlock: (thinking: string, index: number, total: number) => void
  setTotal: (total: number) => void
  reset: () => void
}
```

Derived: `isAtLast = index === total - 1`

**Component:** `src/renderer/src/components/thinking/ThinkingPanel.tsx`

Placement: above the log strip, same collapse/expand behavior.

UI elements:
- Header bar: "Thinking" label + `◀ 3 / 7 ▶` navigation + collapse toggle
- Body: scrollable text area with the current thinking block content
- `◀` disabled when `index === 0`
- `▶` disabled when `index === total - 1`

**Data flow:**

```
On panel expand:
  → ipc.invoke('thinking:get-block', { tabId: activeTabId, index: 'last' })
  → setBlock(...)

On active tab change (panel expanded):
  → ipc.invoke('thinking:get-block', { tabId: newTabId, index: 'last' })
  → setBlock(...)   (or reset() if null returned — tab has no thinking blocks)

On 'thinking:update' { tabId, total } received:
  if tabId !== activeTabId → ignore
  if isAtLast:
    → ipc.invoke('thinking:get-block', { tabId, index: 'last' })
    → setBlock(...)
  else:
    → setTotal(total)   // updates total so ▶ becomes enabled, but stays on current block

On ◀ click:
  → ipc.invoke('thinking:get-block', { tabId: activeTabId, index: index - 1 })
  → setBlock(...)

On ▶ click:
  → ipc.invoke('thinking:get-block', { tabId: activeTabId, index: index + 1 })
  → setBlock(...)
```

**When panel is collapsed:** still receives `thinking:update` events but does not fetch block data. On next expand, fetches last block fresh.

---

## Data types

```ts
// Shared (could live in a types file or inline)

interface ThinkingBlock {
  thinking: string    // full reasoning text
  index: number       // 0-based position in session
  total: number       // total blocks in session at time of response
}
```

---

## Files to create / modify

| File | Action |
|------|--------|
| `src/main/thinking/thinkingWatcher.ts` | Create — watcher + IPC handler |
| `src/main/ipc/index.ts` | Modify — register `thinking:get-block` handler, wire up watcher to PtyManager lifecycle |
| `src/main/pty/ptyManager.ts` | Modify — call `thinkingWatcher.startWatching/stopWatching` at appropriate points |
| `src/renderer/src/store/useThinkingStore.ts` | Create — Zustand store |
| `src/renderer/src/components/thinking/ThinkingPanel.tsx` | Create — panel component |
| `src/renderer/src/components/layout/*.tsx` | Modify — insert ThinkingPanel above log strip |
| `src/preload/editor.ts` | Modify — expose `thinking:get-block` invoke + `thinking:update` listener |

---

## Constraints and notes

- No real-time streaming of mid-response thinking — blocks appear only after Claude Code finishes writing the full assistant message to JSONL. This is acceptable: Claude Code already animates token count in the terminal during generation.
- The panel is not hardcoded to Claude Code in the UI layer — it just displays whatever blocks the watcher provides. The watcher itself is Claude Code specific (JSONL format), but isolated in `src/main/thinking/`.
- The panel shows data for the **active tab** only. Switching tabs while expanded triggers a fresh fetch.
- If a tab has `sessionId === null` (new session not yet assigned), there are no blocks to show — panel shows empty state.
- Tail-watch uses byte offset tracking, not full file re-read, to avoid re-parsing the entire session history on every change.
