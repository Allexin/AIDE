# Claude Code Traffic Analysis — Thinking Blocks

Date: 2026-03-20
Tool: mitmproxy (`claude-traffic.mitm`)

## Goal

Determine whether Claude's thinking blocks are accessible via traffic interception,
and whether building a forwarder to capture them makes sense.

## File Format

mitmproxy netstring format. Response bodies are gzip-compressed inside netstrings:
```
<length>:<gzip_data>,
```
After stripping certificate blocks, 11 gzip bodies were found and decompressed.

## Findings

### Beta flags in requests

Claude Code sends the following `anthropic-beta` header with every request:
```
oauth-2025-04-20,
interleaved-thinking-2025-05-14,
redact-thinking-2026-02-12,        ← key flag
context-management-2025-06-27,
prompt-caching-scope-2026-01-05
```

### Thinking block structure in SSE stream

One response body (pos 213498, 28331 bytes decompressed) contained a full SSE stream:

```
event: content_block_start
data: {"type":"content_block_start","index":0,
       "content_block":{"type":"thinking","thinking":"","signature":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,
       "delta":{"type":"signature_delta",
                "signature":"ErEDCkYICxgCKkCX0cz3AIoBObbpvjQDU8rs8FGT..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,
       "content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,
       "delta":{"type":"text_delta","text":"..."}}
...
```

**Observations:**
- `thinking` field in `content_block_start` is **empty**
- Delta for the thinking block is `signature_delta` only — **no `thinking_delta`**
- The actual thinking text is absent entirely
- Text response (index 1) streams normally

### Conclusion

`redact-thinking-2026-02-12` causes Anthropic to strip thinking content server-side
before transmission. Only a cryptographic signature is sent (needed for context
continuity). There is nothing to intercept — the thinking text never reaches the client.

## What Would Work

To get thinking content, the `redact-thinking-2026-02-12` flag must be removed
**from the outgoing request**, not from the response. Options:

### Option 1 — Modifying proxy (recommended)

A mitmproxy addon script intercepts the outgoing request and removes the flag
from the `anthropic-beta` header before it reaches Anthropic's servers.
With the flag absent, the API returns `thinking_delta` events with full text.

### Option 2 — Direct API client

Send requests directly to `api.anthropic.com` without the redact flag.
Loses all Claude Code UI and session logic.

### Option 3 — Patch Claude Code binary/source

Find where the beta flags list is assembled in Claude Code and remove the flag there.

## Recommendation

Option 1 is the most practical. A mitmproxy addon of ~20 lines can:
1. Intercept outgoing requests to `api.anthropic.com`
2. Strip `redact-thinking-2026-02-12` from the `anthropic-beta` header
3. Forward the modified request
4. The response will now contain `thinking_delta` with actual thinking text
