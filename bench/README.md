# mempact bench

A reproducible multi-round compaction benchmark for coding-agent sessions.
It runs three compaction rules over the same session, compacts all of them at
the same message indices, and scores what survives each round.

## What it measures

Per condition and per round, from the context the agent sees after compaction:

- **Mechanical retention, no model needed.** Each fixture plants facts and records them in a list: files, live user constraints, a constraint the user later reverses, commands, a failing test's error line, PR/issue/URL/SHA anchors, the current goal, and the current next step. A fact counts as present when its text appears (case-insensitive), or when all of its keys match one line, so a paraphrase can still count.
- **Stale rate.** The share of reversed constraints that still read as live: the old rule is present on a line with no "superseded" style marker, and the reversal is absent.
- **Cost.** Context tokens after compaction, plus summarizer calls, input tokens and output tokens. Tokens are pi's chars/4 estimate, not API usage.
- **Paired replay (`--replay`, needs a model).** At each boundary the model picks its next action twice, with the same system prompt and tools: once from the full raw history, once from the compacted context, each followed by the user message "continue". A match means the same first tool and the same path or command. It also counts re-reads of files already read and re-runs of commands already run. When the raw history no longer fits the model, the reference is skipped (`replay_skipped`).

## Conditions

- `pi`: pi's own `prepareCompaction` and `compact` from `@earendil-works/pi-coding-agent` 0.78, run on an in-memory session. `prepareCompaction` is not in pi's package exports, so `conditions.ts` imports pi's compiled file directly. The bench's summarizer stands in for pi's model call. pi keeps the newest 20k tokens raw.
- `codex`: codex's Memento rule. The summarizer gets the whole in-window history plus codex's "CONTEXT CHECKPOINT COMPACTION" prompt (`reference/codex-rs/prompts/templates/compact/prompt.md`). The new context is the newest real user messages under 20k tokens, then the summary.
- `mempact`: `compactWindow` from `core/pipeline.ts`, laid out as `pi/index.ts` renders it: retained user messages, the summary with its ledger, then the raw tail.

All three share one `summarize` function and one trigger: compaction fires when the fullest condition's context reaches `trigger * window`.

## Running it

```bash
pnpm bench --fixture small --window 32000     # offline, fake summarizer
pnpm bench --fixture large                    # 128k window, 3 rounds
pnpm bench --transcript ~/.claude/projects/<project>/<session>.jsonl --window 64000

MEMPACT_BENCH_BASE_URL=http://host:8080/v1 MEMPACT_BENCH_API_KEY=... \
MEMPACT_BENCH_MODEL=name pnpm bench --replay   # all fixtures, live model
```

With no `MEMPACT_BENCH_BASE_URL`, a deterministic fake summarizer stands in for the model. It copies the first 300 characters of each user message into the narrative headings. Offline numbers test the harness and mempact's code-built ledger. They say nothing about summary quality. If `MEMPACT_BENCH_MODEL` is unset, the bench uses the first id from `GET /models`.

Each run writes `bench/results/<fixture>-<model>-<date>.csv` with one row per condition, round and metric, and prints a markdown table. The `full` rows hold the boundary index, the raw token count, and the replay reference's re-reads and re-runs.

Fixtures: `bench/fixtures/{small,medium,large}.json` (about 64k, 147k and 401k tokens) come from `bench/fixtures/generate.ts` with fixed seeds. Regenerate them with `node --experimental-strip-types bench/fixtures/generate.ts`. `bench/import.ts` converts a Claude Code or pi transcript. Imported sessions have no planted facts, so only cost and replay apply. Do not commit real transcripts.

## Caveats

- Synthetic fixtures are planted-fact tests, not proof that an agent finishes its task. The constraints use rule phrasing ("Never ...", "Always ...") that mempact's constraint detector catches. Real users phrase rules more loosely.
- Each fixture touches fewer than 40 files and 20 distinct commands, under the ledger's caps. Longer real sessions drop the oldest entries.
- Substring scoring misses paraphrases that the keys do not cover, which favors conditions that quote verbatim.
- The replay metric depends on the model, its sampling (requests use temperature 0), and how well it handles tool calls.
- mempact's rehydrated files, project memory and old-tool-output clearing are left out, because they need a real disk and a live session.
- Node's fetch gives up after 300 seconds without response headers. A slow local model on a near-full 128k prompt can hit that limit.
