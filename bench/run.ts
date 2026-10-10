/**
 * pnpm bench [--fixture small|medium|large | --transcript path] [--window 128000]
 *            [--trigger 0.9] [--replay] [--out bench/results]
 *
 * Runs the three conditions in lockstep over one session: compaction fires
 * for all of them at the same message index, the first point where the
 * fullest condition's context (its last compacted context plus the raw
 * messages since) reaches trigger * window. Without MEMPACT_BENCH_BASE_URL
 * it uses a deterministic fake summarizer, so it runs offline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { contentText } from "../core/items.ts";
import { NARRATIVE_SECTIONS } from "../core/summarySchema.ts";
import { type BenchDeps, CONDITIONS } from "./conditions.ts";
import { FIXTURES, type Fixture, generateFixture } from "./fixtures/generate.ts";
import { importTranscript } from "./import.ts";
import { type Endpoint, type NextAction, endpointFromEnv, endpointSummarize, firstModel, nextAction, repeats } from "./replay.ts";
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

export async function runBench(opts: {
  fixture: Fixture;
  window: number;
  trigger: number;
  summarize: BenchDeps["summarize"];
  replay?: Endpoint;
  log?: (line: string) => void;
}): Promise<Row[]> {
  const { messages, facts } = opts.fixture;
  const limit = Math.floor(opts.trigger * opts.window);
  const names = Object.keys(CONDITIONS) as (keyof typeof CONDITIONS)[];
  const st = Object.fromEntries(names.map((c) => [c, { context: [] as Message[], state: undefined as unknown }]));
  const rows: Row[] = [];
  const add = (condition: string, round: number, metrics: Record<string, number | undefined>) => {
    for (const [metric, value] of Object.entries(metrics)) rows.push({ condition, round, metric, value });
  };

  let slice = 0;
  let round = 0;
  for (let i = 0; i < messages.length; i++) {
    slice += estimateTokens(messages[i]!);
    const b = i + 1;
    if (b >= messages.length || messages[b]!.role === "toolResult") continue;
    const carried = Math.max(...names.map((c) => tokens(st[c]!.context)));
    if (carried + slice < limit) continue;
    if (carried >= limit) throw new Error(`window ${opts.window} is too small: a compacted context alone is ${carried} tokens`);
    round++;
    slice = 0;
    const history = messages.slice(0, b);
    add("full", round, { boundary: b, context_tokens: tokens(history) });
    opts.log?.(`round ${round} at message ${b} (${tokens(history)} raw tokens)`);

    let reference: NextAction | undefined;
    if (opts.replay) {
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
        const action = await nextAction(opts.replay, r.contextAfter);
        add(c, round, { replay_match: reference ? Number(action.tool === reference.tool && action.arg === reference.arg) : undefined, ...repeats(action, history) });
      }
    }
  }
  return rows;
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
  ["replay_match", "replay match"],
  ["reread", "re-read"],
  ["rerun", "re-run"],
  ["replay_skipped", "ref skipped"],
];
const RATES = new Set(["files", "live_constraints", "stale", "error", "next_step", "goal", "anchors", "commands"]);

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
      transcript: { type: "string" },
      window: { type: "string", default: "128000" },
      trigger: { type: "string", default: "0.9" },
      replay: { type: "boolean", default: false },
      out: { type: "string", default: "bench/results" },
    },
  });
  let endpoint = endpointFromEnv();
  if (!endpoint && process.env.MEMPACT_BENCH_BASE_URL) {
    const { MEMPACT_BENCH_BASE_URL: baseUrl, MEMPACT_BENCH_API_KEY: apiKey = "" } = process.env;
    endpoint = { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model: await firstModel(baseUrl, apiKey) };
  }
  if (values.replay && !endpoint) throw new Error("--replay needs a model: set MEMPACT_BENCH_BASE_URL (and MEMPACT_BENCH_API_KEY, MEMPACT_BENCH_MODEL)");
  const model = endpoint?.model ?? "fake";
  const fixtures = values.transcript ? [importTranscript(values.transcript)] : (values.fixture ? [values.fixture] : Object.keys(FIXTURES)).map(loadFixture);
  mkdirSync(values.out, { recursive: true });

  for (const fixture of fixtures) {
    console.log(`\n## ${fixture.name} (${tokens(fixture.messages)} tokens, model ${model}, window ${values.window}, trigger ${values.trigger})\n`);
    const rows = await runBench({
      fixture,
      window: Number(values.window),
      trigger: Number(values.trigger),
      summarize: endpoint ? endpointSummarize(endpoint) : fakeSummarize,
      replay: values.replay ? endpoint : undefined,
      log: (l) => console.error(l),
    });
    const file = join(values.out, `${fixture.name}-${model.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`);
    const meta = `${fixture.name},${model},${values.window},${values.trigger}`;
    writeFileSync(
      file,
      ["fixture,model,window,trigger,condition,round,metric,value", ...rows.map((r) => `${meta},${r.condition},${r.round},${r.metric},${r.value ?? ""}`)].join("\n") + "\n",
    );
    console.log(rows.length > 0 ? markdownTable(rows) : "No compaction: the session never reached the trigger. Try a smaller --window.");
    console.log(`\nwrote ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
