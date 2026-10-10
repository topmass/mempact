import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectFileOps, renderFileOps } from "../core/fileOps.ts";
import { artifactIdIn, searchTexts } from "../core/recall.ts";
import { clearedStub } from "../core/toolClearing.ts";
import extension from "../pi/index.ts";

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

  it("moves a re-touched path to the end", () => {
    const ops = collectFileOps([call("read", { path: "a.ts" }), call("read", { path: "old.ts" }), call("read", { path: "a.ts" })]);
    expect(ops.readFiles).toEqual(["old.ts", "a.ts"]);
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

describe("artifacts for big tool outputs", () => {
  it("saves the full output, names it in the truncation marker, and recall pages it by line range", async () => {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const tools: Record<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }> = {};
    extension({
      on: (name: string, fn: (...a: unknown[]) => unknown) => (handlers[name] = fn),
      registerTool: (t: { name: string }) => (tools[t.name] = t as never),
      registerCommand: () => {},
    } as never);
    const cwd = mkdtempSync(join(tmpdir(), "mempact-artifact-"));
    const full = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");

    const out = handlers.tool_result!({ content: [{ type: "text", text: full }] }, { cwd }) as { content: { text: string }[] };
    const truncated = out.content[0]!.text;
    const id = artifactIdIn(truncated)!;
    expect(truncated).toContain(`[full output saved as artifact ${id}, ${full.length} bytes;`);
    expect(readFileSync(join(cwd, ".mempact", "artifacts", `${id}.txt`), "utf8")).toBe(full);
    expect(clearedStub(truncated)).toContain(`full output is artifact ${id}`);

    const page = await tools.recall!.execute("t", { artifact: id, lines: "1500-1502" }, undefined, undefined, { cwd });
    expect(page.content[0]!.text).toBe("lines 1500-1502 of 3000:\n1500| line 1500\n1501| line 1501\n1502| line 1502");
    const bad = await tools.recall!.execute("t", { artifact: "../../etc/passwd" }, undefined, undefined, { cwd });
    expect(bad.content[0]!.text).toContain("No artifact");
  });
});
