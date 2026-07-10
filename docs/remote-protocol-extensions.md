# Remote protocol extensions

> Status: requirements list / knowledge dump. **Not a spec.** Records what the
> AIDE remote-control layer needs to expose. Related: the session-binding
> refactor (`session-binding-and-needs-input-refactor.md`).

## Why

These extensions exist to enable an **external remote-control service** (a
separate app, its own repo) to proxy AIDE CLI sessions for a mobile client —
including hands-free / screen-off operation. That service and its client are out
of scope here; this document covers **only** what AIDE must provide.

The guiding constraint: AIDE gains only **generic, tool-agnostic** capabilities,
reusable by the existing web remote as well (e.g. showing live "thinking /
waiting" status). AIDE gets **no** functionality specific to any single consumer.
The editor must not accumulate techdebt on behalf of an external client.

## What AIDE needs to provide

- **Stable tab↔session binding** (delivered by the refactor doc) so that "the
  current transcript of this tab" is always correct, including after `/branch`,
  `/clear`, resume, and compaction.

- **A tool-agnostic lifecycle event stream** exposed over the remote protocol,
  alongside the existing raw-PTY channel:
  - `turn.start` — the model began working on a prompt.
  - `turn.end` — the model finished; the answer is complete and readable.
  - `tool-activity` — a tool call / thinking is happening (no content).
  - `needs-input` — the model is blocked waiting for the user (approval, y/n).

- **The completed answer text** for a turn: clean assistant text blocks, already
  parsed from the transcript by AIDE's per-tool logic (the consumer never parses
  tool-specific formats). Emitted at `turn.end`.

- **The existing terminal write path** (`writeToTab`) reused as-is for input.

- **The existing pairing/picker flow** reused: aggregator on port 3847, PIN + QR
  pairing, project picker, tab picker, start terminal.

## Notes

- **Single hook system.** AIDE owns the Claude Code hooks (part of the binding
  fix) and exposes the resulting events. External consumers must **not** install
  their own parallel hooks — two installers writing the same
  `.claude/settings.json` is a bug generator.
- **Input belongs to AIDE.** The editor owns the PTY, so the only path to a
  session's stdin is through AIDE's remote protocol. A consumer is therefore an
  AIDE remote client by necessity.
- The events channel is generic. A voice consumer maps `turn.end` → speak,
  `tool-activity` → a chime, `needs-input` → an alert — but AIDE knows none of
  that; it only emits neutral lifecycle events.
