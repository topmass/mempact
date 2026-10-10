import { describe, expect, it } from "vitest";
import { fakeSummarize, loadFixture, runBench } from "../bench/run.ts";

describe("bench harness", () => {
  it("runs the small fixture offline, and mempact's ledger keeps every planted file and live constraint across rounds", async () => {
    const rows = await runBench({ fixture: loadFixture("small"), window: 32_000, trigger: 0.9, summarize: fakeSummarize });
    const rounds = new Set(rows.map((r) => r.round));
    expect(rounds.size).toBeGreaterThanOrEqual(3);
    for (const condition of ["pi", "codex", "mempact"]) for (const round of rounds) expect(rows.some((r) => r.condition === condition && r.round === round)).toBe(true);
    const mempact = (metric: string) => rows.filter((r) => r.condition === "mempact" && r.metric === metric).map((r) => r.value);
    expect(mempact("files")).toEqual([...rounds].map(() => 1));
    expect(mempact("live_constraints")).toEqual([...rounds].map(() => 1));
  });
});
