# Smart Compact — Feature Specification

## Problem

Claude Code's built-in `/compact` command replaces the entire conversation context with a
prose summary. This summary:
- Loses all tool call results (file reads, writes, command outputs)
- Loses the specificity of architectural decisions ("why we chose X over Y")
- Forces the AI to re-read files it already processed
- Produces generic summaries that miss project-specific nuance

Smart Compact is a targeted alternative: instead of summarizing everything, it selectively
removes turns that are no longer relevant to the current work, leaving the remaining history
intact and exact.

---

## Core Principles

**Conservative by design.** The analyzer must be biased toward keeping rather than removing.
A false positive (removing needed context) is catastrophic. A false negative (keeping
irrelevant context) is merely suboptimal.

**One-time operation.** Smart Compact is designed for use at natural breakpoints — typically
when transitioning between development stages. It is not intended for repeated use within a
single stage. Chained compacts will hit an irreducible floor of context that cannot be
removed without loss, so multiple compacts in sequence are not supported as a design goal.

**CLI-agnostic.** The feature does not depend on Claude Code internals. Each CLI tool
provides a thin adapter implementing a standard interface. Smart Compact orchestrates
through that interface.

**Direct API, no CLI overhead.** The analyzer call goes directly to the LLM API, bypassing
any CLI's system prompt, injected context, or tool wrappers. This keeps the analysis clean
and cost-effective. We need API url, key, model in Settings for this feature

---

## User Flow

1. User is working in a terminal session (e.g., Claude Code, Qwen Code).
2. User clicks **"Smart Compact"** button in the terminal tab header bar.
3. A modal dialog appears with a single text field:
   ```
   Continue with message:
   [ Moving on to Stage 2 implementation.              ]
   [                          Cancel ]  [ Smart Compact ]
   ```
   This message serves as the task anchor for the analyzer. It tells the analyzer what the
   session will focus on next, enabling accurate relevance judgment.
4. User types the message and confirms.
5. AIDE runs the Smart Compact pipeline (see below). A progress indicator is shown.
6. On completion, AIDE opens a new session with the pruned history and sends the message
   as the first user turn. The terminal tab switches to the new session automatically.

---

## Pipeline

### Step 1 — Read History

The CLI adapter reads the full conversation history for the current session.

History is a flat ordered array of turns. Each turn has:
- `index` — 0-based position in the conversation
- `role` — `"user"` or `"assistant"`
- `content` — array of content blocks

Content block types relevant to this feature:
- `text` — plain text (reasoning, discussion)
- `tool_use` — a tool call (`id`, `name`, `input`)
- `tool_result` — the result of a tool call (`tool_use_id`, `content`)
- `thinking` — extended thinking block (assistant-side only)

### Step 2 — Identify Atomic Units

Before stripping or analysis, turns are grouped into **atomic units** — sets of turns that
must be kept or removed together.

Rules:
- A standalone `text`-only turn is its own atomic unit.
- A `tool_use` block and its corresponding `tool_result` block form one atomic unit,
  regardless of which turns they appear in.
- An assistant turn containing both `text` and `tool_use` is split conceptually:
  the `text` portion belongs to the surrounding narrative unit, the `tool_use` + its
  `tool_result` form a tool unit.

For simplicity in the first implementation, atomic units are defined at the **turn level**:
a consecutive run of turns that together form a tool call exchange is treated as one unit.

### Step 3 — Pre-strip Tool Results

Tool result content is replaced with a compact marker **before** sending to the analyzer.
This step is performed locally, without any API call.

Each turn is prefixed with its index. This index is what the analyzer references in its
output — the model never needs to count.

Serialization format per turn:
```
[<index>] <role>
<content>
```

Tool result bodies are replaced with a compact marker:
```
[tool_result: <tool_name> (<path_or_arg>), <N> chars omitted]
```

`thinking` blocks are collapsed to a single line:
```
[thinking: <N> chars omitted]
```

Full example of a stripped and indexed history excerpt:
```
[0] user
Let's start implementing the lock file for Stage 1.

[1] assistant
Sure. I'll read the existing config first to understand the structure.
[tool_use: read_file → src/main/config/appConfig.ts]

[2] user
[tool_result: read_file (src/main/config/appConfig.ts), 2847 chars omitted]

[3] assistant
The config uses a plain JSON file. I'll add the lock file logic alongside it.
[tool_use: write_file → src/main/config/lock.ts]

[4] user
[tool_result: write_file (src/main/config/lock.ts), 94 chars omitted]

[5] assistant
Lock file done. It writes `.aide/lock` on startup and removes it on exit.
```

The assistant's `text` blocks are kept verbatim — they carry the reasoning and conclusions
that the analyzer needs to judge relevance. This step alone typically reduces context size
by 80–90%, because file read/write bodies dominate token usage in development sessions.

### Step 4 — Analyzer API Call

AIDE calls the analyzer via any OpenAI-compatible API endpoint. The endpoint, API key,
and model are configured in AIDE Settings (see Settings section below).

The analyzer task — reading stripped conversation text and returning index ranges — is
straightforward structured output. It does not require frontier-level reasoning. Small,
cheap models (e.g., Gemini Flash, Haiku, Qwen-turbo) are suitable and preferred for
cost reasons.

**System prompt:**
```
You are a conversation context optimizer. You will receive a conversation history between
a developer and an AI assistant. The history has had tool result bodies replaced with
compact markers — you do not need the actual content to make relevance judgments.

Your task: identify which ranges of turns can be safely removed given the upcoming work.

Rules:
- Be conservative. If unsure whether a turn is needed, keep it.
- tool_use turns and their corresponding tool_result turns must be treated as atomic —
  remove both or neither.
- Architectural decisions, design choices, and reasoning that still applies to future
  work must be kept even if they are "old."
- Completed sub-tasks (bug fixes, scaffolding, file reads for finished stages) may be
  removed if their conclusions are not referenced by later turns.
- Return ONLY a JSON array of ranges. No explanation. No prose.

Output format:
[{"from": 2, "to": 7}, {"from": 15, "to": 22}]

Use the index numbers shown in square brackets at the start of each turn.
Ranges are inclusive on both ends.
If nothing should be removed, return an empty array: []
```

**User message:**
```
Upcoming task: <user's message from dialog>

Conversation history (tool results stripped):
<stripped history, turns numbered 0..N>
```

**Expected response:** A raw JSON array of `{from, to}` objects. AIDE parses this and
validates that ranges are:
- Non-overlapping
- Within bounds (0 to N-1)
- Not overlapping the trailing turns (client-side guard)
- Atomic-unit-safe (no range cuts through a tool_use/tool_result pair)

Any ranges that fail validation are silently dropped (conservative fallback).

### Settings

Smart Compact requires three values in AIDE Settings:

| Setting | Description | Example |
|---|---|---|
| `smartCompact.apiUrl` | Base URL of any OpenAI-compatible endpoint | `https://api.openai.com/v1` |
| `smartCompact.apiKey` | API key for that endpoint | `sk-...` |
| `smartCompact.model` | Model identifier to use for analysis | `gpt-4o-mini` |

If any of these are missing, the Smart Compact button is disabled with a tooltip:
"Configure Smart Compact in Settings first."

### Step 5 — Apply Deletions

AIDE passes the validated ranges to the CLI adapter's `applyDeletions` method.

The adapter removes those turns from the session's persistent history store (e.g., JSONL
file). Turns are removed in reverse order (highest index first) to preserve index validity
during deletion.

**The original tool result content is preserved** in turns that are not removed. Only turns
within the specified ranges are deleted. This is the key difference from compact: what
remains is exact, not summarized.

### Step 6 — Create New Session and Send Message

The CLI adapter:
1. Creates a new session, initializing it with the pruned history.
2. Returns the new session ID.

AIDE then:
1. Switches the terminal tab to the new session.
2. Sends the user's message (from the dialog) as the first input to the new session.

The message starts the new work immediately, without any manual re-orientation.

---

## CLI Adapter Interface

Each supported CLI tool implements this interface. The implementation lives in the
existing CLI tool module (e.g., `claudeCode.ts`, `qwenCode.ts`).

```typescript
interface SmartCompactCapabilities {
  // Human-readable description of what this CLI stores and how
  // Used in logging and error messages
  description: string

  // Read the full history of the current session
  // Returns turns in chronological order, 0-indexed
  getHistory(sessionId: string): Promise<ConversationTurn[]>

  // Remove the specified turn ranges from the session's history store
  // Ranges are 0-based, inclusive, non-overlapping
  applyDeletions(sessionId: string, ranges: Range[]): Promise<void>

  // Create a new session pre-loaded with the given history
  // Returns the new session ID
  createSessionWithHistory(history: ConversationTurn[]): Promise<string>

  // Send a message to an active session
  // Equivalent to typing the message and pressing Enter
  sendMessage(sessionId: string, message: string): Promise<void>
}

interface ConversationTurn {
  index: number
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

interface Range {
  from: number  // inclusive, 0-based
  to: number    // inclusive, 0-based
}
```

The CLI adapter is responsible for knowing its own storage format. AIDE's Smart Compact
pipeline operates only on `ConversationTurn[]` — it never reads JSONL or session files
directly.

---

## Data Flow Diagram

```
[User clicks Smart Compact]
         |
         v
[Dialog: user types message]
         |
         v
[adapter.getHistory(sessionId)]  ← CLI adapter reads JSONL / session store
         |
         v
[Identify atomic units]           ← local, no API
         |
         v
[Pre-strip tool results]          ← local, no API, 80-90% token reduction
         |
         v
[Claude API: analyze stripped history + user message]
         |
         v
[Parse + validate ranges]         ← drop invalid ranges (conservative)
         |
         v
[adapter.applyDeletions(sessionId, ranges)]  ← CLI adapter modifies store
         |
         v
[adapter.createSessionWithHistory(pruned)]   ← CLI adapter creates new session
         |
         v
[AIDE switches tab to new session]
         |
         v
[adapter.sendMessage(newSessionId, userMessage)]
```

---

## Design Decisions

**No summary block injected.** Smart Compact does not insert a summary at the beginning
of the pruned history. The pruned history stands on its own — it is not a transition to
a new conversation, it is the same conversation with irrelevant parts removed. A summary
block would duplicate information and complicate future compacts.

**No chaining support.** Running Smart Compact on an already-compacted session is not a
design goal. There is an irreducible floor of context that cannot be removed without
information loss. Designing for chaining would require managing accumulated residue and
handling the failure mode where nothing can be removed — complexity not worth the benefit.

**Trailing turns are never removed.** The analyzer prompt does not mention this constraint
— it is enforced client-side only, after the analyzer responds. Any ranges that overlap
with the trailing portion of the conversation are silently dropped before applying
deletions. This keeps the analyzer prompt focused purely on relevance judgment, not
operational limits.

**Analyzer receives stripped history, not original.** The analyzer never sees actual file
contents. It sees only the reasoning around tool calls. This is sufficient for relevance
judgment and avoids inflating the API call with data the analyzer cannot usefully process.

**Ranges, not individual indices.** The analyzer returns ranges because consecutive removable
turns are common (a series of file reads at the start of a stage) and ranges are easier for
an LLM to reason about and output correctly than a flat list of indices.

---

## Out of Scope

- **Automatic triggering.** Smart Compact is always user-initiated. There is no automatic
  threshold-based triggering.
- **Multiple CLI sessions in one compact.** One compact operates on one session.
- **Undo.** The original JSONL is not backed up. The operation is not reversible.
  (The CLI adapter could implement a backup as an optional enhancement.)
- **Partial turn removal.** Turns are removed whole. Splitting a turn to keep part of its
  content is not supported.
- **Cross-stage summary injection.** No summary of removed content is inserted anywhere.
