import { describe, expect, it } from "vitest";
import {
  MEMORY_SECTIONS,
  appendToSection,
  emptyMemory,
  filesToRehydrate,
  getSection,
  renderForContext,
  setSection,
} from "../core/memory.ts";

describe("project memory", () => {
  it("seeds Goal from the spec and leaves other sections empty", () => {
    const m = emptyMemory("Ship the auth flow per spec.md");
    expect(getSection(m, "Goal")).toBe("Ship the auth flow per spec.md");
    expect(getSection(m, "Plan")).toBe("");
    for (const s of MEMORY_SECTIONS) expect(m).toContain(`## ${s}`);
  });

  it("sets a section wholesale without disturbing others", () => {
    let m = emptyMemory("goal");
    m = setSection(m, "Next", "run pnpm test and fix the failing case");
    expect(getSection(m, "Next")).toBe("run pnpm test and fix the failing case");
    expect(getSection(m, "Goal")).toBe("goal");
  });

  it("appends to the Decisions log without rewriting prior entries", () => {
    let m = emptyMemory("goal");
    m = appendToSection(m, "Decisions", "use zod for validation - smaller than joi");
    m = appendToSection(m, "Decisions", "sqlite over pg - single-file deploy");
    expect(getSection(m, "Decisions")).toBe(
      "use zod for validation - smaller than joi\nsqlite over pg - single-file deploy",
    );
  });

  it("append of an empty line is a no-op", () => {
    const m = emptyMemory("goal");
    expect(appendToSection(m, "Open", "   ")).toBe(m);
  });

  it("round-trips: parse-after-render keeps section content stable", () => {
    let m = emptyMemory("g");
    m = setSection(m, "Files", "src/a.ts - entry point\nsrc/b.ts - helpers");
    m = appendToSection(m, "Plan", "[x] scaffold");
    m = appendToSection(m, "Plan", "[ ] wire routes");
    expect(getSection(m, "Files")).toContain("src/a.ts - entry point");
    expect(getSection(m, "Plan")).toBe("[x] scaffold\n[ ] wire routes");
  });

  it("repeated writes never duplicate hint comments", () => {
    let m = emptyMemory("g");
    m = setSection(m, "Goal", "new goal");
    m = appendToSection(m, "Decisions", "a decision");
    const hint = "<!-- Checklist of steps.";
    expect(m.split(hint).length - 1).toBe(1);
  });

  it("preserves sections a user hand-added to the file", () => {
    let m = emptyMemory("g");
    m += "\n## Scratch\nuser-added note\n";
    m = setSection(m, "Next", "do the thing");
    expect(m).toContain("## Scratch\nuser-added note");
    expect(getSection(m, "Next")).toBe("do the thing");
  });

  it("extracts file paths to re-read on resume", () => {
    let m = emptyMemory("g");
    m = setSection(m, "Files", "src/auth.ts — token logic\n- src/db.ts - schema");
    expect(filesToRehydrate(m)).toEqual(["src/auth.ts", "src/db.ts"]);
  });

  it("renders a trust-framed context block", () => {
    const block = renderForContext(emptyMemory("do the thing"));
    expect(block).toContain("<project_memory>");
    expect(block).toContain("SURVIVES context compaction");
    expect(block).toContain("do the thing");
    expect(block).not.toContain("<!--"); // hint comments stay in the file only
  });

  it("tail-caps long sections in the render but not in the file", () => {
    let m = emptyMemory("g");
    for (let i = 1; i <= 30; i++) m = appendToSection(m, "Decisions", `decision ${i}`);
    expect(getSection(m, "Decisions")).toContain("decision 1"); // file keeps all
    const block = renderForContext(m);
    expect(block).toContain("10 older lines elided");
    expect(block).toContain("decision 30");
    expect(block).not.toContain("decision 5\n");
  });
});
