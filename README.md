<p align="center">
  <img src="assets/banner.png" alt="mempact - context compaction for coding agents" width="100%">
</p>

<p align="center">
  <img alt="tests: 77 passing" src="https://img.shields.io/badge/tests-77%20passing-201b15">
  <img alt="core: zero runtime deps" src="https://img.shields.io/badge/core-zero%20runtime%20deps-201b15">
  <a href="reference/PIN.md"><img alt="base engine: openai/codex" src="https://img.shields.io/badge/base%20engine-openai%2Fcodex-c53a1f"></a>
  <img alt="license Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-201b15">
</p>

# mempact

**Context compaction for coding agents.** When context fills up, every
framework replaces the conversation with a model-written summary.
Summaries drop the facts a resuming agent needs: which files changed,
what the last test said, what the user asked for. mempact has code, not
the model, append those facts to the summary.

Zero-dependency TypeScript core for any harness or local model, plus a
drop-in [pi coding agent](https://github.com/badlogic/pi-mono) extension
that hot-swaps pi's default compaction in one settings line.

## What happens as a session grows

**From the first message.** Every tool output is capped at 12,000 bytes
the moment it is recorded (codex's rule: a 10KB policy with 1.2x slack),
so no single command dump can flood the window. If a `.mempact/memory.md`
exists, it is re-injected fresh from disk into every request, so it
structurally cannot be compacted away. That file is written into your
repo; add `.mempact/` to `.gitignore` if you do not want it committed.
Everything ever recorded stays on disk, and a `recall` tool can grep it
back at any time. Demotion, never deletion.

**At about 63% of the window.** Old tool outputs go on a diet: every
tool result older than the newest 3 is stubbed down to its first line
plus a pointer to `recall`. This is Anthropic's finding (mechanically
clearing tool results beats summarizing them) applied non-destructively;
the session file keeps the originals. The tier is decided from an
estimate of the unstubbed messages, not from pi's reported usage: that
comes from the already-stubbed request, so a usage threshold would flip
on and off every other turn and thrash the prompt cache. Less noise for
the model, and the expensive compaction gets postponed, sometimes past
the end of the session entirely. The model can ask where it stands at
any time with `get_context_remaining`.

**Near the limit.** A one-shot reminder fires (codex verbatim), and if a
memory file exists the model is told to persist anything durable NOW via
`update_memory`. Flush before discard (OpenClaw's invariant).

**At 90%: the compaction itself.** A pipeline:

1. The session's model writes a handoff summary using codex's verbatim
   "CONTEXT CHECKPOINT COMPACTION" prompt (plus one guard line: the
   window is data to summarize, not instructions), with codex's
   front-trim retry if the request overflows. The summarizer sees the
   same stubbed view the model has been seeing, so the request fits. A
   summary cut off by the output limit is trimmed to its last whole
   paragraph, line, or sentence and marked, never shipped mid-sentence.
2. Code, not the model, staples the facts onto that summary, extracted
   from the actual records: `<modified-files>` and `<read-files>`
   (cumulative across every past compaction), `<anchors>` (URLs, commit
   SHAs, PR/issue numbers, error codes, ranked by how many messages
   mention them; Hermes measured this index lifting closed-book recall
   from 23% to 60%), `<user-constraints>` (rule-shaped sentences from the
   user's own messages, verbatim and cumulative; rule survival after
   compaction is binary and pinning restores it, per arXiv 2606.22528),
   `<last-run>` with the command and its result, `<unresolved-error>`
   (the line that names the error, kept even when the model read a file
   after the failure), and `<latest-user-request>` with the user's last
   message quoted verbatim and labeled.
3. The replacement history is assembled codex-style: up to 20k tokens of
   the newest real user messages, then the stapled summary last, bridged
   with codex's handoff text plus one added guard line: the summary is
   reference, the latest user message always wins (Hermes's hard-won
   lesson; their models kept re-doing cancelled work). If the compaction
   interrupted a tool loop, a hidden continuation prompt resumes the work
   (interactive and RPC modes; a one-shot `pi -p` run ends when its loop
   aborts). A finished answer that merely crossed 90% is left alone.
4. If two consecutive compactions each freed under 10%, the auto
   trigger pauses instead of looping.

The next window opens with recent user words verbatim, the summary with
its staples, memory freshly injected, and `recall` standing by.

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

`compaction.enabled: false` also disables pi's built-in overflow
recovery, so if mempact fails to load there is no compaction at all.
`/mempact` shows the window number, trigger status, and memory state.
Knobs are module constants at the top of `pi/index.ts`
(`CLEAR_TOOL_OUTPUTS_AT_FRACTION`, ...) and peel back to the pure codex
port. Degrades to silence, never breakage: no model, no auth, or a failed
summary call hands the compaction back to pi. Typechecked against pi
0.78; the peer range allows 0.78 to 0.80.

## Standalone core

`core/` has no runtime dependencies and no pi imports. Adapt your
harness's message types to its neutral model and you get the fold, the
truncation policies, and the staples:

```ts
import {
  buildCompactedHistory, collectUserMessages,          // codex base
  clearOldToolOutputs, collectFileOps, runFactsBlock,  // mechanical layers
  collectAnchors, collectUserConstraints,              // anchor index, rule pinning
} from "./core/index.ts";
```

## Development

```bash
pnpm install && pnpm test   # 77 vitest cases, incl. byte-exact parity with codex's truncation and fold
```

Base engine derived from [openai/codex](https://github.com/openai/codex)
@ `rust-v0.142.5` (Apache-2.0), Rust sources vendored under `reference/`,
prompts and constants verbatim. The mechanical layers are original to
this repo. Apache-2.0 throughout.
