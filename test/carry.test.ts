import { describe, expect, it } from "vitest";
import { CARRIED_LINE, carryDroppedItems } from "../core/carry.ts";
import { NARRATIVE_SECTIONS, parseSections } from "../core/summarySchema.ts";

const narrative = (bodies: Record<string, string>) => NARRATIVE_SECTIONS.map((s) => `## ${s}\n${bodies[s] ?? "None"}`).join("\n\n");

describe("carryDroppedItems", () => {
  it("carries a dropped Findings bullet under the carried line", () => {
    const prev = narrative({ Findings: "- parseConfig throws on empty YAML files\n- cache keys ignore the locale" });
    const out = carryDroppedItems(prev, narrative({ Findings: "- cache keys ignore the locale" }));
    expect(parseSections(out).get("findings")).toBe(`- cache keys ignore the locale\n\n${CARRIED_LINE}\n- parseConfig throws on empty YAML files`);
    expect(parseSections(out).get("next step")).toBe("None");
  });

  it("does not duplicate a bullet the model rewrote with most of its words", () => {
    const prev = narrative({ "Decisions and why": "- use sqlite because the tests need a real database file" });
    const next = narrative({ "Decisions and why": "- chose sqlite: the tests need a real database file on disk" });
    expect(carryDroppedItems(prev, next)).toBe(next);
  });

  it("never carries Goal", () => {
    const next = narrative({});
    expect(carryDroppedItems(narrative({ Goal: "- ship the importer rewrite" }), next)).toBe(next);
  });

  it("drops the oldest carried item first when over budget", () => {
    const big = (tag: string) => `${tag} ${"x".repeat(5_000)}`;
    const prev = narrative({ Findings: `- ${big("body")}\n\n${CARRIED_LINE}\n- ${big("older")}\n- ${big("newer")}` });
    const out = carryDroppedItems(prev, narrative({}));
    expect(out).not.toContain("older");
    expect(out).toContain("newer");
    expect(out).toContain("body");
  });

  it("keeps a carried item through a second round", () => {
    const round1 = carryDroppedItems(narrative({ "Approaches that failed": "- bumping the timeout did not stop the flake" }), narrative({}));
    const round2 = carryDroppedItems(round1, narrative({ "Approaches that failed": "- mocking the clock broke the retry test" }));
    expect(parseSections(round2).get("approaches that failed")).toBe(
      `- mocking the clock broke the retry test\n\n${CARRIED_LINE}\n- bumping the timeout did not stop the flake`,
    );
  });
});
