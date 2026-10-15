import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import * as undici from "undici";
import { paired, poolRepeats } from "../bench/aggregate.ts";
import { CONDITIONS, userMessage } from "../bench/conditions.ts";
import { generateProbes, judge, judgeUnparsed, resetJudgeUnparsed } from "../bench/probes.ts";
import { chat, repliesCut, resetRepliesCut } from "../bench/replay.ts";
import { contentText } from "../core/items.ts";
import { OverflowError } from "../core/pipeline.ts";
import { fakeSummarize, loadFixture, runBench } from "../bench/run.ts";

vi.mock("undici", async (importOriginal) => {
  const original = await importOriginal<typeof import("undici")>();
  return { ...original, fetch: vi.fn(original.fetch) };
});

describe("bench harness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the small fixture offline, and mempact's ledger keeps every planted file and live constraint across rounds", async () => {
    const { rows } = await runBench({ fixture: loadFixture("small"), window: 32_000, trigger: 0.9, summarize: fakeSummarize });
    const rounds = new Set(rows.map((r) => r.round));
    expect(rounds.size).toBeGreaterThanOrEqual(3);
    for (const condition of ["pi", "codex", "mempact", "ledger"]) for (const round of rounds) expect(rows.some((r) => r.condition === condition && r.round === round)).toBe(true);
    const of = (condition: string, metric: string) => rows.filter((r) => r.condition === condition && r.metric === metric).map((r) => r.value);
    for (const condition of ["mempact", "ledger"]) {
      expect(of(condition, "files")).toEqual([...rounds].map(() => 1));
      expect(of(condition, "live_constraints")).toEqual([...rounds].map(() => 1));
    }
    // the ledger condition never calls the summarizer
    expect(of("ledger", "summarizer_calls")).toEqual([...rounds].map(() => 0));
  });

  it("scores model-made probes per kind and by age, carrying earlier rounds' probes forward", async () => {
    const ask = async (system: string, messages: Message[]) => {
      const last = contentText(messages.at(-1)!.content);
      if (system.startsWith("You grade")) return "Correct.";
      if (system.startsWith("You are a coding agent")) return last.includes("rule question") ? "unknown" : "Because it was faster.";
      return '```json\n[{"kind":"rationale","question":"why question","answer":"because it was faster"},{"kind":"rule","question":"rule question","answer":"never push to main branch"},{"kind":"state","question":"short","answer":"too short"}]\n```';
    };
    const fixture = { ...loadFixture("small"), facts: undefined };
    const { rows, probes } = await runBench({ fixture, window: 32_000, trigger: 0.9, summarize: fakeSummarize, ask, maxRounds: 2 });
    expect(new Set(rows.map((r) => r.round))).toEqual(new Set([1, 2]));
    expect(probes.map((p) => p.round)).toEqual([1, 1, 2, 2]);
    const metric = (round: number, m: string) => rows.find((r) => r.condition === "mempact" && r.round === round && r.metric === m)?.value;
    expect([metric(1, "probe_count"), metric(1, "probe_score"), metric(1, "probe_score_rationale"), metric(1, "probe_score_rule")]).toEqual([2, 0.5, 1, 0]);
    expect([metric(1, "probe_score_state"), metric(1, "probe_score_age1plus")]).toEqual([undefined, undefined]);
    expect([metric(2, "probe_count"), metric(2, "probe_score_age1plus")]).toEqual([4, 0.5]);
  });

  it("reruns one condition on saved boundaries and probes, keeping the others' results", async () => {
    const ask = async (system: string) =>
      system.startsWith("You grade") ? "correct" : system.startsWith("You are a coding agent") ? "Because it was faster." : '[{"kind":"rationale","question":"why question","answer":"because it was faster"}]';
    const fixture = { ...loadFixture("small"), facts: undefined };
    const opts = { fixture, window: 32_000, trigger: 0.9, summarize: fakeSummarize, ask, maxRounds: 2 };
    const saved = await runBench({ ...opts, conditions: ["pi"] });
    const merged = await runBench({ ...opts, ask: async () => "wrong", conditions: ["mempact"], saved });
    expect(merged.probes).toEqual(saved.probes);
    expect(merged.rows.filter((r) => r.condition !== "mempact")).toEqual(saved.rows);
    expect(new Set(merged.answers.map((a) => `${a.condition}:${a.verdict}`))).toEqual(new Set(["pi:correct", "mempact:wrong"]));
  });

  it("pairs sessions round by round and bootstraps the mean difference", () => {
    const row = (condition: string, round: number, value: number) => ({ condition, round, metric: "probe_score", value });
    const sessions = [
      [row("mempact", 1, 0.8), row("pi", 1, 0.6), row("mempact", 2, 0.6), row("pi", 2, 0.4)],
      [row("mempact", 1, 0.5), row("pi", 1, 0.3)],
      [row("mempact", 1, 0.5), row("pi", 1, 0.5)],
    ];
    const p = paired(sessions.slice(0, 2), "mempact", "pi")!;
    expect([p.n, p.wins, p.ties, p.losses]).toEqual([2, 2, 0, 0]);
    expect(p.signP).toBeCloseTo(0.5);
    expect([p.mean, p.lo, p.hi].map((x) => Number(x.toFixed(6)))).toEqual([0.2, 0.2, 0.2]);
    const q = paired(sessions, "mempact", "pi")!;
    expect([q.wins, q.ties, q.losses]).toEqual([2, 1, 0]);
    expect(q.lo).toBeLessThanOrEqual(q.mean);
    expect(q.hi).toBeGreaterThanOrEqual(q.mean);
    expect(q.signP).toBeCloseTo(0.5);
    const changing = [[row("mempact", 1, 0), row("pi", 1, 1), row("mempact", 2, 1), row("pi", 2, 0)]];
    expect(paired(changing, "mempact", "pi")!.mean).toBe(0);
    expect(paired(changing, "mempact", "pi", "probe_score", 10000, 1, true)!.mean).toBe(1);
  });

  it("records compaction overflow, keeps the previous state and context, and continues the session", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = { previous: true };
    const contextAfter = [userMessage("x".repeat(4000))];
    const pi = vi.spyOn(CONDITIONS, "pi")
      .mockResolvedValueOnce({ state, contextAfter })
      .mockRejectedValueOnce(new OverflowError("too large"))
      .mockResolvedValue({ state, contextAfter });
    const fixture = { name: "overflow", seed: 1, messages: Array.from({ length: 9 }, () => userMessage("x".repeat(4000))) };
    const ledger = vi.spyOn(CONDITIONS, "ledger").mockResolvedValue({ state: undefined, contextAfter: [] });
    const { rows } = await runBench({ fixture, window: 2000, trigger: 0.9, summarize: fakeSummarize, conditions: ["pi", "ledger"] });
    expect(rows).toContainEqual({ condition: "pi", round: 2, metric: "compaction_failed", value: 1 });
    expect(pi.mock.calls[2]![1]).toBe(state);
    expect(pi.mock.calls[2]![0]).toHaveLength(4);
    expect(pi).toHaveBeenCalledTimes(7);
    expect(ledger).toHaveBeenCalledTimes(7);
    expect(rows.some((r) => r.condition === "ledger" && r.round === 7)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("pi: round 2 compaction failed"));
    pi.mockRejectedValue(new Error("other failure"));
    await expect(runBench({ fixture, window: 2000, trigger: 0.9, summarize: fakeSummarize, conditions: ["pi"] })).rejects.toThrow("other failure");
  });

  it("skips saved probes with a mismatched window or trigger before reading the transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "mempact-reuse-"));
    try {
      const live = join(dir, "live");
      mkdirSync(live);
      const saved = { window: 32000, trigger: 0.9, rows: [{ condition: "full", round: 1, metric: "boundary", value: 1 }] };
      const file = join(live, "missing.json");
      writeFileSync(file, JSON.stringify(saved));
      const env = { ...process.env };
      delete env.MEMPACT_BENCH_BASE_URL;
      for (const flags of [["--window", "64000"], ["--window", "32000", "--trigger", "0.8"]]) {
        const output = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../bench/run.ts", import.meta.url)), "--transcript", join(dir, "missing.jsonl"), "--out", dir, "--reuse-probes", ...flags], { env, encoding: "utf8" });
        expect(output.status).toBe(0);
        expect(output.stderr).toContain("skip");
        expect(output.stderr).toContain("differ from current window");
        expect(output.stdout).not.toContain("wrote");
        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pools only shared sessions and separates repeat variance from session variance", () => {
    const result = (name: string, gains: number[]) => ({ name, rows: gains.flatMap((gain, i) => [
      { condition: "mempact", round: i + 1, metric: "probe_score", value: gain },
      { condition: "pi", round: i + 1, metric: "probe_score", value: 0 },
    ]) });
    const repeats = [
      [result("a", [0, 0.4]), result("b", [0.2]), result("left out", [1])],
      [result("a", [0.6]), result("b", [0.6, 1])],
    ];
    const pooled = poolRepeats(repeats, "mempact", "pi")!;
    expect(pooled.gains.map((g) => g.name)).toEqual(["a", "b"]);
    expect(pooled.gains.map((g) => g.mean)).toEqual([0.4, 0.5]);
    expect(pooled.mean).toBeCloseTo(0.45);
    expect(pooled.betweenRepeatSd).toBeCloseTo(Math.sqrt(0.13));
    expect(pooled.betweenSessionSd).toBeCloseTo(Math.sqrt(0.005));
    expect(pooled.n).toBe(2);
    expect(pooled.lo).toBeLessThanOrEqual(pooled.mean);
    expect(pooled.hi).toBeGreaterThanOrEqual(pooled.mean);
  });

  it("counts cut replies and reports their input token count", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.mocked(undici.fetch).mockImplementation(async () => new undici.Response(JSON.stringify({ choices: [{ message: { content: "cut" }, finish_reason: "length" }], usage: { prompt_tokens: 180000 } })));
    try {
      const endpoint = { baseUrl: "http://example.invalid/v1", apiKey: "", model: "test" };
      resetRepliesCut();
      expect(await chat(endpoint, { max_tokens: 16 })).toEqual({ content: "cut" });
      expect(fetch.mock.calls[0]![1]?.dispatcher).toBeInstanceOf(undici.Agent);
      expect(repliesCut).toBe(1);
      expect(log).toHaveBeenCalledWith("chat: reply cut at max_tokens (180000 tokens in)");
      const opts = { fixture: loadFixture("small"), window: 32000, trigger: 0.9, maxRounds: 1 };
      const { rows } = await runBench({ ...opts, conditions: ["codex"], summarize: async (system, messages) => { await chat(endpoint, { max_tokens: 16 }); return fakeSummarize(system, messages); } });
      expect(rows).toContainEqual({ condition: "full", round: 1, metric: "replies_cut", value: 1 });
      await runBench({ ...opts, summarize: fakeSummarize, conditions: ["ledger"] });
      expect(repliesCut).toBe(0);
    } finally {
      fetch.mockRestore();
    }
  });

  it("reports empty probes, probe overflow and unparsed judges, and resets session counters", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await generateProbes(async () => { throw new OverflowError(); }, [userMessage("transcript")], 3)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/round 3 overflow \(\d+ slice tokens\)/));
    resetJudgeUnparsed();
    expect(await judge(async () => "thinking ".repeat(20), "q", "reference", "candidate")).toBe("wrong");
    expect(judgeUnparsed).toBe(1);
    expect(log).toHaveBeenCalledWith(`judge: unparsed reply ${JSON.stringify("thinking ".repeat(20).slice(0, 80))}`);
    const opts = { fixture: { ...loadFixture("small"), facts: undefined }, window: 32000, trigger: 0.9, summarize: fakeSummarize, conditions: ["ledger"] as (keyof typeof CONDITIONS)[], maxRounds: 1 };
    const { rows } = await runBench({ ...opts, ask: async () => "[]" });
    expect(rows).toContainEqual({ condition: "full", round: 1, metric: "probes_failed", value: 1 });
    expect(rows).toContainEqual({ condition: "full", round: 1, metric: "judge_unparsed", value: 0 });
    const ask = async (system: string) => system.startsWith("You grade") ? "" : system.startsWith("You are a coding agent") ? "A candidate answer." : '[{"kind":"state","question":"q","answer":"the reference answer"}]';
    const scored = await runBench({ ...opts, ask });
    expect(scored.rows).toContainEqual({ condition: "full", round: 1, metric: "judge_unparsed", value: 1 });
  });
});
