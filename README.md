<p align="center">
  <img src="assets/banner.png" alt="mempact - verified context compaction for coding agents" width="100%">
</p>

<p align="center">
  <img alt="tests: 117 passing" src="https://img.shields.io/badge/tests-117%20passing-201b15">
  <img alt="core: zero runtime deps" src="https://img.shields.io/badge/core-zero%20runtime%20deps-201b15">
  <a href="reference/PIN.md"><img alt="base engine: openai/codex" src="https://img.shields.io/badge/base%20engine-openai%2Fcodex-c53a1f"></a>
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-201b15">
</p>

# mempact

**Verified context compaction for coding agents.** When context fills up,
every framework replaces the conversation with a model-written summary,
and none of them check it. We measured what that summary actually
carries on real coding sessions, with a capable 27B model and strong
prompting: as little as **5% of the checkable facts**. Which files were
changed, what the last test said, what the user asked for. Mostly gone,
silently. mempact fixes this two ways: the load-bearing facts travel
**by machine**, and every handoff is **tested before it ships**.

Zero-dependency TypeScript core for any harness or local model, plus a
drop-in [pi coding agent](https://github.com/badlogic/pi-mono) extension
that hot-swaps pi's default compaction in one settings line.

## What happens as a session grows

<img src="assets/how.png" alt="Fold (codex algorithm), Carry (mechanical fact splices), Verify (the checkride), Continue" width="100%">

**From the first message.** Every tool output is capped at 10KB the
moment it is recorded (codex's rule, kept verbatim), so no single command
dump can flood the window. If a `.mempact/memory.md` exists, it is
re-injected fresh from disk into every request, so it structurally cannot
be compacted away. Everything ever recorded stays on disk, and a `recall`
tool can grep it back at any time. Demotion, never deletion.

**At about 63% of the window.** Old tool outputs go on a diet: every
tool result older than the newest 3 is stubbed down to its first line
plus a pointer to `recall`. This is Anthropic's finding (mechanically
clearing tool results beats summarizing them) applied non-destructively;
the session file keeps the originals. Less noise for the model, and the
expensive compaction gets postponed, sometimes past the end of the
session entirely.

**Near the limit.** A one-shot reminder fires (codex verbatim), and if a
memory file exists the model is told to persist anything durable NOW via
`update_memory`. Flush before discard (OpenClaw's invariant).

**At 90%: the compaction itself.** A pipeline:

1. The session's model writes a handoff summary using codex's verbatim
   "CONTEXT CHECKPOINT COMPACTION" prompt, with codex's front-trim retry
   if the request overflows.
2. Code, not the model, staples the facts onto that summary, extracted
   from the actual tool-call records: `<modified-files>` and
   `<read-files>` (cumulative across every past compaction),
   `<last-run>` with the command and its result, `<unresolved-error>`,
   and `<latest-user-request>` with the user's last message quoted
   verbatim and labeled.
3. The replacement history is assembled codex-style: up to 20k tokens of
   the newest real user messages, then the stapled summary last, bridged
   with codex's handoff text plus one added guard line: the summary is
   reference, the latest user message always wins (Hermes's hard-won
   lesson; their models kept re-doing cancelled work).
4. **The handoff checkride** runs (see below). Fail: one regeneration
   with explicit MUST-state-these-facts lines. Fail again: the facts are
   pasted in verbatim by code. Compaction is never blocked; the score is
   persisted per compaction. If two consecutive compactions each freed
   under 10%, the auto trigger pauses instead of looping.

The next window opens at roughly 2 to 8% full: recent user words
verbatim, the verified note with its staples, memory freshly injected,
`recall` standing by.

## The test suite

The checkride quizzes a model holding ONLY the assembled post-compaction
context, then grades the answers against facts the engine knows for
certain because it watched the tool calls happen. No LLM judge anywhere:
grading is string containment against a harness-built answer key, so an
arbitrarily weak model can run the process safely.

| probe | question asked | ground truth from | pass rule |
|---|---|---|---|
| files | which files were created or modified? | tool-call records | 80% of paths present (basenames count) |
| verify | last significant command, did it pass? | tool records + exit codes | command token AND correct pass/fail |
| error | quote the unresolved error | newest failing output | distinctive substring present |
| intent | quote the user's last request | the message record | 60% of its distinctive tokens |
| done | name work already finished | memory Plan checkboxes | any completed item matched |
| next | exact next step? | memory Next section | 60% of its distinctive tokens |
| constraints | standing decisions? | memory Decisions | recent decision matched |

Probes with no available ground truth are skipped, never guessed. Every
run scores three versions of the same handoff: the summary alone, the
summary plus mechanical staples, and the full assembly.

**What the testing found.** Across 27 scored runs on real Claude Code
and codex sessions (70k and 160k token slices, Qwen3.6 27B, fixed seed):
the raw summary tier scored 5 to 25%, even though the summarizer was a
capable model using codex's own battle-tested prompt. The middle tier
proved the pattern: facts stapled on mechanically survived at or near
100%, facts left to the summarizer's prose were a coin flip (run state
passed 4 of 11 runs; the user's request was fumbled 7 of 13 even though
it sat verbatim in retained history, because nothing labeled it). Each
time the suite caught a category consistently dying, that category was
promoted into the mechanical tier, and its probe retired into a
regression tripwire: run state went 12 for 12 after its staple, intent
flipped the same way after its label. Full assembly now scores about 90%
first try, and most sessions reach 100% after at most one retry, while a
naive summary gets WORSE as windows grow (25% average at 70k slices, 15%
at 160k). The bigger the context, the more the machinery matters.

| | codex (remote) | Claude Code | Letta | Hermes | pi / OpenClaw | **mempact** |
|---|---|---|---|---|---|---|
| handoff verified? | trained, opaque | no | no | no | no | **every compaction** |

## Measured results

<img src="assets/results.png" alt="facts surviving compaction: summary alone 5-25%, plus splices, mempact verified ~90%; handoff cost ~2k/70k tokens; 7/7 window-1 files recalled after two compactions" width="100%">

Methodology: probe-based post-compaction QA (the method Factory used to
compare Anthropic's and OpenAI's compaction) with deterministic grading
instead of an LLM judge, replaying real session transcripts against a
live local model. Notable: twice the summarizer produced lazy 77 to 113
token summaries and the verified assembly still carried 83 to 100% of
the facts, because handoff quality no longer depends on summarizer mood.
Reproduce on your own sessions:

```bash
ENDPOINT=http://localhost:8080/v1 node test/handoff-eval.ts <session>.jsonl [more...]
# accepts Claude Code project transcripts and codex rollout files
# MEMORY_FILE=memory.md adds the memory-backed probes; CHAIN=1 tests window chains
```

## Install: hot-swap pi's compaction

```bash
pi install git:github.com/topmass/mempact
# or try it for one session without installing:
pi -e git:github.com/topmass/mempact
```

Then hand compaction timing fully to mempact in
`~/.pi/agent/settings.json` (mempact warns until you do):

```json
{ "compaction": { "enabled": false } }
```

That's the whole install. `/mempact` shows the window chain, memory
state, and last handoff score. Knobs are module constants at the top of
`pi/index.ts` (`CHECKRIDE_ENABLED`, `CLEAR_TOOL_OUTPUTS_AT_FRACTION`,
...) and peel back to the pure codex port. Degrades to silence, never
breakage: no model, no auth, or any checkride error means plain codex
compaction ships. Tested against pi 0.78-0.80.x.

## Standalone core

`core/` has no runtime dependencies and no pi imports. Adapt your
harness's message types to its neutral model and you get the fold, the
truncation policies, the staples, and the checkride:

```ts
import {
  buildCompactedHistory, runCompactionWithRetry,       // codex base
  clearOldToolOutputs, collectFileOps, runFactsBlock,  // mechanical layers
  buildProbes, formatQuiz, gradeQuiz,                  // the checkride
} from "./core/index.ts";
```

## Development

```bash
pnpm install && pnpm test   # 117 vitest cases, incl. byte-exact codex parity
```

Base engine derived from [openai/codex](https://github.com/openai/codex)
@ `rust-v0.142.5` (Apache-2.0), Rust sources vendored under `reference/`,
prompts and constants verbatim. The mechanical layers, checkride, and
eval harness are original to this repo. Apache-2.0 throughout.
