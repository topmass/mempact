/**
 * node --experimental-strip-types bench/aggregate.ts [directory ...]
 *
 * Reads every session file the live bench wrote, prints the mean of each
 * metric per round and condition, and compares mempact's probe_score with
 * each other condition, paired by session: win/tie/loss counts and a
 * bootstrap 95% interval of the mean difference. Writes the aggregate to
 * bench/results/live-<label>-w<window>-<date>.csv; the session files stay private.
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
  "compaction_failed",
  "probes_failed",
  "replies_cut",
  "judge_unparsed",
];

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: readonly number[]) => {
  const m = mean(xs);
  return xs.length < 2 ? 0 : xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
};

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
export function paired(sessions: readonly Row[][], a: string, b: string, metric = "probe_score", resamples = 10000, seed = 1, finalRound = false) {
  return bootstrap(sessions.flatMap((rows) => sessionGain(rows, a, b, metric, finalRound) ?? []), resamples, seed);
}

function sessionGain(rows: readonly Row[], a: string, b: string, metric: string, finalRound = false) {
  const last = finalRound ? Math.max(...rows.map((r) => r.round)) : undefined;
  const ds = rows
    .filter((r) => r.condition === a && r.metric === metric && r.value != null && (last === undefined || r.round === last))
    .flatMap((ra) => {
      const vb = rows.find((r) => r.condition === b && r.metric === metric && r.round === ra.round)?.value;
      return vb == null ? [] : [ra.value! - vb];
    });
  return ds.length > 0 ? mean(ds) : undefined;
}

function signTest(wins: number, losses: number) {
  const n = wins + losses;
  if (n === 0) return 1;
  let logProbability = -n * Math.LN2;
  let tail = Math.exp(logProbability);
  for (let k = 1; k <= Math.min(wins, losses); k++) {
    logProbability += Math.log(n - k + 1) - Math.log(k);
    tail += Math.exp(logProbability);
  }
  return Math.min(1, 2 * tail);
}

function bootstrap(diffs: readonly number[], resamples = 10000, seed = 1) {
  if (diffs.length === 0) return undefined;
  const rand = seeded(seed);
  const boots = Array.from({ length: resamples }, () => mean(diffs.map(() => diffs[Math.floor(rand() * diffs.length)]!))).sort((x, y) => x - y);
  const wins = diffs.filter((d) => d > 1e-9).length;
  const losses = diffs.filter((d) => d < -1e-9).length;
  return {
    n: diffs.length,
    wins,
    ties: diffs.filter((d) => Math.abs(d) <= 1e-9).length,
    losses,
    mean: mean(diffs),
    lo: boots[Math.floor(0.025 * resamples)]!,
    hi: boots[Math.ceil(0.975 * resamples) - 1]!,
    signP: signTest(wins, losses),
  };
}

export function poolRepeats(repeats: readonly (readonly { name: string; rows: Row[] }[])[], a: string, b: string, metric = "probe_score") {
  const gains = (repeats[0] ?? []).flatMap((session) => {
    const ds = repeats.map((repeat) => {
      const rows = repeat.find((f) => f.name === session.name)?.rows;
      return rows ? sessionGain(rows, a, b, metric) : undefined;
    });
    if (ds.some((d) => d === undefined)) return [];
    const values = ds.filter((d) => d !== undefined);
    return [{ name: session.name, mean: mean(values), variance: variance(values) }];
  });
  const p = bootstrap(gains.map((g) => g.mean));
  return p ? {
    ...p,
    gains,
    betweenRepeatSd: Math.sqrt(mean(gains.map((g) => g.variance))),
    betweenSessionSd: Math.sqrt(variance(gains.map((g) => g.mean))),
  } : undefined;
}

const fmt = (v: number | undefined) => (v === undefined ? "" : Number.isInteger(v) || Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(2));
const fmtP = (p: number) => p < 0.0001 ? p.toExponential(2) : p.toFixed(4);
const pairColumns = "| vs | rounds | sessions | win | tie | loss | mean diff | 95% CI | sign p |\n|---|---|---|---|---|---|---|---|---|";
const pairLine = (b: string, rounds: string, p: NonNullable<ReturnType<typeof paired>>) =>
  `| ${b} | ${rounds} | ${p.n} | ${p.wins} | ${p.ties} | ${p.losses} | ${fmt(p.mean)} | ${fmt(p.lo)} to ${fmt(p.hi)} | ${fmtP(p.signP)} |`;
const pairStats = ["mean", "lo", "hi", "wins", "ties", "losses", "signP"] as const;
const csvCell = (s: string) => /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;

interface ResultFile {
  name: string;
  model: string;
  label?: string;
  window: number;
  trigger: number;
  seed?: number;
  rows?: Row[];
  error?: string;
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) dirs.push("bench/results/live");
  const campaigns = dirs.map((dir) => {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ filename: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), "utf8")) as ResultFile }));
    for (const f of files.slice(1)) {
      for (const key of ["model", "window", "trigger"] as const) {
        if (f[key] !== files[0]![key]) throw new Error(`${f.filename}: ${key} ${f[key]} differs from ${files[0]!.filename}: ${files[0]![key]}`);
      }
    }
    const ok = files.filter((f) => !f.error && f.rows && f.rows.length > 0).map((f) => ({ ...f, rows: f.rows! }));
    for (const f of files.filter((f) => !ok.some((s) => s.filename === f.filename))) console.log(`- ${f.name}: ${f.error ?? "no compaction"}`);
    return { dir, files: ok };
  });
  const first = campaigns.flatMap((c) => c.files)[0];
  if (!first) return console.log("no session results");
  for (const campaign of campaigns) {
    const f = campaign.files[0];
    if (!f) continue;
    for (const key of ["model", "window", "trigger"] as const) {
      if (f[key] !== first[key]) throw new Error(`${f.filename}: repeat ${key} ${f[key]} differs from ${first.filename}: ${first[key]}`);
    }
  }

  const csv = ["model,window,trigger,seed,round,condition,metric,value,n"];
  for (const { dir, files } of campaigns) {
    if (files.length === 0) {
      console.log(`${dir}: no session results`);
      continue;
    }
    const means = roundMeans(files.map((f) => f.rows));
    const conditions = [...new Set(means.map((m) => m.condition))];
    const metrics = METRICS.filter((m) => means.some((x) => x.metric === m));
    const { model, label, window, trigger } = files[0]!;
    console.log(`\n${dir}: ${files.length} sessions, model ${label ?? model}, window ${window}, trigger ${trigger}`);

    for (const round of [...new Set(means.map((m) => m.round))].sort((x, y) => x - y)) {
      const cell = (c: string, m: string) => fmt(means.find((x) => x.round === round && x.condition === c && x.metric === m)?.value);
      const n = means.find((x) => x.round === round && x.metric === "context_tokens" && x.condition === "full")?.n ?? 0;
      console.log(`\n### round ${round} (${n} sessions)\n`);
      console.log(`| condition | ${metrics.join(" | ")} |\n|---|${metrics.map(() => "---").join("|")}|`);
      for (const c of conditions) console.log(`| ${c} | ${metrics.map((m) => cell(c, m)).join(" | ")} |`);
    }

    console.log(`\n### mempact vs each, probe_score per session\n\n${pairColumns}`);
    for (const b of ["pi", "ledger", "codex"]) {
      for (const final of [false, true]) {
        const p = paired(files.map((f) => f.rows), "mempact", b, "probe_score", 10000, 1, final);
        if (p) console.log(pairLine(b, final ? "final round" : "all", p));
      }
    }

    for (const seed of new Set(files.map((f) => f.seed))) {
      const sessions = files.filter((f) => f.seed === seed).map((f) => f.rows);
      const pre = `${csvCell(label ?? model)},${window},${trigger},${seed ?? ""}`;
      csv.push(...roundMeans(sessions).map((m) => `${pre},${m.round},${m.condition},${m.metric},${m.value},${m.n}`));
      for (const b of ["pi", "ledger", "codex"]) {
        for (const final of [false, true]) {
          const p = paired(sessions, "mempact", b, "probe_score", 10000, 1, final);
          if (p) csv.push(...pairStats.map((k) => `${pre},${final ? "final" : "all"},mempact-${b},probe_score_diff_${k},${p[k]},${p.n}`));
        }
      }
    }
  }

  if (campaigns.length > 1) {
    const names = new Set(campaigns.flatMap((c) => c.files.map((f) => f.name)));
    for (const name of names) {
      const missing = campaigns.filter((c) => !c.files.some((f) => f.name === name));
      if (missing.length > 0) console.log(`left out ${name}: missing from ${missing.map((c) => c.dir).join(", ")}`);
    }
    console.log(`\n### pooled repeats, probe_score per session\n\n${pairColumns}`);
    const pre = `${csvCell(first.label ?? first.model)},${first.window},${first.trigger},pooled`;
    const pairs = ["pi", "ledger", "codex"].map((b) => ({ b, p: poolRepeats(campaigns.map((c) => c.files), "mempact", b) }));
    for (const { b, p } of pairs) if (p) console.log(pairLine(b, "all", p));
    for (const { b, p } of pairs) {
      if (!p) continue;
      console.log(`mempact vs ${b}: between-repeat sd of per-session gain: ${fmt(p.betweenRepeatSd)} (between-session sd: ${fmt(p.betweenSessionSd)})`);
      csv.push(...([...pairStats, "betweenRepeatSd", "betweenSessionSd"] as const).map((k) => `${pre},all,mempact-${b},probe_score_diff_${k},${p[k]},${p.n}`));
    }
  }

  const file = join(dirname(dirs[0]!), `live-${(first.label ?? first.model).replace(/[^\w.-]+/g, "_")}-w${first.window}-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(file, csv.join("\n") + "\n");
  console.log(`\nwrote ${file}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
