<p align="center">
  <img src="assets/banner.png" alt="mempact — context-compaction engine ported from OpenAI Codex" width="100%">
</p>

<p align="center">
  <a href="reference/PIN.md"><img alt="ported from openai/codex rust-v0.142.5" src="https://img.shields.io/badge/ported%20from-openai%2Fcodex%20rust--v0.142.5-c53a1f"></a>
  <img alt="core: zero runtime deps" src="https://img.shields.io/badge/core-zero%20runtime%20deps-201b15">
  <img alt="tests: 113 passing" src="https://img.shields.io/badge/tests-113%20passing-201b15">
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-201b15">
</p>

# mempact

A faithful TypeScript port of the OpenAI Codex CLI **compaction engine**
(internal codename "Memento"), packaged as:

- **`core/`** - a zero-runtime-dependency library, transliterated
  function-by-function from the Rust source with constants, algorithms, and
  prompts copied verbatim. Every function cites its Rust origin
  (`codex-rs/<file>:<line>`).
- **`pi/index.ts`** - a [pi coding agent](https://github.com/badlogic/pi-mono)
  extension that runs the exact codex compaction behavior inside pi.

Provenance: [openai/codex](https://github.com/openai/codex) @ tag
`rust-v0.142.5`, commit `26de83050b20f7e0ee211b9739e52ae00ce8032a`,
Apache-2.0. The relevant Rust sources are vendored unmodified under
`reference/` (see `reference/PIN.md`); `test/` ports codex's own test cases,
several with byte-exact expected strings.

## What the engine does (codex behavior, replicated)

1. **Ingestion cap** (always on): every tool output is middle-ellipsis
   truncated to 10,000 bytes (x1.2 serialization slack) the moment it is
   recorded, so no single item can blow up the context.
2. **Token-budget reminder**: one-shot model-visible warning per context
   window when tokens-until-compaction crosses a threshold.
3. **Compaction** at `min(configured, contextWindow * 9/10)` tokens: the
   session's own model writes a handoff summary (the verbatim codex
   "CONTEXT CHECKPOINT COMPACTION" prompt); replacement history becomes
   up to 20,000 tokens of recent **real user messages** (newest-first
   selection, oldest middle-truncated) plus the summary - prefixed with the
   verbatim codex "Another language model started to solve this problem..."
   bridge - **always last**. If the summarization request itself overflows,
   history is trimmed from the front one message at a time (tool-call pairs
   removed together) to preserve the prompt-cache prefix.
4. **`new_context` tool**: the model can call a tool that wipes history
   entirely with NO summary (codex's voluntary hard reset).
5. **Window chain**: every compaction advances
   `(windowNumber, firstWindowId, previousWindowId, windowId)` with
   time-ordered UUIDv7s, persisted in the session and restored on resume.

Portable learnings from codex's remote (server-side) compaction - the
64k-token retained-message budget, tail-first tool-output stubbing, and the
compacted-history post-filter - are ported in `core/remoteRetention.ts`.
The server contracts themselves (`POST responses/compact`,
`CompactionTrigger` sentinel) need OpenAI's backend and are not ported.

## Beyond the port: research-backed additions

All of these sit AROUND the codex base, are non-destructive, and can be
disabled to get the pure port back:

1. **Mechanical tool-output clearing** (`core/toolClearing.ts`; Anthropic
   context-editing lineage - clearing stale tool results mechanically beats
   summarizing them). Once context crosses `0.7 x` the compaction limit
   (~63% of the window), tool outputs older than the newest 3 are stubbed
   per-request to their first line. The session file keeps the originals and
   the tool call (name, args) stays visible, so facts survive - only prose
   goes. Zero LLM cost; delays the expensive summarization compaction.
   Knobs: `CLEAR_TOOL_OUTPUTS_AT_FRACTION` (null disables),
   `KEEP_RECENT_TOOL_RESULTS` in `pi/index.ts`.
2. **Project memory** (`core/memory.ts`; Letta/MemGPT memory-block lineage).
   A plain markdown file at `.mempact/memory.md`
   (Goal/Plan/Decisions/Files/Next/Open) the model maintains via the
   `update_memory` tool. It is injected fresh from disk as the last message
   of every request, so it is never part of compacted history - it survives
   compaction and restarts by construction. The injected render strips hint
   comments and tail-caps long sections; the file keeps everything. No file,
   no overhead: nothing is injected until the model (or you) writes one.
3. **`recall` tool** (`core/recall.ts`; Claude Code microcompaction / Cursor
   "context as files" lineage). Searches the full append-only session
   history - including compacted-away turns and cleared tool outputs - so
   clearing and compaction are demotions, never deletions. Cleared stubs
   point the model at it.
4. **Deterministic fact splices** (`core/fileOps.ts` + `runFactsBlock`; pi
   lineage). Read/modified file paths (merged cumulatively across
   compactions, capped at 40 each) plus the last significant command with
   its outcome and any unresolved error are extracted mechanically from
   toolCalls and appended to every summary as
   `<read-files>`/`<modified-files>`/`<last-run>`/`<unresolved-error>`.
   File state is the worst-measured summarization failure (Factory probe
   eval ~2.2/5); our sweep showed the same for run state (4/11 when left
   to the summarizer, ~100% spliced) - both fixed at zero LLM cost.
5. **Stale-intent guard** (Hermes lineage). One fixed note appended AFTER
   the verbatim codex bridge telling the model the summary is reference,
   not instructions - the recurring cross-agent failure is summaries
   hijacking behavior, not information loss. The codex prompt itself is
   never modified.
6. **Pre-compaction memory flush nudge** (OpenClaw lineage). When a memory
   file exists, the one-shot token-budget reminder also instructs the model
   to persist durable state via `update_memory` before compaction hits.
7. **Anti-thrashing guard** (Hermes lineage). If the last two compactions
   each freed <10%, the auto trigger pauses with a warning instead of
   looping; manual `/compact`, overflow recovery, and `new_context` stay
   live.
8. **The handoff checkride** (`core/checkride.ts`) - closed-loop compaction,
   which no other system does. Every compaction summary is quizzed against
   facts the harness knows deterministically (modified files, last command
   + exit, the user's latest request, memory state), graded by mechanical
   string containment - no LLM judge. Fail once: the summary is regenerated
   with MUST-PRESERVE lines. Fail twice: the facts are spliced in verbatim,
   no model cooperation needed. Compaction is never blocked; the score is
   persisted per compaction (`/mempact` shows it). Probe templates, ground
   truth, and grading are all fixed harness-side, so an arbitrarily weak
   model can run the process safely - it never authors a rule.

   Measured with `test/handoff-eval.ts` (accepts Claude Code transcripts
   AND codex rollout files, format auto-detected, any OpenAI-compatible
   endpoint) on a real 27B local model (Qwen3.6 NVFP4) over ~70k-token
   slices of 7 real coding sessions (4 Claude Code, 3 codex): raw summary
   alone averaged **5%** of probes, + mechanical splices 33%, full mempact
   assembly 62% first-try, and the MUST-PRESERVE retry lifted most sessions
   to **100%**. The full handoff consistently measured 1.1-2.9k tokens -
   1.7-4.2% of the window content it replaced.

## Installing the pi extension

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/home/topmass/Code/mempact/pi/index.ts"],
  "compaction": { "enabled": false }
}
```

`compaction.enabled: false` disables only pi's built-in *trigger*; `/compact`
and `ctx.compact()` keep working and route through mempact's
`session_before_compact` hook, which takes over **all** compaction. The
extension triggers automatically at the codex 90% threshold from `turn_end`.

Config knobs are module constants at the top of `pi/index.ts`
(`CONFIGURED_TOKEN_LIMIT`, `REMINDER_THRESHOLD_TOKENS`,
`CONTINUE_AFTER_AUTO_COMPACT`). `/mempact` shows the live window chain and
trigger status.

### How the pi mapping works

pi persists compaction as a `CompactionEntry { summary, firstKeptEntryId }`
and renders it summary-FIRST; codex wants the summary LAST. mempact:

- returns a sentinel `firstKeptEntryId` so pi keeps zero raw entries, and
  stores the codex replacement layout (retained user messages + window
  chain) in `CompactionEntry.details.mempact`;
- registers a `context` handler that swaps pi's `compactionSummary` message
  for the exact codex layout on every request (byte-stable, cache-friendly);
- caps tool outputs via the `tool_result` hook (persisted before recording);
- restores window chain and reminder state from the session JSONL on
  `session_start`.

### Known deviations from codex (pi API limits)

1. **Mid-turn auto-resume**: codex resumes the interrupted turn after
   mid-turn compaction; pi's `compact()` aborts the agent loop. Optional
   continuation nudge behind `CONTINUE_AFTER_AUTO_COMPACT` (default off).
2. **Initial-context reinjection** collapses: pi's system prompt lives
   outside the transcript and is re-sent every request.
3. **Images in retained user messages** are represented by their text parts
   only (codex retains them as content items).
4. **Intra-turn token counts** use the chars/4 heuristic between server
   usage reports - the same class of approximation codex makes.

## Using core/ standalone

```ts
import {
  SUMMARIZATION_PROMPT, SUMMARY_PREFIX,
  buildCompactedHistory, collectUserMessages,
  autoCompactTokenLimit, runCompactionWithRetry,
  processItem, DEFAULT_TRUNCATION_POLICY,
} from "./core/index.ts";
```

`core/` has no runtime dependencies and no pi imports; it operates on a
neutral `HistoryItem` model mirroring codex's `ResponseItem` (`core/items.ts`).
Adapt your host's message type to it and you get the full engine.

## Development

```bash
pnpm install
pnpm test        # 78 vitest cases, incl. byte-exact codex parity assertions
pnpm typecheck
```
