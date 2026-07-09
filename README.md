<p align="center">
  <img src="assets/banner.png" alt="mempact - verified context compaction for coding agents" width="100%">
</p>

<p align="center">
  <img alt="tests: 116 passing" src="https://img.shields.io/badge/tests-116%20passing-201b15">
  <img alt="core: zero runtime deps" src="https://img.shields.io/badge/core-zero%20runtime%20deps-201b15">
  <a href="reference/PIN.md"><img alt="base engine: openai/codex rust-v0.142.5" src="https://img.shields.io/badge/base%20engine-openai%2Fcodex%20rust--v0.142.5-c53a1f"></a>
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-201b15">
</p>

# mempact

**Verified context compaction for coding agents.** A zero-dependency
TypeScript engine that folds long sessions the way OpenAI Codex does,
carries the load-bearing facts mechanically, and - unlike every other
system we could find - **tests each handoff before trusting it**. Ships as
a library (`core/`) and as a drop-in [pi coding agent](https://github.com/badlogic/pi-mono)
extension that hot-swaps pi's default compaction in one settings line.

## The problem

When an agent's context fills up, compaction replaces the conversation
with a summary. That moment is a shift change: everything the next window
knows rides on one model-written note - and no framework checks it.
Measured on real coding sessions, a resuming agent working from a raw
summary alone could answer as little as **5-25%** of basic questions about
its own task: which files did we modify, what did the last test run say,
what did the user ask for. The loss is silent; the first symptom is the
agent confidently redoing or breaking finished work.

## The architecture: three tiers

**1. A proven base, kept verbatim.** The core fold is a faithful port of
the OpenAI Codex CLI compaction engine ("Memento", openai/codex @
rust-v0.142.5, Apache-2.0) - trigger at 90% of the window, keep up to 20k
tokens of recent real user messages, model-written summary bridged LAST,
front-trim retry on overflow, 10KB record-time tool-output caps, window
chaining, and the model-invokable `new_context` hard reset. Function-by-
function transliteration with Rust `file:line` citations and byte-exact
parity tests; the Rust sources are vendored under `reference/`.

**2. Mechanical layers - facts travel by machine, not by prose.** Each has
a research lineage, and none costs an LLM call:

| layer | what it does | lineage |
|---|---|---|
| tool-output clearing | past 0.7x the compact limit, tool outputs older than the newest 3 are stubbed per-request to their first line; session file keeps originals | Anthropic context editing (clearing beat summarization on their evals) |
| fact splices | `<read-files>`/`<modified-files>` (cumulative across compactions) + `<last-run>` + `<unresolved-error>` appended to every summary, extracted from toolCalls | pi's file-op tracking, extended after our sweep showed spliced facts score ~100% vs 36% summarizer-carried |
| project memory | `.mempact/memory.md` (Goal/Plan/Decisions/Files/Next/Open), model-maintained via `update_memory`, injected fresh from disk every request - survives compaction by construction | Letta/MemGPT memory files (Letta killed their DB-backed memory tools for exactly this shape) |
| recall tool | greps the full append-only session history, including compacted turns and cleared outputs - demotion, never deletion | Claude Code microcompaction / Cursor context-as-files |
| stale-intent guard | fixed note after the summary bridge: the summary is reference, the latest user message wins | Hermes (three generations of their prompts died to summary-hijacked behavior) |
| anti-thrash | two consecutive <10%-savings compactions pause the auto trigger instead of looping | Hermes; the failure mode Gemini CLI hits publicly |

**3. The handoff checkride - ours alone.** After the summary is written,
mempact assembles the ACTUAL post-compaction context and quizzes it:
which files were modified? what was the last significant command and did
it pass? what did the user last ask? what's next? Ground truth comes only
from harness data; grading is deterministic string containment - no LLM
judge. Fail once → the summary is regenerated with MUST-PRESERVE lines.
Fail twice → the facts are spliced in verbatim, no model cooperation
needed. Compaction is never blocked, and the score persists with every
compaction entry. Probe templates, truth extraction, and grading are all
fixed engine-side, so an arbitrarily weak local model can run the standard
process safely - it never authors a rule.

This is the inference-time counterpart of what OpenAI bought with
training: GPT-5.1-Codex-Max is "natively trained to operate across
multiple context windows," behind a server-side encrypted blob. mempact
gets handoff reliability by *testing* the handoff instead - open,
model-agnostic, local.

## How other frameworks compare

| system | approach | handoff verified? |
|---|---|---|
| OpenAI Codex (remote) | server-side summary in an encrypted, model- and org-bound blob; compaction-trained model | no - trusted by training |
| Claude Code | microcompaction (tool outputs to disk), auto-compact + structured summary, file re-reads | no |
| Letta | memory files + cheap-model sliding-window summarizer; evicted messages searchable | no |
| Hermes (Nous) | elaborate staged summarization, stale-context framing, anti-thrash | no |
| pi / OpenClaw | structured summary schema, file-op lists, pre-compaction memory flush | no |
| **mempact** | codex base + mechanical fact carriage + memory | **yes - every compaction quizzed, retried, and spliced** |

## Measured results

Methodology: probe-based post-compaction QA (the method Factory used to
compare Anthropic's and OpenAI's compaction), but with deterministic
grading against harness-extracted facts instead of an LLM judge. Test
bed: `test/handoff-eval.ts` replaying ~70k-token slices of **real** coding
sessions (Claude Code project transcripts and codex rollout files, both
parsed natively) against a live local model (Qwen3.6-27B NVFP4,
temperature 0). Three-mode ablation per session:

| handoff shipped to the next window | facts survived (avg, 14+ sessions) |
|---|---|
| summary alone (naive compaction) | **5-25%** |
| + mempact's mechanical splices | 40-67% |
| full mempact assembly, checkride-verified | **~90%, most sessions 100%** |

Other measured numbers:

- **Handoff cost:** 1.1-2.9k tokens carried forward per ~70k-token window
  (under 4%) - a 200k-window agent re-enters at roughly 5-10% full.
- **Window chains:** after TWO consecutive compactions, 7/7 files touched
  only in window 1 were still mechanically present and recalled at 100% in
  window 3. Summary-of-summary systems lose exactly these.
- **Per-probe (before the run-fact splice existed):** mechanically spliced
  facts scored 10/10 across the sweep; summarizer-carried run state scored
  4/11. That gap is why every deterministic fact now travels by machine.
- **Summarizer independence:** in two eval runs the model produced lazy
  77-113 token summaries; the verified assembly still carried 83-100% of
  facts. Handoff quality no longer depends on summarizer diligence.

## Install: hot-swap pi's compaction

`~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/mempact/pi/index.ts"],
  "compaction": { "enabled": false }
}
```

That's the whole install - pi's jiti loader runs the TypeScript directly,
and `compaction.enabled: false` disables only pi's built-in trigger
(manual `/compact` still works and routes through mempact). Everything
above is then live: the codex fold, clearing, splices, memory +
`update_memory`, `recall`, the checkride. `/mempact` shows the window
chain, trigger status, memory state, and the last handoff score. Config
knobs are module constants at the top of `pi/index.ts`; set
`CHECKRIDE_ENABLED = false` or `CLEAR_TOOL_OUTPUTS_AT_FRACTION = null` to
peel layers back to the pure codex port.

Tested against pi 0.78-0.80.x. The extension degrades to silence, never
breakage: no auth, no model, or any checkride error → plain codex
compaction ships.

## Using core/ standalone

`core/` has no runtime dependencies and no pi imports; it operates on a
neutral `HistoryItem`/message model. Adapt your harness's types and you
get the full engine - the fold, the truncation policies, the probes, the
grading:

```ts
import {
  SUMMARIZATION_PROMPT, buildCompactedHistory, collectUserMessages,
  autoCompactTokenLimit, runCompactionWithRetry,          // codex base
  clearOldToolOutputs, collectFileOps, renderFileOps,     // mechanical layers
  buildProbes, formatQuiz, gradeQuiz, runFactsBlock,      // the checkride
} from "./core/index.ts";
```

## Evaluating on your own sessions

```bash
ENDPOINT=http://localhost:8080/v1 node test/handoff-eval.ts ~/.claude/projects/<proj>/<session>.jsonl
# batch mode: pass multiple paths (codex rollouts work too)
# MEMORY_FILE=memory.md exercises the memory-backed probes
# CHAIN=1 runs the two-compaction window-chain test
```

Works with any OpenAI-compatible endpoint and requires Node >= 23.6
(native type stripping), no dependencies.

## Development

```bash
pnpm install
pnpm test        # 116 vitest cases, incl. byte-exact codex parity assertions
pnpm typecheck
```

## Provenance & license

The base engine is derived from [openai/codex](https://github.com/openai/codex)
@ tag `rust-v0.142.5`, commit `26de83050b20f7e0ee211b9739e52ae00ce8032a`,
Apache-2.0 - relevant Rust sources vendored unmodified under `reference/`
(see `reference/PIN.md`), prompts and constants copied verbatim, codex's
own test cases ported. Everything else (the mechanical layers, the
checkride, the eval harness) is original work in this repository, also
Apache-2.0. See `NOTICE`.
