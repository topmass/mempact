/**
 * node --experimental-strip-types bench/aggregate.ts [bench/results/live]
 *
 * Reads every session file the live bench wrote, prints the mean of each
 * metric per round and condition, and compares mempact's probe_score with
 * each other condition, paired by session: win/tie/loss counts and a
 * bootstrap 95% interval of the mean difference. Writes the aggregate to
 * bench/results/live-<model>-<date>.csv; the session files stay private.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Row } from "./run.ts";

const METRICS = [
  "probe_count",
  "probe_score",
  "probe_score_rationale",
  "probe_score_rule",
  "probe_score_state",
  "probe_score_age1plus",
  "replay_match",
  "replay_judged",
  "reread",
  "rerun",
  "context_tokens",
  "summarizer_input_tokens",
  "summarizer_output_tokens",
];

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** mulberry32, so the interval is reproducible */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Mean of each metric per round and condition over the sessions that have it. */
export function roundMeans(sessions: readonly Row[][]): { round: number; condition: string; metric: string; value: number; n: number }[] {
  const groups = new Map<string, number[]>();
  for (const r of sessions.flat()) {
    if (r.value === undefined || r.value === null) continue;
    const k = `${r.round}\t${r.condition}\t${r.metric}`;
    groups.set(k, [...(groups.get(k) ?? []), r.value]);
  }
  return [...groups].map(([k, xs]) => {
    const [round, condition, metric] = k.split("\t") as [string, string, string];
    return { round: Number(round), condition, metric, value: mean(xs), n: xs.length };
  });
}

/** a - b on `metric`, paired by round within a session, averaged per
 *  session; the bootstrap resamples sessions. */
export function paired(sessions: readonly Row[][], a: string, b: string, metric = "probe_score", resamples = 1000, seed = 1) {
  const diffs = sessions.flatMap((rows) => {
    const ds = rows
      .filter((r) => r.condition === a && r.metric === metric && r.value != null)
      .flatMap((ra) => {
        const vb = rows.find((r) => r.condition === b && r.metric === metric && r.round === ra.round)?.value;
        return vb == null ? [] : [ra.value! - vb];
      });
    return ds.length > 0 ? [mean(ds)] : [];
  });
  if (diffs.length === 0) return undefined;
  const rand = seeded(seed);
  const boots = Array.from({ length: resamples }, () => mean(diffs.map(() => diffs[Math.floor(rand() * diffs.length)]!))).sort((x, y) => x - y);
  return {
    n: diffs.length,
    wins: diffs.filter((d) => d > 1e-9).length,
    ties: diffs.filter((d) => Math.abs(d) <= 1e-9).length,
    losses: diffs.filter((d) => d < -1e-9).length,
    mean: mean(diffs),
    lo: boots[Math.floor(0.025 * resamples)]!,
    hi: boots[Math.ceil(0.975 * resamples) - 1]!,
  };
}

const fmt = (v: number | undefined) => (v === undefined ? "" : Number.isInteger(v) || Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2));

function main() {
  const dir = process.argv[2] ?? "bench/results/live";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { name: string; model: string; window: number; trigger: number; rows?: Row[]; error?: string });
  const ok = files.filter((f) => !f.error && f.rows && f.rows.length > 0);
  for (const f of files.filter((f) => !ok.includes(f))) console.log(`- ${f.name}: ${f.error ?? "no compaction"}`);
  if (ok.length === 0) return console.log("no session results");
  const sessions = ok.map((f) => f.rows!);
  const means = roundMeans(sessions);
  const conditions = [...new Set(means.map((m) => m.condition))];
  const metrics = METRICS.filter((m) => means.some((x) => x.metric === m));
  console.log(`${ok.length} sessions, model ${ok[0]!.model}, window ${ok[0]!.window}`);

  for (const round of [...new Set(means.map((m) => m.round))].sort((x, y) => x - y)) {
    const cell = (c: string, m: string) => fmt(means.find((x) => x.round === round && x.condition === c && x.metric === m)?.value);
    const n = means.filter((x) => x.round === round && x.metric === "context_tokens" && x.condition === "full")[0]?.n ?? 0;
    console.log(`\n### round ${round} (${n} sessions)\n`);
    console.log(`| condition | ${metrics.join(" | ")} |\n|---|${metrics.map(() => "---").join("|")}|`);
    for (const c of conditions) console.log(`| ${c} | ${metrics.map((m) => cell(c, m)).join(" | ")} |`);
  }

  const pairs = ["pi", "ledger", "codex"].map((b) => ({ b, p: paired(sessions, "mempact", b) }));
  console.log(`\n### mempact vs each, probe_score per session\n\n| vs | sessions | win | tie | loss | mean diff | 95% CI |\n|---|---|---|---|---|---|---|`);
  for (const { b, p } of pairs) if (p) console.log(`| ${b} | ${p.n} | ${p.wins} | ${p.ties} | ${p.losses} | ${fmt(p.mean)} | ${fmt(p.lo)} to ${fmt(p.hi)} |`);

  const { model, window, trigger } = ok[0]!;
  const file = join(dirname(dir), `live-${model.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`);
  const pre = `${model},${window},${trigger}`;
  writeFileSync(
    file,
    [
      "model,window,trigger,round,condition,metric,value,n",
      ...means.map((m) => `${pre},${m.round},${m.condition},${m.metric},${m.value},${m.n}`),
      ...pairs.flatMap(({ b, p }) =>
        p ? (["mean", "lo", "hi", "wins", "ties", "losses"] as const).map((k) => `${pre},all,mempact-${b},probe_score_diff_${k},${p[k]},${p.n}`) : [],
      ),
    ].join("\n") + "\n",
  );
  console.log(`\nwrote ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
