# Mempact Compaction, Durable Handoff, and Recall — Architecture & Implementation Audit

Date: 2026-08-22. Auditor: Claude (Fable 5) via Claude Code, with live testing against
`serve-model` (Qwen3.8-27B-UD-Q4_K_XL-v3, llama.cpp, RTX 5090) on nobara-pc.

## Phase 1 — Source digest (pins)

| Source | Commit | Version | Location |
|---|---|---|---|
| mempact | `99e56e1af53bbc8343bff34df3938457dad16d31` (HEAD = pinned) | 0.2.0 | `/home/topmass/Code/mempact` |
| pi (earendil-works/pi) | `a1f955e9f47fd3379b44f4aace65ab916c80519a` | coding-agent 0.84.2 | `/home/topmass/Code/audit-sources/pi` |
| openai/codex (current) | `8e649e3afa5cdddfb09a1b85a090b94775045d9b` | — | `/home/topmass/Code/audit-sources/codex` |
| openai/codex (mempact base) | `26de83050b20f7e0ee211b9739e52ae00ce8032a` = `rust-v0.142.5` | vendored under `reference/` (verified byte-identical) | — |
| deepseek-harness | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | dsh-0.1.1-rc.2 | `/home/topmass/Code/audit-sources/deepseek-harness` |
| Local pi (this machine) | — | **0.84.2** (mise) — matches pinned audit version | `~/.local/bin/pi` |
| Server pi (nobara-pc) | — | 0.68.1 (stock compaction; no mempact wired) | `matthew@nobara-pc` |
| Mempact dev-deps | — | pi 0.78.0/0.78.1 | `package.json` |

Local `~/.pi/agent/settings.json` already loads mempact (`/home/topmass/Code/mempact/pi/index.ts`)
with `compaction.enabled=false` against provider `server-pc` (llama.cpp @ 100.124.21.54:8080,
declared contextWindow 262144).

Baseline health: `pnpm test` → **117/117 pass**; `tsc --noEmit` clean at pi 0.78 typings.

### Documentation/source mismatches found in references

- **pi `docs/session-format.md` documents `CompactionEntry.retainedTail` that does not exist
  in `packages/coding-agent` at 0.84.2** — it exists only in the new `packages/agent` harness
  (format 4). Forward risk, not current behavior.
- DeepSeek `compaction/README.md` omits the `'cancelled'` member of `ManualCompactionErrorCode`;
  `session-persistence/README.md` omits `SessionHeader.agentPreset`. Minor drift; invariants
  themselves are pinned by tests.
- Codex `new_context` tool: its output text ("without summarizing conversation history") is now
  wrong upstream unless `Feature::TokenBudget` is on — the request now produces a summarizing
  compaction (semantic reversal vs rust-v0.142.5).

## Phase 2 — Current architecture (as measured, not as documented)

### Lifecycle of one tool result (mempact + pi 0.84.2, live-verified)

```
tool execution (pi bash tool)
  -> [L1 LOSSY] pi output-accumulator: 2000 lines OR 50KB cap, KEEPS TAIL;
     full stream spilled to os.tmpdir()/pi-output-<hex>.log (bash only, ephemeral,
     path only surfaced inside the (truncatable) result text)
  -> tool_result hook (mempact): [L2 LOSSY] 12KB (10KB x1.2) middle-ellipsis cap
     — runs BEFORE persistence (verified: agent-session.ts hook -> message build ->
     appendMessage -> JSONL)
  -> [CANONICAL] pi session JSONL — stores the ALREADY-TWICE-TRUNCATED text.
     Bytes removed by L1+L2 are unrecoverable from the session record.
  -> context hook (mempact): [L3 NON-DESTRUCTIVE] >=70% of limit: tool results older
     than newest 3 stubbed per-request (session file untouched)
  -> compaction (mempact session_before_compact): summarization input = post-L2 text;
     replacement history = retained user msgs + summary(+staples); prior entries
     shadowed via firstKeptEntryId sentinel (never deleted from JSONL)
  -> recall tool: searches getBranch() active path, snippet-only (400 chars),
     over post-L1/L2 text — cannot see pre-truncation bytes, other branches,
     or pi's tmp spill files
```

Measured, on-disk proof (old live session, July): a persisted bash toolResult contains
`…2085 chars truncated…` — the canonical record itself is lossy.
Fresh live run (2026-08-22, pi 0.84.2 + Qwen): `sed -n 300,1100p bigfile.txt` (55KB with
a unique marker mid-stream) persisted as 10,023 bytes; marker **destroyed** in the JSONL
(only survivor was `cat bigfile.txt`, where pi's tail-keep truncation happened to move the
marker near the head of the kept window — survival is positional luck, not policy).

### Layer inventory (the ten layers, current state)

1. Raw tool output — exists only transiently; bash-only tail spill to tmpdir (pi), no locator durability.
2. Canonical event log — pi session JSONL; append-only in normal operation, but **stores
   post-truncation content**; deferred first-flush window (nothing on disk until first
   assistant message).
3. Full spill artifacts — **absent** (pi tmp log is ephemeral + bash-only; not an artifact store).
4. Active model-visible context — pi context hook chain; mempact reorders summary last,
   clears old tool outputs, appends memory.
5. Durable project memory — `.mempact/memory.md`; non-atomic writes; injected as final
   user-role message each request.
6. Compaction checkpoint — `CompactionEntry` + `details.mempact` (retainedUserMessages,
   window chain, file lists, checkride result).
7. Recall index — none; linear scan of active branch at query time.
8. Exact retrieval — **absent** (snippets only, ordinal labels only).
9. UI transcript — pi TUI /tree (human-only).
10. Checkride ground truth — extracted from in-window messages at compaction time.

## Phase 3 — Findings

Severity: P0 = destroys user data / task; P1 = correctness of the core loop; P2 = quality/robustness; P3 = polish.
Every finding verified against pinned source and/or live runs unless marked HYPOTHESIS.

### F1 (P0, VERIFIED) Record-time truncation destroys the only canonical copy
- Repo/file: mempact `pi/index.ts:713-724` (`tool_result` hook), `core/outputTruncation.ts:27,33`.
- Behavior: middle-ellipsis truncation to 12KB before pi persists the toolResult. Pi's
  `tool_result` hook result **replaces what is persisted** (pi `agent-session.ts:506-537` →
  `appendMessage`; pinned by pi test `agent-session-model-extension.test.ts:279-347`).
- Why wrong: the ported Codex rule (`history.rs:362 process_item`) truncates only the
  **in-memory model history**; Codex's rollout JSONL always receives the untruncated item
  (both at rust-v0.142.5 and current HEAD — verified in both trees). Mempact applied the cap
  one layer too low, at the only canonical store. `recall`'s "nothing is ever deleted" claim
  (`pi/index.ts:783-792`) is false for the middle of any tool result >12KB.
- Compounding: pi's own bash accumulator (50KB/2000-line, tail-keep) already cut the stream
  before mempact sees it; mempact then cuts the remainder middle-out. Two independent lossy
  layers, differently shaped, neither recoverable.
- Live proof: marker in the middle of a 55KB result absent from JSONL; `…N chars truncated…`
  markers present in persisted records.
- Fix: spill-first retention (F-fix-1 below). Do not touch model-visible caps — keep the
  Codex preview exactly as-is, but persist/spill the full bytes first with a durable locator.

### F2 (P0, VERIFIED LIVE) `-p`/print mode: threshold trigger aborts the task and loses the compaction
- mempact `pi/index.ts:603-707` (`turn_end` → `ctx.compact()`); pi `agent-session.ts:1865`
  (`compact()` begins with `await this.abort()`).
- Live: 32k-window run aborted at step 3 of 5 with "The operation was aborted."; process
  exited; **no compaction entry persisted**; steps 4-5 never ran. The same trigger in RPC
  mode (process stays alive) proceeds.
- Also: async compaction racing process exit in print mode = crash-window where
  `tokensBefore`/window-chain state can be half-advanced.
- Fix: gate auto-trigger on mode (`ctx.mode === "print"` exists at 0.84.2) or defer via
  `agent_settled`; never abort a run that is mid-tool-chain in print mode.

### F3 (P1, VERIFIED LIVE) Trigger/preparation mismatch → "Nothing to compact" failure loop
- mempact triggers on the full request envelope (server-reported usage incl. ~18k system
  prompt); pi's `prepareCompaction` measures **session entries only** against
  `keepRecentTokens=20000` and returns undefined ("Nothing to compact") when entries fit —
  and pi throws **before** `session_before_compact` is emitted, so mempact's takeover never
  runs. Live: `compaction_end ... errorMessage:"Compaction failed: Nothing to compact
  (session too small)"` while real usage was over mempact's limit. Trigger re-fires every
  turn_end → repeated aborts of in-flight work (thrash guard doesn't catch it because no
  compaction ever completes and `pendingTokensBefore` never set).
- Fix: before calling `ctx.compact()`, sanity-check that branch entries carry enough
  summarizable content (or catch this error and pause the trigger for the window, notify).

### F4 (P1, VERIFIED) Overflow classifier misses llama.cpp (the user's own backend)
- mempact `pi/index.ts:197-204` regex does not match llama.cpp's
  `"exceeds the available context size"` (documented pattern list in pi-ai 0.84.2
  `utils/overflow.d.ts`). Overflow recovery would never fire on serve-model.
- pi-ai 0.84.2 exports `isContextOverflow(message, contextWindow)` covering 15+ providers
  incl. silent-overflow detection. Replace the heuristic with the official util (with a
  fallback for old pi versions).

### F5 (P1, VERIFIED) pi-ai `complete` import: compile-broken on 0.84.x, runtime on borrowed time
- `import { complete } from "@earendil-works/pi-ai"` fails `tsc` against 0.84.2 typings
  (moved to `@earendil-works/pi-ai/compat`, explicitly temporary: "deleted with the
  coding-agent ModelManager migration"). At runtime pi's bundled module still exports it
  (verified via probe extension), so the extension currently works — silently and by luck.
- Fix: feature-detected import (try main, fall back to `/compat`), plus typecheck against
  current pi in CI.

### F6 (P1, VERIFIED) recall: branch-scoped, snippet-only, ordinal provenance, and blind to destroyed bytes
- `pi/index.ts:784-822`, `core/recall.ts`.
  - Scope: `getBranch()` = active lineage only. "FULL session history" in the tool
    description overclaims; other branches/sessions unsearchable. (Active-lineage default
    is right; the scope should be explicit and all-branches available with provenance labels.)
  - Snippets: 400 chars, no exact-read, no offset/limit, no event id. `[entry 12 toolResult]`
    is a branch-local ordinal — unstable across branch switches; useless after fork; never
    resolvable back to an exact event by the model.
  - Content: searches post-truncation text only (see F1) — the tool cannot find what the
    cap destroyed, while claiming "nothing is ever deleted".
  - Compaction summaries and stubs are searched with no marking of what is
    original evidence vs model-written summary (provenance confusion; prompt-injection
    hygiene relies on nothing).
- Fix: two-stage recall (search → exact read), stable event ids (pi entry `id` is stable
  8-hex within a session), scope parameter, provenance tags, artifact-read for spilled files.

### F7 (P1, VERIFIED, DESIGN) Memory injected as the newest user message every request
- `pi/index.ts:592-594`: memory appended LAST, after the real latest user message, with a
  fresh `Date.now()` timestamp, on every request.
  - Ordering invariant violated: the block sits *after* the latest real user instruction in
    the transcript, competing for "last message" recency. mempact's own checkride quiz
    formats memory before the quiz question — but in live requests the real user's latest
    message is *above* the memory block.
  - `<latest-user-request>` extraction risk: mempact's own `realUserTexts` collection at
    compaction excludes custom_message entries, but the memory injection is a raw
    `userMsg()` in the context hook — pi's `convertToLlm` gives it role user. Any other
    consumer (checkride "find the LAST message written by the user" probe, future pi
    features, the model itself) can mistake memory for the live request. The probe question
    literally asks for the last user message while memory sits below it.
  - Cache: the block is byte-identical between requests only if the file didn't change —
    but its position (always last) means every new turn inserts content *before* it,
    which is cache-compatible... except the tool-clearing tier above it rewrites earlier
    messages when the threshold crosses, invalidating the prefix anyway. Timestamps: pi's
    convertToLlm drops timestamps from the wire for llama.cpp-style APIs (no cache impact
    measured), but ordering cost is real.
- Fix: inject memory BEFORE the latest real user message (or as a system-prompt section);
  keep bytes stable; label it explicitly as state, not instruction (already partly done).

### F8 (P2, VERIFIED) Memory writes are not atomic and not scoped
- `pi/index.ts:764-777`: `writeFileSync` in place — a crash mid-write corrupts memory.md
  (no tmp+rename). No versioning, no timestamps, no source references, no detection of a
  stale Next vs newer user correction (relies on STALE_INTENT_NOTE only for summaries, not
  memory). Repo-controlled file injected as trusted state = prompt-injection channel when
  cloning untrusted repos (memory.md travels with the repo if committed).
- Fix: atomic write (tmp+rename), guard against symlinks, add Updated timestamp line;
  keep the format otherwise (simplicity is a feature).

### F9 (P2, VERIFIED) session_compact entry lookup + fromHook interactions
- pi looks up the persisted compaction entry **by summary string equality**
  (`agent-session.ts:1956,2281`) — two identical summaries → wrong entry handed to
  `session_compact`. Mempact summaries can collide (e.g. "Context window cleared via
  new_context." is a constant!). Every `new_context` reset after the first hands back the
  FIRST reset's entry; window-chain restore reads the wrong details. VERIFIED by code
  inspection; live repro straightforward.
- Also: pi never reads file-tracking back from `fromHook:true` compactions, so mempact must
  (and does) carry its own lists — but if pi's built-in compaction ever runs between mempact
  compactions (fallback path!), pi's `details` shape (`readFiles/modifiedFiles` at top level)
  is different from mempact's (`details.mempact.*`) and **neither reads the other** —
  cumulative file lists silently reset across a fallback compaction.
- Fix: make the constant new_context summary unique (append window id); on session_compact,
  re-derive the entry from the branch tail instead of trusting the event; merge pi-shaped
  `details.readFiles/modifiedFiles` when the previous compaction is `fromHook:false`.

### F10 (P2, VERIFIED) firstKeptEntryId sentinel relies on undefined pi behavior
- mempact returns `firstKeptEntryId: "mempact:none"` (a non-existent id). In
  `buildContextEntries` this means `foundFirstKept` never flips → zero pre-compaction
  entries kept — which is exactly what mempact wants, but it is an **accident of the
  fallthrough**, silent-data-loss path in pi (no error, no contract). Format 4 removes
  `firstKeptEntryId` entirely (retainedTail). Isolate behind an adapter now; when pi
  coding-agent migrates, supply `retainedTail` instead.

### F11 (P2, VERIFIED) Checkride quizzes a reconstruction, not the actual assembly; grading gaps
- The quiz context (`pi/index.ts:446-466`) is retained-users + bridge + memory + questions —
  missing the system prompt and any custom messages that will actually be present; close but
  not "the ACTUAL post-compaction context".
- Containment grading with cross-question credit (`core/checkride.ts:235-247`): an answer
  listing a filename under the wrong question passes `files`; SUCCESS_WORDS include
  "pass"/"done"/"created" which appear in unrelated text (e.g., a command string containing
  "test" + the word "passed" anywhere); an old error quoted from history satisfies `error`
  even after a newer successful run — though `extractRunFacts` correctly nulls lastError when
  the newest result is clean (good), the ANSWER can still cheat.
- No continuity probes (perform-next-step, don't-redo, respect-correction, retrieve-old-result).
- Quiz max_tokens 700 with a thinking-enabled local model risks empty answers → all probes
  fail → pointless retry + splice (cost). Live config note: serve-model default reasoning
  xhigh would break every checkride; must run reasoning off/low or request
  `chat_template_kwargs: enable_thinking:false` per-request.
- Fix: keep deterministic grading (strength), add negative guards (error probe must fail if
  answer contains "no unresolved error"-class statements... keep simple), add continuity
  probes as a separate eval (not gating), send `enable_thinking:false` on quiz calls when
  provider is llama.cpp-like, raise quiz budget.

### F12 (P2, VERIFIED) Compatibility matrix mempact 0.2.0 vs pi 0.84.2
| Item | Status |
|---|---|
| `session_before_compact` return shape | OK (new `reason`/`willRetry` read-only additions) |
| `context` hook / `compactionSummary` role | OK (structuredClone copies; identity compares fail — mempact doesn't rely) |
| `tool_result` persistence semantics | OK (still pre-persistence) |
| `pi-ai complete` | **BROKEN types / runtime via legacy bundle** (F5) |
| `getApiKeyAndHeaders().headers` | **CHANGED**: `Record<string,string\|null>`; must strip nulls before fetch (mempact passes to pi-ai complete — which handles? verify; also new `baseUrl` field mempact ignores → proxy users misroute) |
| `getContextUsage()` | `tokens: number\|null`; mempact guards `usage?.tokens == null` — OK |
| `session_compact_failed` | NEW — mempact doesn't subscribe; `compacting` flag can stay stale on failure (live-verified: failed compaction left trigger looping) |
| `hasUI` semantics | CHANGED (true in RPC now) — cosmetic for mempact |
| `usage` on CompactionEntry | mempact doesn't pass → summarization cost invisible |
| Extension load order | unsorted readdir; last-truthy-wins — mempact cannot assume precedence |
| Format 4 / retainedTail | FUTURE BREAK (F10) |
| `ctx.compact()` aborts in-flight run | root of F2 |

### F13 (P2, VERIFIED) Codex drift since rust-v0.142.5 that changes the "port fidelity" story
- Unchanged & safe to keep: 20k retained-user budget, SUMMARY_PREFIX, prompt templates
  byte-identical, front-trim retry, 90% rule, 10KB×1.2 record-time cap **as a model-visible
  policy**.
- Changed upstream, relevant here:
  - `new_context` now produces a summarizing compaction (unless TokenBudget feature) —
    mempact's no-summary reset now diverges from current Codex (keep mempact's, it's better
    for local use, but stop calling it "codex verbatim").
  - `Feature::AutoCompaction` removed → compaction unconditional; full context window is a
    hard cap in Total scope too (+ fallback buffer). Minor trigger-math drift.
  - Codex added a **soft pre-compaction wrap-up prompt** (`AutoCompactFallbackPrompt`)
    consuming a buffer before rollover — validates mempact's reminder+flush design.
  - Codex added server-side history/notes recall tools (window-list/read/search with strict
    budgets) — validates the two-stage recall design; not portable, reimplement locally.
  - World-state persistence (`RolloutItem::WorldState` full snapshot at every compaction
    boundary) — validates mechanical world-state carriage; mempact's staples are the local
    analog.

### F14 (P3, VERIFIED) Minor
- `test/handoff-eval.ts` quiz calls use 900 max_tokens (see F11 thinking caveat).
- `recall` `[entry N]` indexes shift as session grows (newest-first reversal is fine but N
  is computed pre-reversal — stable within a call only).
- `clearOldToolOutputs` counts *all* toolResults incl. already-stubbed ones — stable, fine;
  but a recall tool result is itself a toolResult and will be stubbed 3 tool-calls later —
  recall lifecycle survives the immediate next step (OK) but not three (acceptable; document).
- Memory `renderForContext` tail-caps sections at 20 lines — Decisions overflow silently
  elided from context with pointer to file the model cannot read via recall (memory.md is
  not in session history; model must use `read` tool — description says file path, OK).

## DeepSeek invariants worth borrowing (not the plugin architecture)
1. Spill-first with reserve-priced notice: preview budget = cap − worst-case notice size;
   final check subsumes shrink guarantee. (Direct blueprint for F1 fix.)
2. Fail-open on spill failure — never turn a successful tool call into an error.
3. Search/read/trace separation with per-result provenance (session, seq, type,
   current|shadowed|log-only, time, snippet).
4. Replacement ops cite every shadowed source (`sourceEventSeqs ⊇ shadowed`).
5. Deterministic pruning before summarization; remeasure; skip summarization if pruning
   relieved pressure (mempact's clearing tier is per-request-only and doesn't feed the
   trigger; consider counting cleared savings before compacting).
6. Framed-summary shrink validation (reject summary ≥ shadowed content).
7. Crash closers: distinct TOOL_NOT_STARTED vs TOOL_OUTCOME_UNKNOWN messages ("do not retry
   blindly") — belongs in mempact's bridge text for open tool calls at compaction time.

## Phase 4 — Target architecture (smallest sufficient change set)

Keep: pi JSONL as the canonical log (append-only in practice); mempact's mechanical staples,
checkride, memory file format, demotion-not-deletion clearing tier.

Add (in priority order):
1. **Spill-first full-output retention** (`core/spill.ts` + hook change): in `tool_result`,
   if the (already pi-truncated) text exceeds the cap, write the full text to
   `.mempact/spill/<sessionId>/<toolCallId>-<n>.txt` (0700/0600, tmp+rename, sha256 recorded),
   then emit the codex-shaped preview PLUS a locator line
   `[mempact: full output N bytes sha256:… stored at <path>; recall or read can retrieve]`.
   Fail-open. `.mempact/.gitignore` auto-written. Optionally also capture pi's
   `details.fullOutputPath` (bash) since pi's 50KB cut happens upstream of the hook.
2. **Two-stage recall** (`recall` v2): `mode: search|read`, `scope: active|all`, results
   carry stable pi entry ids + role/tool/timestamp + origin tag
   (original|summary|memory|spill), `read` returns exact entry content (offset/limit) or
   spill file slices. Search includes spill artifacts (grep).
3. **Trigger hardening**: pi-ai `isContextOverflow` (feature-detected); print-mode guard;
   "Nothing to compact" backoff; `session_compact_failed` subscription resetting
   `compacting`.
4. **Memory ordering + atomicity**: inject before the last real user message; tmp+rename
   writes; Updated timestamp.
5. **Checkride upgrades**: unique summaries (window id suffix), quiz thinking-off kwargs,
   optional continuity probes in the eval harness (not gating).
6. **Compat adapter**: `pi/compat.ts` isolating `complete` import, headers null-stripping,
   firstKeptEntryId/retainedTail seam.

Migration: old sessions unchanged (recall v2 reads both; missing spill = "pre-audit result,
middle may be unrecoverable" provenance note). memory.md format unchanged.

## Phase 5/6 — implemented changes and benchmark results

(appended below as work completes)
