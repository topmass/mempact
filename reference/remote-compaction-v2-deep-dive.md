# Remote Compaction v2 - deep dive

Everything observable about how codex's live compaction (remote v2, the method
every normal OpenAI-model user runs) works, stashed, and replayed. The summary
payload is encrypted server-side and unreadable by the client; **everything
around it is fully observable** and documented here.

Three independent evidence sources, cross-validated:
- **Wire**: our own codex 0.142.5 traffic proxied to `chatgpt.com/backend-api/codex` (see `remote-compaction-wire-capture.md`).
- **Disk**: codex's own rollout JSONL, session `019f3a7d…` - the *same* compaction we captured on the wire.
- **Source**: vendored `reference/codex-rs/` (Apache-2.0, tag rust-v0.142.5).

The wire blob and the on-disk blob were verified **byte-identical** (3,212-byte
Fernet token, same session) - the client persists the opaque ciphertext verbatim.

---

## TL;DR

1. Compaction is a normal `POST /responses` streaming request with `request_kind=compaction` and one extra input item: `{"type":"compaction_trigger"}` appended last. No summarization prompt is sent - the server owns the procedure.
2. The server returns exactly one output item `{"type":"compaction","encrypted_content":"gAAAAAB…"}` - a **Fernet** token (AES-128-CBC + HMAC-SHA256). The summary is written and encrypted server-side; the client never sees plaintext and holds no key.
3. The client keeps that ciphertext, rebuilds local history as `[retained user/dev/system messages ≤64k tokens] + [the encrypted compaction item, last]`, and **persists it verbatim** to the rollout.
4. On the next turn (and on resume), the client re-sends the encrypted blob back up unchanged via `for_prompt`. Only the server can decrypt it back into context.
5. The rollout is **append-only**: the full pre-compaction history stays on disk forever; compaction only shrinks what's sent to the model, not what's stored.

---

## 1. Trigger

- Threshold `min(configured, context_window * 9/10)`. Live gpt-5.5: `auto_compact_token_limit=null`, `context_window=272000` → fires at **244,800 tokens**. (From the `/models` response, `openai_models.rs:436`.)
- Checked **pre-turn** and **mid-turn** (only mid-turn if the model still needs a follow-up). Manual `/compact` bypasses the threshold.
- Two extra triggers: **model downshift** (switching to a smaller context window) and **comp_hash change**. Live `comp_hash="2911"` is shared across all user-facing gpt-5.x models (auto-review is null), so swapping between flagship models does *not* trip it - it's for cross-version jumps.
- Dispatch ladder (`tasks/compact.rs`, `session/turn.rs`): OpenAI provider + `RemoteCompactionV2` (default_enabled, Stable) → **v2**. v1 is dead unless the flag is forced off; local only for non-OpenAI backends.

## 2. The request

`POST /responses`, zstd-compressed JSON body, `stream:true`, `store:false`, all 15 tool schemas included.

| distinguishing field | value |
|---|---|
| `x-codex-turn-metadata.request_kind` | `compaction` |
| `x-codex-beta-features` header | `remote_compaction_v2` |
| last `input` item | `{"type":"compaction_trigger"}` |
| `include` | `["reasoning.encrypted_content"]` |

- The **sentinel** is `ResponseItem::CompactionTrigger {}` (`protocol/src/models.rs:1137`), appended as the final input item at `compact_remote_v2.rs:236-237`. It serializes to bare `{"type":"compaction_trigger"}` and is the *only* compaction-specific signal - **no summarization prompt is sent**. The `instructions` field is just the normal Codex system prompt.
- `include:["reasoning.encrypted_content"]` (`client.rs:800-804`) tells the server to echo encrypted reasoning/compaction blobs back so the client can persist them. Without it there'd be no blob to re-send.
- Headers of note: `x-codex-window-id` = `<thread>:<window#>` (e.g. `…:0`); `x-codex-turn-metadata` carries installation/session/thread/turn/window ids + `request_kind`; `x-codex-turn-state` (sticky-routing token, see §10).

## 3. The response

Normal SSE: `response.created → in_progress → output_item.added → metadata → output_item.done → completed`.

- The single `output_item.done` is `{"type":"compaction","id":…,"encrypted_content":"gAAAAAB…"}` (`protocol/src/models.rs:1127-1136`; `encrypted_content` has no `skip_serializing_if` → always present).
- **Fernet format** (verified by decoding): version byte `0x80`, 8-byte big-endian timestamp, 16-byte IV, AES-128-CBC ciphertext (multiple of 16), 32-byte HMAC-SHA256. Needs a 256-bit key held **only** server-side. Not on the client (searched `auth.json` - only OAuth tokens; `~/.codex` - nothing; the binary - no fernet/decrypt symbols). Not brute-forceable.
- Codex enforces **exactly one** compaction item or `CodexErr::Fatal` (`compact_remote_v2.rs:424-428`); extra output items (e.g. an assistant reply) are tolerated.
- `response.completed` carries `usage` → feeds analytics + rollout budget.

## 4. How it's stashed in memory

- Post-response, history is rebuilt to `[retained user/dev/system messages, Compaction]` by `build_v2_compacted_history` (`compact_remote_v2.rs:439-457`): retained messages filtered (`should_keep_compacted_history_item`) and truncated newest-first under **`RETAINED_MESSAGE_TOKEN_BUDGET=64_000`** (images kept at zero text cost), then the encrypted `Compaction` item pushed last (`:455`).
- Installed via `replace_compacted_history` (`session/mod.rs:2880`). The `Compaction` item lives in `ContextManager.raw_items` as an ordinary `ResponseItem` - never decoded.

## 5. How it's stashed on disk (the "how it's stashed" answer)

One rollout line: `{"type":"compacted","payload":{CompactedItem}}` (`RolloutItem::Compacted`, `protocol.rs:3040`). Real captured payload for our session:

```json
{
  "message": "",                          // v2 always empty; summary is in the blob
  "replacement_history": [
    {"type":"message","role":"user","content":[{"text":"Reply with only the word banana…"}]},
    {"type":"compaction","id":"…","encrypted_content":"gAAAAAB…<3212 bytes>…"}
  ],
  "window_number": 1,
  "first_window_id": "019f3a7d-8004-73a0-85c7-300970965283",
  "previous_window_id": "019f3a7d-8004-73a0-85c7-300970965283",
  "window_id": "019f3a87-474b-7ae3-97f6-b62087e69c45"
}
```

- `message=""` for v2 (v1 put the plaintext summary here). The summary is **only** in the encrypted blob.
- The **encrypted blob is persisted verbatim** inside `replacement_history` - byte-identical to the wire. Codex never decrypts or rewrites it.
- Reasoning items are also persisted with their own `encrypted_content` (~972 bytes each in this session).
- **Append-only**: the rollout still contains every pre-compaction `response_item` (all messages, reasoning, assistant turns). The `compacted` line is appended, not a replacement. Compaction shrinks the model's context window, **not** on-disk retention - the full raw conversation persists in the session file until deleted.

## 6. Resume - how the stashed blob is replayed

`reconstruct_history_from_rollout` (`session/rollout_reconstruction.rs:106-366`):
1. Reverse-scan for the newest `Compacted` with `replacement_history`; everything older is dropped, the suffix after it is replayed forward.
2. `history.replace(replacement_history)` puts the retained messages **and the encrypted Compaction item** straight back into memory verbatim (`:285-287`). Nothing decodes it.
3. On the next turn, `for_prompt` returns all raw items (normalization only touches call/output pairing + images; it does **not** drop `Compaction`), so the encrypted blob is serialized straight back into the request and re-sent to the server (`client.rs:781-840`). The server decrypts it to reconstitute context.

So the client is a pure courier for the ciphertext: persist verbatim → replay verbatim → server decrypts. After a bare v2 compaction resume, `reference_context_item=None`, so full initial context is re-injected on the next turn.

## 7. Window chain

- `AutoCompactWindow` (`state/auto_compact_window.rs`): `window_number`, `{first_window_id, previous_window_id, window_id}` (UUIDv7). `advance()` bumps the number, rotates previous←current, mints a new v7 (`:69-76`). `first_window_id` fixed at creation.
- Persisted in every `CompactedItem`; restored on resume by reverse-scanning the rollout (`rollout_reconstruction.rs:132-162`), fallback window_number = count of `Compacted` entries.
- Legacy shim: old rollouts stored the numeric window number in the `window_id` field; a custom deserializer (`compacted_item.rs:7-53`) migrates `{"window_id":3}` → `window_number:3`.
- `advance()` does **not** clear the prefill baseline; only the explicit new-context-window path does.

## 8. Token accounting

- The `Compaction` item is both **model-generated** and an **api-message** (`history.rs:490,722`); the `compaction_trigger` sentinel is neither (never recorded, never counted).
- Its size estimate: `estimate_reasoning_length(len) = len*3/4 - 650` (`history.rs:497-503`) - same family as encrypted reasoning; the -650 strips base64/JSON envelope overhead.
- `recompute_token_usage` after compaction overwrites `last_token_usage` with `{total: estimate over all retained items incl. the blob}`. Since the `Compaction` item is last and model-generated, `items_after_last_model_generated_item` is empty, so the reported total collapses to (retained msgs + blob estimate + base instructions). In our capture the post-compaction context dropped to ~5,832 tokens.

## 9. Retries / errors / timeouts / abort

- Retry budget `min(provider.stream_max_retries(), 2)` - `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES=2` (`compact_remote_v2.rs:52-54`), deliberately smaller than normal turns.
- Only retryable errors retry; on WS exhaustion it falls back to HTTP once (`responses_retry.rs:31-46`). "stream closed before response.completed" is retryable; "expected exactly one compaction output item" is `Fatal` (no retry).
- The **4x compaction timeout multiplier is v1-only** (unary `/responses/compact`); v2 uses the ordinary per-event idle timeout via the streaming path.
- `TurnAborted` returns early and silently (no error event), before the generic error branch (`compact_remote_v2.rs:168-170`).

## 10. `x-codex-turn-state` header

Used by **both v1 and v2** (correction to the earlier wire doc). It's a sticky-routing token: the server sets it in a response header at turn start, the client stores it in a per-turn `OnceLock` and replays it unchanged on every request in the same turn. Inline auto-compaction reuses the main turn's session (and its turn-state); a standalone `/compact` gets a fresh session with an empty token populated from its own first response. (`client.rs:134,244-257`.)

## 11. Analytics (what codex records about each compaction)

`CodexCompactionEvent` (`analytics/src/facts.rs:401-421`), populated in `compact.rs:393-434`:
`strategy=Memento`, `implementation=ResponsesCompactionV2`, `trigger` (Auto/Manual), `reason` (UserRequested/ContextLimit/ModelDownshift/CompHashChanged), `phase` (StandaloneTurn/PreTurn/MidTurn), `status`, `active_context_tokens_before`/`after`, `retained_image_count`, `compaction_summary_tokens` (= server output_tokens), `cached_input_tokens`, `duration_ms`, thread/turn ids.

---

## What this means for mempact

- **Observable, and we replicate it**: the trigger math, the 64k newest-first retained-message rebuild (images at zero cost), the filtering, the window chain, the append-only persistence model, the token accounting shape, "summary item last".
- **Opaque, and we cannot replicate it**: the summary *quality*. v2's summary is produced by a **closed server-side procedure** (no prompt sent, no format spec exposed) operating on encrypted reasoning state the client can't read, and returned as an encrypted blob only the server can decrypt. There is nothing on the client - no prompt, no key, no format - to recover it from. This capture is the ceiling of what's observable.
- mempact therefore implements the **local** strategy (plaintext model-written summary via the open `SUMMARIZATION_PROMPT`) plus all the client-side v2 machinery worth borrowing. It will never match v2's summary fidelity, because that fidelity is the one part that never leaves OpenAI's servers in readable form.
