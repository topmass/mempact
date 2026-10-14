/**
 * pnpm bench [--fixture small|medium|large | --transcript path ... | --transcripts list.txt]
 *            [--window 128000] [--trigger 0.9] [--max-rounds N] [--replay] [--out bench/results]
 *            [--conditions pi,codex,mempact,ledger] [--reuse-probes]
 *
 * Runs the four conditions in lockstep over one session: compaction fires
 * for all of them at the same message index, the first point where the
 * fullest condition's context (its last compacted context plus the raw
 * messages since) reaches trigger * window. Without MEMPACT_BENCH_BASE_URL
 * it uses a deterministic fake summarizer, so it runs offline.
 *
 * Transcripts with a model also get model-made probes (bench/probes.ts) and
 * write one JSON per session to <out>/live/, skipping sessions already
 * there; bench/aggregate.ts summarizes them. With --reuse-probes an existing
 * file is rerun instead: its boundaries and probes are reused, the listed
 * conditions are recomputed, and the other conditions' results are kept.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { contentText } from "../core/items.ts";
import { NARRATIVE_SECTIONS } from "../core/summarySchema.ts";
import { type BenchDeps, CONDITIONS } from "./conditions.ts";
import { FIXTURES, type Fixture, generateFixture } from "./fixtures/generate.ts";
import { importTranscript } from "./import.ts";
import { type Ask, type Probe, type Verdict, VERDICT_SCORE, generateProbes, judge, probeMetrics, scoreProbes } from "./probes.ts";
import {
  type Endpoint,
  type NextAction,
  actionOf,
  endpointAsk,
  endpointFromEnv,
  endpointSummarize,
  firstModel,
  nextAction,
  repeats,
  transcriptTools,
} from "./replay.ts";
import { contextText, scoreContext } from "./score.ts";
import { OverflowError } from "../core/pipeline.ts";

export interface Row {
  condition: string;
  round: number;
  metric: string;
  value: number | undefined;
}

const MAX_OUTPUT_TOKENS = 8192;
const tokens = (msgs: readonly Message[]) => msgs.reduce((n, m) => n + estimateTokens(m), 0);

/** Offline stand-in: the schema headings with the first 300 chars of each
 *  user message it was given (pi serializes the conversation into one
 *  message, so its "[User]:" lines count as user messages too), and the last
 *  tool call as the next step so mempact's validator does not force a retry. */
export async function fakeSummarize(_systemPrompt: string, messages: Message[]): Promise<string> {
  const users = messages.flatMap((m, i) => {
    if (m.role !== "user") return [];
    const text = contentText(m.content);
    const serialized = [...text.matchAll(/^\[User\]: (.*)$/gm)].map((x) => x[1]!);
    return serialized.length > 0 ? serialized : i === messages.length - 1 ? [] : [text];
  });
  const lastCall = messages
    .flatMap((m) => (m.role === "assistant" ? m.content : []))
    .findLast((c) => c.type === "toolCall" && (c.name === "bash" || c.name === "edit" || c.name === "write"));
  const next = lastCall?.type === "toolCall" ? `Continue after ${lastCall.arguments.command ?? lastCall.arguments.path}.` : "None";
  const body = (s: string) =>
    s === "Current work" && users.length > 0 ? users.map((u) => `- ${u.slice(0, 300)}`).join("\n") : s === "Next step" ? next : "None";
  return NARRATIVE_SECTIONS.map((s) => `## ${s}\n${body(s)}`).join("\n\n");
}

export interface BenchResult {
  rows: Row[];
  probes: Probe[];
  answers: { round: number; condition: string; probe: number; answer: string; verdict: Verdict }[];
  actions: { round: number; condition: string; action: NextAction; reference?: NextAction; judged?: Verdict }[];
}

const ACTION_CRITERION = "Does the candidate next action pursue the same intent as the reference, the actual next action?";

export async function runBench(opts: {
  fixture: Fixture;
  window: number;
  trigger: number;
  summarize: BenchDeps["summarize"];
  replay?: Endpoint;
  /** probe writer, answerer and judge; probes run only on fixtures without planted facts */
  ask?: Ask;
  maxRounds?: number;
  /** default: all of CONDITIONS */
  conditions?: (keyof typeof CONDITIONS)[];
  /** an earlier result for this session: rounds fire at its boundaries, its
   *  probes are reused, and its rows for other conditions are kept */
  saved?: BenchResult;
  log?: (line: string) => void;
}): Promise<BenchResult> {
  const { messages, facts } = opts.fixture;
  const ask = opts.ask;
  // a real transcript's own next turn is the replay reference, offered its own tools
  const tools = facts ? undefined : transcriptTools(messages);
  const probes: Probe[] = [];
  const answers: BenchResult["answers"] = [];
  const actions: BenchResult["actions"] = [];
  const limit = Math.floor(opts.trigger * opts.window);
  const names = opts.conditions ?? (Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[]);
  const saved = opts.saved;
  const boundaries = saved?.rows.filter((r) => r.condition === "full" && r.metric === "boundary").sort((x, y) => x.round - y.round).map((r) => r.value);
  const st = Object.fromEntries(names.map((c) => [c, { context: [] as Message[], state: undefined as unknown }]));
  const rows: Row[] = [];
  const add = (condition: string, round: number, metrics: Record<string, number | undefined>) => {
    for (const [metric, value] of Object.entries(metrics)) rows.push({ condition, round, metric, value });
  };

  let slice = 0;
  let round = 0;
  let drainedFrom = 0;
  const since = (t: number) => `${((Date.now() - t) / 1000).toFixed(0)}s`;
  for (let i = 0; i < messages.length; i++) {
    slice += estimateTokens(messages[i]!);
    const b = i + 1;
    if (b >= messages.length || messages[b]!.role === "toolResult") continue;
    const carried = Math.max(...names.map((c) => tokens(st[c]!.context)));
    if (boundaries ? b !== boundaries[round] : carried + slice < limit) continue;
    if (!boundaries && carried >= limit) throw new Error(`window ${opts.window} is too small: a compacted context alone is ${carried} tokens`);
    if (opts.maxRounds && round >= opts.maxRounds) break;
    round++;
    slice = 0;
    const history = messages.slice(0, b);
    const roundStart = Date.now();
    add("full", round, { boundary: b, context_tokens: tokens(history) });
    opts.log?.(`round ${round} at message ${b} (${tokens(history)} raw tokens)`);

    if (ask && !facts) {
      const t = Date.now();
      const fresh = saved ? saved.probes.filter((p) => p.round === round) : await generateProbes(ask, messages.slice(drainedFrom, b), round);
      probes.push(...fresh);
      opts.log?.(`  probes: ${fresh.length} new, ${probes.length} total (${since(t)})`);
    }
    drainedFrom = b;

    let reference: NextAction | undefined;
    // user messages between the boundary and the transcript's next assistant turn
    let pending: Message[] = [];
    if (opts.replay && !facts) {
      const next = messages.findIndex((m, i) => i >= b && m.role === "assistant");
      if (next >= 0) {
        reference = actionOf(messages[next]!);
        pending = messages.slice(b, next);
        add("full", round, repeats(reference, history));
      } else add("full", round, { replay_skipped: 1 });
    } else if (opts.replay) {
      try {
        reference = await nextAction(opts.replay, history);
        add("full", round, repeats(reference, history));
      } catch (error) {
        // the raw history no longer fits the model: no reference this round
        if (!(error instanceof OverflowError)) throw error;
        add("full", round, { replay_skipped: 1 });
      }
    }

    for (const c of names) {
      const t = Date.now();
      const cost = { summarizer_calls: 0, summarizer_input_tokens: 0, summarizer_output_tokens: 0 };
      const summarize: BenchDeps["summarize"] = async (system, msgs, maxTokens) => {
        const text = await opts.summarize(system, msgs, maxTokens);
        cost.summarizer_calls++;
        cost.summarizer_input_tokens += tokens(msgs) + Math.ceil(system.length / 4);
        cost.summarizer_output_tokens += Math.ceil(text.length / 4);
        return text;
      };
      const r = await CONDITIONS[c](history, st[c]!.state, { summarize, estimateTokens, contextWindow: opts.window, maxOutputTokens: MAX_OUTPUT_TOKENS });
      st[c] = { context: r.contextAfter, state: r.state };
      add(c, round, { ...(facts ? scoreContext(contextText(r.contextAfter), facts, b) : {}), context_tokens: tokens(r.contextAfter), ...cost });
      if (opts.replay) {
        const action = await nextAction(opts.replay, [...r.contextAfter, ...pending], tools);
        const judged = ask && reference ? await judge(ask, "What should the agent do next?", reference.detail ?? "", action.detail ?? "", ACTION_CRITERION) : undefined;
        actions.push({ round, condition: c, action, reference, judged });
        add(c, round, {
          replay_match: reference && reference.tool !== "none" ? Number(action.tool === reference.tool && action.arg === reference.arg) : undefined,
          replay_judged: judged ? VERDICT_SCORE[judged] : undefined,
          ...repeats(action, history),
        });
      }
      if (ask && probes.length > 0) {
        const s = await scoreProbes(ask, r.contextAfter, probes);
        s.verdicts.forEach((verdict, probe) => answers.push({ round, condition: c, probe, answer: s.answers[probe]!, verdict }));
        add(c, round, probeMetrics(probes, s.verdicts, round));
      }
      opts.log?.(`  ${c}: ${since(t)}`);
    }
    opts.log?.(`round ${round} done in ${since(roundStart)}`);
  }
  if (!saved) return { rows, probes, answers, actions };
  // keep the saved boundary rows and the conditions not rerun
  const kept = <T extends { condition: string }>(xs: T[]) => xs.filter((x) => !(names as string[]).includes(x.condition));
  return {
    rows: [...kept(saved.rows), ...rows.filter((r) => r.condition !== "full")].sort((x, y) => x.round - y.round),
    probes: saved.probes,
    answers: [...kept(saved.answers), ...answers],
    actions: [...kept(saved.actions), ...actions],
  };
}

const COLUMNS: [string, string][] = [
  ["files", "files"],
  ["live_constraints", "constraints"],
  ["stale", "stale"],
  ["error", "error"],
  ["next_step", "next"],
  ["goal", "goal"],
  ["anchors", "anchors"],
  ["commands", "cmds"],
  ["context_tokens", "ctx tok"],
  ["summarizer_input_tokens", "sum in"],
  ["summarizer_output_tokens", "sum out"],
  ["probe_count", "probes"],
  ["probe_score", "probe"],
  ["probe_score_rationale", "why"],
  ["probe_score_rule", "rule"],
  ["probe_score_state", "state"],
  ["probe_score_age1plus", "probe age1+"],
  ["replay_match", "replay match"],
  ["replay_judged", "replay judged"],
  ["reread", "re-read"],
  ["rerun", "re-run"],
  ["replay_skipped", "ref skipped"],
];
const RATES = new Set([
  "files",
  "live_constraints",
  "stale",
  "error",
  "next_step",
  "goal",
  "anchors",
  "commands",
  "probe_score",
  "probe_score_rationale",
  "probe_score_rule",
  "probe_score_state",
  "probe_score_age1plus",
]);

export function markdownTable(rows: Row[]): string {
  const cols = COLUMNS.filter(([m]) => rows.some((r) => r.metric === m && r.value !== undefined));
  const keys = [...new Set(rows.map((r) => `${r.round}\t${r.condition}`))];
  const cell = (round: number, condition: string, metric: string) => {
    const v = rows.find((r) => r.round === round && r.condition === condition && r.metric === metric)?.value;
    return v === undefined ? "" : RATES.has(metric) ? `${Math.round(v * 100)}%` : String(v);
  };
  return [
    `| round | condition | ${cols.map(([, h]) => h).join(" | ")} |`,
    `|---|---|${cols.map(() => "---").join("|")}|`,
    ...keys.map((k) => {
      const [round, condition] = k.split("\t") as [string, string];
      return `| ${round} | ${condition} | ${cols.map(([m]) => cell(Number(round), condition, m)).join(" | ")} |`;
    }),
  ].join("\n");
}

export function loadFixture(name: string): Fixture {
  const path = new URL(`./fixtures/${name}.json`, import.meta.url);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const spec = FIXTURES[name as keyof typeof FIXTURES];
  if (!spec) throw new Error(`unknown fixture ${name}; known: ${Object.keys(FIXTURES).join(", ")}`);
  return generateFixture(name, spec.seed, spec.tokens);
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      transcript: { type: "string", multiple: true },
      transcripts: { type: "string" },
      window: { type: "string", default: "128000" },
      trigger: { type: "string", default: "0.9" },
      "max-rounds": { type: "string" },
      replay: { type: "boolean", default: false },
      out: { type: "string", default: "bench/results" },
      conditions: { type: "string", default: Object.keys(CONDITIONS).join(",") },
      "reuse-probes": { type: "boolean", default: false },
    },
  });
  const conditions = values.conditions.split(",").map((c) => c.trim()) as (keyof typeof CONDITIONS)[];
  for (const c of conditions) if (!(c in CONDITIONS)) throw new Error(`unknown condition ${c}; known: ${Object.keys(CONDITIONS).join(", ")}`);
  let endpoint = endpointFromEnv();
  if (!endpoint && process.env.MEMPACT_BENCH_BASE_URL) {
    const { MEMPACT_BENCH_BASE_URL: baseUrl, MEMPACT_BENCH_API_KEY: apiKey = "" } = process.env;
    endpoint = { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model: await firstModel(baseUrl, apiKey) };
  }
  if (values.replay && !endpoint) throw new Error("--replay needs a model: set MEMPACT_BENCH_BASE_URL (and MEMPACT_BENCH_API_KEY, MEMPACT_BENCH_MODEL)");
  const model = endpoint?.model ?? "fake";
  const transcripts = [...(values.transcript ?? []), ...(values.transcripts ? readFileSync(values.transcripts, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [])];
  const sources = transcripts.length > 0 ? transcripts : (values.fixture ? [values.fixture] : Object.keys(FIXTURES));
  const live = join(values.out, "live");
  mkdirSync(transcripts.length > 0 ? live : values.out, { recursive: true });

  for (const source of sources) {
    const isTranscript = transcripts.length > 0;
    const jsonFile = join(live, `${basename(source, ".jsonl")}.json`);
    let saved: BenchResult | undefined;
    if (isTranscript && existsSync(jsonFile)) {
      const file = JSON.parse(readFileSync(jsonFile, "utf8")) as Partial<BenchResult> & { error?: string };
      if (!values["reuse-probes"] || file.error || !file.rows?.length) {
        console.error(`skip ${source}: ${jsonFile} exists${values["reuse-probes"] ? " with no rounds to reuse" : ""}`);
        continue;
      }
      saved = { rows: file.rows, probes: file.probes ?? [], answers: file.answers ?? [], actions: file.actions ?? [] };
    }
    const started = Date.now();
    const meta = { name: basename(source, ".jsonl"), source, model, window: Number(values.window), trigger: Number(values.trigger) };
    let result: BenchResult;
    let fixture: Fixture;
    try {
      fixture = isTranscript ? importTranscript(source) : loadFixture(source);
      console.log(`\n## ${fixture.name} (${tokens(fixture.messages)} tokens, model ${model}, window ${values.window}, trigger ${values.trigger})\n`);
      console.error(`session ${fixture.name}: ${tokens(fixture.messages)} tokens`);
      result = await runBench({
        fixture,
        window: Number(values.window),
        trigger: Number(values.trigger),
        summarize: endpoint ? endpointSummarize(endpoint) : fakeSummarize,
        replay: values.replay ? endpoint : undefined,
        ask: endpoint && isTranscript ? endpointAsk(endpoint) : undefined,
        maxRounds: values["max-rounds"] ? Number(values["max-rounds"]) : undefined,
        conditions,
        saved,
        log: (l) => console.error(l),
      });
    } catch (error) {
      // one bad session must not end a long run
      if (!isTranscript) throw error;
      console.error(`session ${source} failed: ${(error as Error).stack}`);
      // a failed rerun keeps the saved results
      if (!saved) writeFileSync(jsonFile, JSON.stringify({ ...meta, error: String((error as Error).message) }, null, 1));
      continue;
    }
    const { rows } = result;
    const file = isTranscript ? jsonFile : join(values.out, `${fixture.name}-${model.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`);
    const csvMeta = `${fixture.name},${model},${values.window},${values.trigger}`;
    writeFileSync(
      file,
      // real transcripts hold private project content: live/ is gitignored
      isTranscript
        ? JSON.stringify({ ...meta, seconds: Math.round((Date.now() - started) / 1000), ...result }, null, 1)
        : ["fixture,model,window,trigger,condition,round,metric,value", ...rows.map((r) => `${csvMeta},${r.condition},${r.round},${r.metric},${r.value ?? ""}`)].join("\n") + "\n",
    );
    console.log(rows.length > 0 ? markdownTable(rows) : "No compaction: the session never reached the trigger. Try a smaller --window.");
    console.log(`\nwrote ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
