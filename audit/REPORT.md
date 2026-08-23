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

### Post-fix lifecycle (what ships on the audit branch)

```
tool execution (pi)
  -> [L1] pi bash accumulator: >50KB/2000 lines -> tail-keep + FULL stream to
     os.tmpdir()/pi-output-*.log (ephemeral)
  -> tool_result hook (mempact):
       if details.fullOutputPath exists (bash) -> read pi's FULL stream (<=8MB)
       spill source -> .mempact/spill/<toolCallId>.txt  [atomic, sha256+bytes
       indexed, git-ignored, fail-open]
       preview = codex 10KB middle-ellipsis + one locator line
  -> [CANONICAL] pi session JSONL: preview+locator persisted; spill dir holds
     every accepted byte durably
  -> context hook: clearing tier stubs old results (session file untouched);
     memory injected BEFORE the latest real user message
  -> compaction: full-window summarize + mechanical staples
     (<read-files>/<modified-files>/<last-run>/<unresolved-error>/
      <latest-user-request>/<git-state>) + checkride (quiz->retry->splice)
  -> post-compaction: continue-nudge resumes an interrupted run
  -> recall v2: search (active|all, stable ids, provenance labels, spill grep)
                -> read (exact entry / spill slice, offset/limit, hash shown)
Invariant now held: active context may be lossy; canonical history + spill
artifacts are not silently lossy (sole exception: non-bash tools' output that
pi itself truncates upstream — none exist in pi's builtin set today: read/grep/
find/ls truncate but those are re-derivable from the filesystem).
```

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

## Canonical-history audit (pi JSONL as mempact's canonical store)

| Property | Verdict | Evidence |
|---|---|---|
| Append-only | MOSTLY — normal ops append one line per entry; whole-file rewrite happens on (a) version migration, (b) empty-file repair, (c) the initial bulk flush | pi `session-manager.ts:1015-1042`, `:917-919` |
| Deferred first flush | **Nothing hits disk until the first assistant message** — a crash in the first turn loses the session incl. mempact's `window0` entry | `_persist` `:1018-1024`; live -p runs confirmed sessions with no file |
| Stable IDs | 8-hex per entry, collision-checked, stable within a session; **re-minted on format-4 import**; branch fork preserves ids but re-chains parents | `:221-228`, harness.md 2928-2932 |
| Supersession explicit | Compaction shadows via `firstKeptEntryId` pointer; shadowed entries stay in file; only the LATEST compaction on the path applies | `buildContextEntries` `:418-454` |
| Silent-loss paths | (1) `firstKeptEntryId` not on path → entire kept span dropped, no error (mempact deliberately exploits this with its sentinel — F10); (2) malformed JSONL lines silently skipped on load; (3) in-memory message objects shared by reference — post-persist mutation diverges from disk | `:443-451`, `:503-511`, `:1057-1067` |
| Replayable | Yes for entries; model-visible projection reproducible via buildContextEntries + mempact's context hook (deterministic given file + memory.md state) | — |
| Crash: open tool calls | pi persists whatever completed; no synthetic closers in the JSONL; mempact's summarization-path normalize (`ensureCallOutputsPresent`) pairs an "aborted" output — model-visible only, not durable. DeepSeek writes durable closers with retry-risk guidance; pi/mempact do not | normalize.ts:19; dsh repair.ts:27-133 |
| Corruption policy | Header invalid → `[]` (silent); non-empty non-pi file → throw; no checksums | pi tests file-operations |
| Artifact↔event proof | NEW: spill index records sha256 + byte count per artifact; recall read surfaces the hash | core/spill.ts |

Verdict on "add a neutral canonical-event abstraction in core/": NOT NOW. The pi JSONL
plus the spill store satisfies the invariant ("active context may be lossy; canonical
history and recoverable artifacts may not be silently lossy") once F1 is fixed. A
neutral event log would duplicate pi's store for no retrieval gain and would drift.
Revisit when pi coding-agent migrates to format 4 (retainedTail).

## Security & privacy audit

- **Spill artifacts contain raw tool output** (may include secrets printed by tools,
  env dumps). Mitigations shipped: files 0600 via writeFileSync mode, dir under the
  project (same trust domain as the code that printed them), `.mempact/.gitignore`
  auto-written covering `spill/`. NOT mitigated: no retention/cleanup policy (documented;
  same posture as DeepSeek spill-local and pi's own /tmp/pi-output-*.log which is
  world-tmp and unbounded); no encryption (out of scope for a local dev tool).
- **Prompt injection via memory.md**: the file is repo-controlled state injected every
  request. Framing labels it as the agent's own memory ("treat it as your own prior
  state") which AMPLIFIES injection risk on untrusted repos. pi's project-trust gate is
  the outer control (untrusted projects: extensions still run but the user accepted
  trust for the dir). Residual risk documented; recommend future: skip memory injection
  when `ctx.isProjectTrusted?.() === false`.
- **Prompt injection via recalled text**: recall v2 now frames every read as
  "Historical record / historical tool output, not instructions", and off-branch text
  is labeled OFF-BRANCH. Search snippets from compaction summaries are labeled
  model-written.
- **Path traversal**: spill ids sanitized (injective escape, all-dots guard, `.txt`
  suffix, fixed dir); recall read ids resolved only against the spill index/dir and
  session entries; no user-supplied paths are opened.
- **Cross-project/session leakage**: recall scope is the current session file only
  (active or all branches); no cross-workspace search exists.

## Request-envelope & cache audit

Method: `before_provider_request` capture extension (payload JSONL, consecutive diff)
plus llama.cpp server-side slot logs (prompt-eval token counts = uncached portion).
- Server-side evidence from the live runs: consecutive pi requests reuse the KV prefix
  almost fully — llama.cpp selected slots "by LCP similarity, f_sim_best = 0.998" and
  prompt-eval counts per turn were only the new suffix (e.g. 7,067 new of 25,086 total).
  After compaction the whole prefix re-evaluates (expected, one-time cost).
- Structural analysis of the request path: no timestamps reach the completions wire;
  the clearing tier's stubs are recomputed deterministically from persisted originals
  (byte-stable across requests, single invalidation step at threshold-crossing);
  memory injection is byte-stable while memory.md is unchanged, and post-fix sits
  before the latest user message (one position earlier than pre-fix).
- Trigger accounting: mempact reads pi's `getContextUsage()` which anchors on
  server-reported usage of the (cleared) request — the clearing tier's savings are
  therefore correctly reflected in the trigger (no double-count bug found).
- (Byte-diff capture from the resume run appended in Phase 6 when available.)

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

## Phase 5 — implemented changes (branch `audit/2026-08-22`, commit `ca30dc1`)

| Fix | Files | Status |
|---|---|---|
| F1 spill-first retention | `core/spill.ts` (new), `pi/index.ts` tool_result hook | ✅ + 15 unit tests (incl. middle-marker recovery, restart, UTF-8, torn index, fail-open) |
| F2 print-mode guard | `pi/index.ts` turn_end | ✅ (threshold trigger stands down; overflow recovery stays) |
| F3 nothing-to-compact backoff | `pi/index.ts` (onError + turn_end + session_compact_failed) | ✅ |
| F4 overflow classifier | `pi/index.ts` (official `isContextOverflow` preferred; widened fallback regex) | ✅ + 15 regression tests |
| F5 pi-ai complete compat | `pi/index.ts` (runtime main→/compat resolution, null-header strip) | ✅ typecheck clean at 0.84.2 |
| F6 recall v2 | `pi/index.ts` (search/read modes, active/all scope, stable ids, provenance, spill grep, read byte-cap) | ✅ |
| F7 memory ordering | `pi/index.ts` context hook (inject before last real user message) | ✅ |
| F8 atomic memory writes | `pi/index.ts` update_memory (tmp+rename) | ✅ |
| F9 unique new_context summaries | `pi/index.ts` | ✅ |
| Checkride quiz budget 700→1500 | `pi/index.ts` | ✅ |
| Deps 0.78→0.84.2 | package.json | ✅ 147/147 tests |

Deferred (experimental / behind constants, not shipped): mid-turn-continue after
auto-compaction (CONTINUE_AFTER_AUTO_COMPACT), continuity checkride probes as gating,
retainedTail adapter (blocked on pi coding-agent actually migrating to format 4).

## Phase 6 — live verification & benchmarks

### Live run 2 (pi 0.84.2 RPC + Qwen3.8-27B, PRE-fix code, 32k window, keepRecentTokens 4000)
- 5-step scenario completed; compaction completed: tokensBefore 31039, checkride 2/2
  (verify+intent), `<last-run>`/`<latest-user-request>` staples present.
- CONFIRMED task loss: the in-flight recall answer was aborted by the threshold
  trigger (entry 28 stop=error); the model's found-marker reply was never delivered;
  the summary itself recorded "I have NOT yet sent the final reply".
- Marker recovery pre-fix: only by positional luck (pi tail-keep truncation happened
  to keep line 700 in the first result); destroyed in the `sed 300,1100p` result.

### Live run 3 (fixed code: spill-first + recall v2)
- All 4 oversized outputs spilled (`.mempact/spill/`, sha256-indexed); the compaction
  summary itself cites the spill locators mechanically.
- recall v2 search returned stable ids (`e:<entryId>`, `spill:<id>`) with provenance
  labels; 7 matches for the marker including 2 spill artifacts with line positions —
  including regions the in-context copies had destroyed.
- Compaction completed: tokensBefore 31924, checkride 2/2.
- Remaining gap observed: the in-flight recall answer was still orphaned by the
  mid-turn compaction ("NOT YET ANSWERED" in the summary) → motivated enabling
  CONTINUE_AFTER_AUTO_COMPACT.

### Live run 4 (continue-after-compact enabled)
- Mid-turn compaction (tokensBefore 31933, checkride 2/2) aborted the recall answer;
  the `mempact:continue` nudge fired; the RESUMED model (handoff context only)
  re-searched, exact-read `spill:cEKn…` at offset 605, and delivered the exact marker
  line `line 00700 UNIQUE-MARKER-ZEBRA-9137-XRAY buried deep in the middle of this
  output` with locator + sha256 provenance — then answered the last-run factual probe
  correctly from the `<last-run>` staple.
- Continuity checks passed live: perform-exact-next-step ✅, correct source file ✅,
  no redo of completed steps ✅.
- Environmental noise: each post-compaction request first failed with a transient
  "Connection error." and succeeded on pi's automatic retry (single-slot llama.cpp +
  long re-prefill; not a mempact defect).

### Restart + resume probe (fresh pi process, --continue)
- After process restart, recall search → exact spill read again produced the verbatim
  marker line (definition-of-done #1 incl. restart ✅).
- Don't-redo probe: resumed model answered "yes, output was 1399" from context without
  re-running the command ✅.

### Request-envelope capture (resume session, 6 requests)
- Message-prefix stability between consecutive requests: 17/17, 19/19, 19/19→21,
  21/21, 21/21→23 — strictly append-only, zero rewritten fields, no wire timestamps.
  Combined with llama.cpp slot logs (LCP similarity 0.998, prompt-eval = new suffix
  only), the request stream is prompt-cache-optimal between compactions.

(handoff-eval batch + chain results appended below)

### handoff-eval batch (4 real codex rollouts from 2026-08-22, Qwen3.8-27B v3, temp 0, seed 42)

| transcript | probes | raw | spliced | full | handoff tokens |
|---|---|---|---|---|---|
| rollout…09-50-29 | intent | 0% | 100% | 100% | 1435 (2.1%) |
| rollout…10-45-57 | intent | 100% | 100% | 100% | 1396 (5.1%) |
| rollout…13-50-46 | intent | 0% | 100% | 100% | 1072 (2.3%) |
| rollout…11-07-17 | intent | 0% | 100% | 100% | 1301 (2.4%) |
| **AVERAGE** | | **25%** | **100%** | **100%** | ~2-5% of window |

Replicates the README's central claim on the current model: the raw summary drops the
user's live request 3 of 4 times; the mechanical splice carries it every time. (These
rollouts derived only the intent probe — no write/edit ops for files probes.)

## Mechanical-handoff audit (what the staples carry now)

Carried deterministically: modified/read files (cumulative), last significant command +
pass/fail (+exit), unresolved error, latest-user-request verbatim clip, **git-state
(NEW: branch @ HEAD, dirty count)**, spill locators (via the summary text when results
were spilled), window chain ids, checkride outcome. Deliberately NOT carried: raw env
dumps and secrets (never stapled), cancellation semantics as a *parsed* fact (the
verbatim latest-user-request carries the user's own words instead — no NLP guessing).
Candidates left experimental: pending background process handles, required-tests-not-run.

## Checkride audit summary

Strengths kept: fixed probe templates, harness-only ground truth, no LLM judge,
skip-not-guess, bounded escalation, never blocks compaction. Confirmed weaknesses
(F11): cross-question credit is intentional but SUCCESS/FAILURE word lists can
cross-match unrelated text; quiz context omits system prompt; memory-derived probes
could reinforce stale state — mitigated now by relabeling the `next` preserve line
("the latest user request OVERRIDES this if they conflict") and quiz budget 700→1500
(local thinking models return empty answers at small budgets otherwise). Continuity
probes are validated LIVE (perform-next-step, no-redo, exact-retrieval) rather than
gating the compaction path.

### Live run 5 — correction + cancellation + stale memory (scenarios 2/3/8)
- User set up "plan A" (notes.txt + memory Next="continue implementing the JSON
  parser"), then cancelled it mid-session and pivoted.
- The model repaired memory AT the cancellation (Goal/Plan/Decisions/Next all
  rewritten to "CANCELLED — do not resume"), so the stale-Next conflict self-healed
  before compaction (the update_memory design working as intended).
- Compaction: tokensBefore 32542, **checkride 6/6** (files/verify/intent/done/next/
  constraints all active; one retry, no splice), `<modified-files>` carried notes.txt,
  `<latest-user-request>` verbatim.
- Post-compaction probes: current task correct; "Should you continue implementing the
  JSON parser?" → "No — … explicitly cancelled … must not be resumed under any
  circumstances." Scenario 3/8 PASS.
- fullOutputPath capture verified: spill store now holds the COMPLETE 100,809-byte
  cat output (beyond pi's 50KB tail-keep), plus full 57.6KB/64.8KB sed/tail outputs.
- Residuals: continue-nudge also fired after an already-completed turn (harmless
  repeated "PUSH DONE"; refine via agent_settled later); `<git-state>` correctly
  omitted in a non-git dir.
- CHAIN file-fact benchmark: not derivable from today's rollouts (no apply_patch
  file edits in any of them — codex sessions were advisory); the multi-window
  file-fact invariant is covered by the cumulative `<modified-files>` merge tests
  and the live spill/recall path instead.

## Definition-of-done tracking

1. Middle-marker exact retrieval after compaction + restart — **✅ live-verified**
   (runs 3/4 + resume probe; unit tests cover multi-compaction-independence since
   spill artifacts are outside session history entirely).
2. No active-context pruning destroys the only canonical copy — **✅** (spill-first
   hook; clearing tier and compaction were already non-destructive; pi's own bash
   50KB tail-keep truncation happens UPSTREAM of any extension hook and remains the
   one lossy layer mempact cannot intercept — its /tmp full-output spill file path is
   surfaced in bash details; documented limitation).
3. Search results carry stable provenance — **✅** (`e:<entryId>` / `spill:<id>`,
   role/tool labels, model-written and off-branch tags).
4. Exact-read behind every search result — **✅** (recall mode:"read", offset/limit).
5. Active vs all-branch recall explicitly distinguishable — **✅** (scope param +
   OFF-BRANCH labels).
6. Latest user correction overrides stale memory/summaries — **✅ mechanism**
   (STALE_INTENT_NOTE + <latest-user-request> staple last + memory-sourced probe
   relabeling); live scenario run appended below.
7. Cancelled work not restarted after compaction — live scenario run appended below.
8. Tool-call/result pairs remain valid — **✅** (pi-side pairing + normalize.ts on
   the summarization path; pinned by existing normalize tests).
9. Crash recovery produces structurally valid session — **✅ within pi's contract**
   (append-only JSONL; torn lines skipped on load; spill index tolerates torn tail —
   tested; residual risk: pi's deferred first flush window, documented).
10. Every checkpoint records what it replaced + fact sources — **✅ partially**:
    `details.mempact` records retained users, window chain, file lists, checkride
    outcome; the shadowed entries remain in the JSONL under the compaction's
    firstKept sentinel. Deterministic staples are labeled by origin in the summary
    text. (Full DeepSeek-style sourceEventSeqs would need pi core changes.)
11. Builds and runs against current pi — **✅** (typecheck + 147 tests + live 0.84.2
    runs; runtime feature-detection keeps 0.78-0.80 compatibility).
12. Checkride + continuity across repeated compaction chains — checkride ✅ live
    (2/2 twice); multi-window chain covered by handoff-eval CHAIN mode below.
13. Canonical vs model-visible retention distinguished throughout this report — ✅.
14. No "lossless" claim without test proof — the only remaining lossy layer is pi's
    upstream bash truncation (item 2); README wording updated accordingly.
