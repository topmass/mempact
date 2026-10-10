import { describe, expect, it } from "vitest";
import { buildLedger } from "../core/ledger.ts";
import { NARRATIVE_SECTIONS, markTruncatedSummary, validateSummary } from "../core/summarySchema.ts";

const narrative = (next: string, skip?: string) =>
  NARRATIVE_SECTIONS.filter((s) => s !== skip)
    .map((s) => `## ${s}\n${s === "Next step" ? next : "None"}`)
    .join("\n\n");

const edited = buildLedger([{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "edit", arguments: { path: "src/auth/token.ts" } }] }]);

describe("validateSummary", () => {
  it("accepts a complete narrative whose next step names a modified file", () => {
    expect(validateSummary(narrative("Fix the expiry check in token.ts."), edited)).toEqual([]);
  });

  it("catches a missing and an empty section", () => {
    expect(validateSummary(narrative("x", "Approaches that failed"), buildLedger([]))).toEqual(['missing section "Approaches that failed"']);
    expect(validateSummary(narrative(""), buildLedger([]))).toEqual(['empty section "Next step"']);
  });

  it("catches a generic next step only when the ledger has files or commands", () => {
    expect(validateSummary(narrative("Continue the task."), edited)).toHaveLength(1);
    expect(validateSummary(narrative("Continue the task."), buildLedger([]))).toEqual([]);
  });

  it("catches a summary cut off by the output limit", () => {
    const cut = markTruncatedSummary(`${narrative("Edit token.ts")}\nand then do NOT re-run the migr`);
    expect(validateSummary(cut, edited)).toEqual(["cut off by the output limit; write it shorter"]);
  });
});
