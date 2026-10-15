<p align="center">
  <img src="assets/banner.png" alt="mempact - context compaction for coding agents" width="100%">
</p>

# mempact

mempact is context compaction for coding agents. It ships as an extension
for the [pi coding agent](https://github.com/badlogic/pi-mono) and as a
TypeScript core with no runtime dependencies that other harnesses can call.
When the context window fills, code records the facts the next window needs
in a typed ledger. The model writes only the story around them: the goal,
the decisions, what failed, and the next step.

## Why

Facts stored in prose summaries decay when each summary is summarized again
([cascading compaction](https://arxiv.org/abs/2605.24657),
[Compaction Cliff](https://arxiv.org/abs/2608.22752)). User rules get
violated more often after compaction, and pinning them outside the summary
fixes that ([ConstraintRot](https://arxiv.org/abs/2606.22528)). Codex's
compaction quality comes from
[model training](https://openai.com/index/gpt-5-1-codex-max/), which an
open-source harness cannot copy, so mempact competes on harness design.

## How it works

After a compaction, the next request reads in this order:

1. **Project memory.** If `.mempact/memory.md` exists, it is read from disk
   and sent as the first message on every request. Compaction never touches
   it, and the prompt-cache prefix stays stable until the file changes.
2. **Recent user messages, verbatim.** The newest real user messages from
   before the raw tail, up to 20k tokens. This is codex's rule.
3. **The summary message.** It has four parts:
   - codex's handoff bridge text, kept verbatim;
   - the **narrative**, written by the model under fixed headings: Goal,
     Decisions and why, Findings, Approaches that failed, Current work,
     Next step, Open questions. It is cumulative: each compaction keeps
     every prior item that still holds;
   - the **ledger**, built by code from the full session records every time;
   - a stale-intent note: the summary is reference, and the latest user
     message wins.
4. **The raw tail.** The most recent messages, kept verbatim, up to 20k
   tokens (pi's `keepRecentTokens`) or a quarter of the window, whichever is
   smaller. The cut never
   splits a tool call from its results.
5. **Rehydrated files.** The current text of up to five recently modified
   files, read from disk once at compaction. Large or missing files are
   listed by path only.

### The ledger

`core/ledger.ts` builds the ledger from source messages only, never from an
earlier summary, so its facts cannot decay across rounds. It holds:

- modified files and read files;
- commands with their exit codes and the line that names each error;
- user constraints: rule-shaped sentences from the user's own messages,
  quoted verbatim, marked superseded when a later message reverses them;
- explicit goal changes ("new plan", "scratch that", and similar);
- identifiers: URLs, commit SHAs, PR and issue refs, error codes;
- the latest user request.

Each list has a cap, so long sessions drop the oldest entries.

### The narrative

The summarizer gets the previous narrative as input, never the previous
summary with its ledger, so summaries are never compacted into summaries.
`core/summarySchema.ts` checks the result: every heading present and
non-empty, not cut off by the output limit, and a Next step that names a
modified file or command when the ledger has any. On failure it asks once
more, then accepts the result with a note listing what is still missing.
Then `core/carry.ts` compares it with the previous narrative: decisions,
findings and failed approaches the model dropped are appended to their
section under "Carried from earlier windows:", capped at 3,000 tokens with
the oldest dropped first.

### Between compactions

- **Output cap.** Tool outputs over 12,000 bytes are middle-truncated when
  recorded (codex's 10KB policy times 1.2). The full text is saved first as
  an artifact file under `.mempact/artifacts/`, and the truncated text names
  the artifact id.
- **Tool-output clearing.** When the unstubbed context reaches 70% of the
  compaction limit (about 63% of the window), every tool output except the
  newest three is replaced in the request by a one-line stub. The session
  file keeps the originals.
- **Trigger.** Compaction fires at 90% of the window (codex's rule). A
  one-shot reminder fires 10k tokens before that, and asks the model to
  save state with `update_memory` when a memory file exists.
- **Thrash guard.** If the last two compactions each freed under 10%, the
  automatic trigger pauses. Manual `/compact` and overflow recovery stay on.
- **Resume.** If the compaction interrupted a tool loop or recovered an
  overflow, a hidden prompt resumes the task. This works in interactive and
  RPC modes. A one-shot `pi -p` run ends when its loop aborts.

## Install for pi

```bash
pi install git:github.com/topmass/mempact
# or try it for one session without installing:
pi -e git:github.com/topmass/mempact
```

Then hand compaction timing to mempact in `~/.pi/agent/settings.json`.
mempact warns until you do:

```json
{ "compaction": { "enabled": false } }
```

`compaction.enabled: false` also disables pi's built-in overflow recovery,
so if mempact fails to load there is no compaction at all. With no model,
no auth, or a failed summary call, mempact falls back to pi's compaction.

mempact writes `.mempact/memory.md` and `.mempact/artifacts/` into your
project. Add `.mempact/` (or only `.mempact/artifacts/`) to `.gitignore` if
you do not want them committed.

Settings are module constants at the top of `pi/index.ts`, such as
`CLEAR_TOOL_OUTPUTS_AT_FRACTION` and `CONTINUE_AFTER_AUTO_COMPACT`. The
extension typechecks against pi 0.78, and the peer range allows 0.78 to
0.80.

## Tools and command

- `recall`: searches the full session history, including compacted turns
  and cleared outputs. With an `artifact` id, it reads a saved output by
  line range, or lists the lines that match a query.
- `update_memory`: sets a section of `.mempact/memory.md` or appends one
  line to it. Sections: Goal, Plan, Decisions, Files, Next, Open.
- `get_context_remaining`: reports tokens left before compaction.
- `new_context`: starts a new window with no summary (codex's hard reset).
- `/mempact`: shows the window number, token use against the trigger,
  memory file state, the count of cleared outputs, and whether the trigger
  is paused.

## Benchmark

`bench/` replays seeded synthetic sessions with planted facts under three
conditions in one code path: pi's real compaction, the codex prompt, and
mempact. It scores which facts survive each round by mechanical text
matching, plus stale constraints and token cost. With `--replay` and any
OpenAI-compatible endpoint, it also checks whether the model's next action
after compaction matches the one it picks with full history. See
[bench/README.md](bench/README.md) for the metrics, how to run it, and its
limits.

The offline CSVs in `bench/results/` use a fake summarizer and only show
the ledger property: on the small and large fixtures mempact kept 100% of
planted files and live constraints across all three rounds.

`bench/results/live-qwen3.6-35b-a3b-12s-2026-10-15.csv` is a live run on
twelve real Claude Code sessions (187k to 437k tokens each) with a local
Qwen3.6-35B-A3B as summarizer, answerer and judge, a 64k window and up to
five compaction rounds. At each boundary the model writes probes from the
drained messages, every condition answers all probes so far, and the model
grades the answers. Averaged over rounds, mempact scores 0.10 above pi
(95% CI 0.08 to 0.14), 0.07 above ledger-only and 0.17 above the codex
prompt, and wins every one of the twelve sessions against each. Part of
the gap to pi is that pi's prompt gets short summaries from this model,
about 600 tokens in round 1 against 2,400 for mempact. The two
`live-llamacpp` CSVs are earlier three-session runs with Qwen3.8-27B,
where mempact went from a tie with pi to 0.05 ahead as the summarizer
prompt changed. One judge model and twelve sessions is still a small
sample.

## Using the core in other frameworks

`core/` has no runtime dependencies and only type imports from pi-ai.
`compactWindow` runs one compaction. You supply the model call and a token
estimate:

```ts
import { compactWindow, OverflowError } from "./core/index.ts";

const result = await compactWindow(
  { messages, previous, contextWindow, maxOutputTokens, instructions },
  {
    // throw OverflowError when the request does not fit the window
    summarize: (systemPrompt, messages, maxTokens) => Promise<string>,
    estimateTokens: (message) => number,
  },
);
// result: ledger, narrative, retainedUserMessages, rawTail,
//         summaryText, rehydratePaths, validation
```

`previous` is `{ narrative, start }` from the last round. The caller lays
out the request and reads the rehydrated files. `clearOldToolOutputs`, the
memory helpers in `core/memory.ts`, and the recall helpers in
`core/recall.ts` are exported for the other layers.

## Not here on purpose

- No post-compaction quiz or self-check by the model.
- No graph memory. The live bench shows the losses are in summary capture,
  not in how the facts are stored.

## Development

```bash
pnpm install
pnpm test        # the test suite, including byte-exact parity with codex's truncation
pnpm typecheck
```

## Lineage and license

The base engine is a TypeScript port of
[openai/codex](https://github.com/openai/codex) at tag `rust-v0.142.5`. The
Rust sources it was ported from are vendored under `reference/`, and
[reference/PIN.md](reference/PIN.md) records the commit. The handoff bridge
text and trigger constants are kept verbatim. The ledger, narrative schema,
clearing, artifacts, memory and benchmark are original to this repo.
Apache-2.0 throughout.
