import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { paired } from "../bench/aggregate.ts";
import { contentText } from "../core/items.ts";
import { fakeSummarize, loadFixture, runBench } from "../bench/run.ts";

describe("bench harness", () => {
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
    expect([p.mean, p.lo, p.hi].map((x) => Number(x.toFixed(6)))).toEqual([0.2, 0.2, 0.2]);
    const q = paired(sessions, "mempact", "pi")!;
    expect([q.wins, q.ties, q.losses]).toEqual([2, 1, 0]);
    expect(q.lo).toBeLessThanOrEqual(q.mean);
    expect(q.hi).toBeGreaterThanOrEqual(q.mean);
  });
});
