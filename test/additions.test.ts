import { describe, expect, it } from "vitest";
import { collectFileOps, renderFileOps } from "../core/fileOps.ts";
import { searchTexts } from "../core/recall.ts";

const call = (name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "c1", name, arguments: args }],
});

describe("deterministic file-op tracking", () => {
  it("splits reads from writes/edits and ignores other tools", () => {
    const ops = collectFileOps([
      call("read", { path: "src/a.ts" }),
      call("edit", { path: "src/b.ts" }),
      call("write", { path: "src/c.ts" }),
      call("bash", { command: "ls" }),
      { role: "user", content: [{ type: "text", text: "read src/x.ts please" }] },
    ]);
    expect(ops.readFiles).toEqual(["src/a.ts"]);
    expect(ops.modifiedFiles).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("accepts file_path-style arguments", () => {
    const ops = collectFileOps([call("read", { file_path: "README.md" })]);
    expect(ops.readFiles).toEqual(["README.md"]);
  });

  it("merges cumulatively with previous lists, re-touched path moves to end", () => {
    const prev = { readFiles: ["old.ts", "a.ts"], modifiedFiles: ["m.ts"] };
    const ops = collectFileOps([call("read", { path: "a.ts" })], prev);
    expect(ops.readFiles).toEqual(["old.ts", "a.ts"]);
    expect(ops.modifiedFiles).toEqual(["m.ts"]);
  });

  it("caps each list, dropping oldest", () => {
    const msgs = Array.from({ length: 45 }, (_, i) => call("read", { path: `f${i}.ts` }));
    const ops = collectFileOps(msgs);
    expect(ops.readFiles).toHaveLength(40);
    expect(ops.readFiles[0]).toBe("f5.ts");
    expect(ops.readFiles[39]).toBe("f44.ts");
  });

  it("renders pi-style tag blocks, omitting empty lists", () => {
    expect(renderFileOps({ readFiles: [], modifiedFiles: [] })).toBe("");
    const out = renderFileOps({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
    expect(out).toBe("<read-files>\na.ts\n</read-files>\n<modified-files>\nb.ts\n</modified-files>");
  });
});

describe("recall search", () => {
  const items = [
    { label: "[entry 9 toolResult]", text: "x".repeat(600) + " exit code: 1 " + "y".repeat(600) },
    { label: "[entry 5 user]", text: "please fix the EXIT CODE: 1 failure" },
    { label: "[entry 2 assistant]", text: "nothing relevant here" },
  ];

  it("finds case-insensitive matches with provenance labels, clipped snippets", () => {
    const { total, results } = searchTexts(items, "exit code: 1");
    expect(total).toBe(2);
    expect(results[0]).toContain("[entry 9 toolResult]");
    expect(results[0]).toContain("exit code: 1");
    expect(results[0]!.length).toBeLessThan(450);
    expect(results[0]!.startsWith("[entry 9 toolResult] …")).toBe(true);
    expect(results[1]).toContain("[entry 5 user]");
  });

  it("counts all matches but returns at most maxResults", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `[${i}]`, text: "hit here" }));
    const { total, results } = searchTexts(many, "hit", 3);
    expect(total).toBe(9);
    expect(results).toHaveLength(3);
  });

  it("empty or whitespace query matches nothing", () => {
    expect(searchTexts(items, "   ").total).toBe(0);
  });
});
