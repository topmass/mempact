# Remote compaction v2 - live wire capture

Captured 2026-07-06 by proxying a real codex 0.142.5 session (ChatGPT Pro
auth) through a local logging reverse proxy pointed at
`https://chatgpt.com/backend-api/codex`, via
`codex -c openai_base_url="http://127.0.0.1:8378" -c features.responses_websockets=false -c features.responses_websockets_v2=false`
(the websocket flags force the HTTP transport so the bodies are inspectable).
This is our own subscription's traffic; auth headers were redacted at capture.

It confirms, on the wire, what `reference/codex-rs/core/src/compact_remote_v2.rs`
describes in source.

## Transport

- **Endpoint**: `POST /responses` - the SAME endpoint as a normal turn, NOT a
  dedicated `/responses/compact`. (v1 used `/responses/compact`; v2 does not.)
- Request body is **zstd-compressed** JSON (`content-encoding: zstd`),
  `stream: true`, `store: false`.
- Feature signalled by header `x-codex-beta-features: remote_compaction_v2`.

## What distinguishes a compaction request from a normal turn

| | normal turn | compaction |
|---|---|---|
| `x-codex-turn-metadata.request_kind` | `turn` | `compaction` |
| last `input` item `type` | `message` | `compaction_trigger` |
| tools included | yes (15) | yes (15) |
| full history sent | yes | yes |

The compaction request sends the entire active history (developer + user +
reasoning + assistant items) and appends a single sentinel input item:

```json
{ "type": "compaction_trigger" }
```

That sentinel is the only signal; everything else is a normal streaming
Responses request. (Matches `compact_remote_v2.rs:236-237`.)

## Response

A normal SSE stream whose single output item is the compaction result:

```
event: response.created
event: response.in_progress
event: response.output_item.added
event: response.metadata
event: response.output_item.done   <-- the compaction item
event: response.completed
```

The `response.output_item.done` item:

```json
{
  "id": "...",
  "type": "compaction",
  "encrypted_content": "gAAAAAB...<~3.2KB base64>...",
  "internal_chat_message_metadata_passthrough": {...},
  "metadata": {...}
}
```

- **Exactly one** compaction item is returned (source enforces this:
  `compact_remote_v2.rs:424-428`).
- `encrypted_content` is a **Fernet token** (the `gAAAAAB` prefix = base64 of
  Fernet version byte `0x80` + 8-byte timestamp). The summary is encrypted
  **server-side**; the client never sees the plaintext. On the next turn the
  server decrypts it back into model context. This is why a client-side port
  cannot reproduce v2 exactly - only the server holds the key.
- `response.completed` carries usage
  (`{input_tokens, cached_tokens, output_tokens, total_tokens}`), fed into
  codex analytics + rollout budget (`compact_remote_v2.rs:282-291`).

## Client's job after the response

The client keeps the encrypted `compaction` item and rebuilds the surrounding
history locally: retained `user`/`developer`/`system` messages newest-first
under `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` (images preserved at zero text
cost), with the compaction item appended last. See
`build_v2_compacted_history` (`compact_remote_v2.rs:439-457`) and our port in
`core/remoteRetention.ts`.

## Why mempact stays local

The value of v2 is server-side: the summary is written and encrypted by
OpenAI's backend and only that backend can decrypt it. A third-party host
(pi, LoopForge, anything not talking to `chatgpt.com/backend-api/codex`) has
no key and no endpoint, so mempact implements the **local** strategy
(`compact.rs`): the session's own model writes a plaintext handoff summary.
The portable v2 learnings we DID adopt - the 64k retention budget, newest-first
selection, tool-output stubbing, developer-message filtering - live in
`core/remoteRetention.ts`.

## How to re-capture

```bash
node reference/../scratch/codex-capture-proxy.mjs    # logging reverse proxy on :8378
codex -c openai_base_url="http://127.0.0.1:8378" \
      -c features.responses_websockets=false \
      -c features.responses_websockets_v2=false
# then run any turn, and /compact, and read capture.jsonl
```

The proxy (kept at `test/codex-capture-proxy.mjs`) decompresses
zstd/gzip/br request bodies and redacts `authorization`/`cookie` headers.
