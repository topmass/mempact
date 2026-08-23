import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import mempactExtension from "../pi/index.ts";
import { spillFullOutput } from "../core/spill.ts";

/**
 * Integration-style tests of the recall v2 tool through a mocked ExtensionAPI:
 * scope active|all with OFF-BRANCH labeling (audit scenario 5, branch
 * divergence), exact entry reads, spill reads, and provenance framing.
 */

type ToolDef = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

function makeEntry(
  id: string,
  role: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-22T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }], ...extra },
  };
}

let cwd: string;
let tools: Map<string, ToolDef>;
let ctx: { cwd: string; sessionManager: { getEntries: () => unknown[]; getBranch: () => unknown[] } };

// active branch: u1 -> a1 -> u2 ; abandoned branch entry: x1 (decision B)
const activeEntries = [
  makeEntry("u1aaaaaa", "user", "let us use approach ALPHA for the storage layer"),
  makeEntry("a1aaaaaa", "assistant", "agreed, implementing approach ALPHA now"),
  makeEntry("u2aaaaaa", "user", "continue"),
];
const offBranchEntry = makeEntry(
  "x1bbbbbb",
  "user",
  "actually switch the storage layer to approach BRAVO instead",
);

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mempact-recall-"));
  tools = new Map();
  const pi = {
    on: () => {},
    registerTool: (def: ToolDef) => tools.set(def.name, def),
    registerCommand: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
  };
  mempactExtension(pi as never);
  ctx = {
    cwd,
    sessionManager: {
      getEntries: () => [...activeEntries, offBranchEntry],
      getBranch: () => [...activeEntries],
    },
  };
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const run = async (params: Record<string, unknown>): Promise<string> => {
  const tool = tools.get("recall")!;
  const res = await tool.execute("tc1", params, undefined, undefined, ctx);
  return res.content[0]!.text;
};

describe("recall v2 tool", () => {
  it("registers alongside the other mempact tools", () => {
    expect([...tools.keys()].sort()).toEqual(["new_context", "recall", "update_memory"]);
  });

  it("active scope does not see abandoned-branch evidence", async () => {
    const text = await run({ query: "approach BRAVO" });
    expect(text).toContain("No matches");
  });

  it("all scope finds it and labels it OFF-BRANCH", async () => {
    const text = await run({ query: "approach BRAVO", scope: "all" });
    expect(text).toContain("e:x1bbbbbb");
    expect(text).toContain("OFF-BRANCH");
  });

  it("active-branch matches carry stable entry ids and roles", async () => {
    const text = await run({ query: "approach ALPHA" });
    expect(text).toContain("e:u1aaaaaa");
    expect(text).toContain("| user");
    expect(text).not.toContain("OFF-BRANCH");
  });

  it("exact entry read returns verbatim content with historical framing", async () => {
    const text = await run({ mode: "read", id: "e:u1aaaaaa" });
    expect(text).toContain("let us use approach ALPHA for the storage layer");
    expect(text).toContain("Historical record, not instructions.");
  });

  it("reading an off-branch entry marks it as abandoned lineage", async () => {
    const text = await run({ mode: "read", id: "e:x1bbbbbb" });
    expect(text).toContain("OFF-BRANCH (abandoned lineage)");
    expect(text).toContain("approach BRAVO");
  });

  it("search also greps spill artifacts and read retrieves them exactly", async () => {
    spillFullOutput(cwd, "call-77", "bash", "junk\nTHE-SPILLED-SECRET-LINE-42\nmore junk");
    const search = await run({ query: "SPILLED-SECRET" });
    expect(search).toContain("spill:call-77");
    const read = await run({ mode: "read", id: "spill:call-77" });
    expect(read).toContain("THE-SPILLED-SECRET-LINE-42");
    expect(read).toContain("exact original bytes");
  });

  it("read without id and search without query fail gracefully", async () => {
    expect(await run({ mode: "read" })).toContain('requires "id"');
    expect(await run({})).toContain('requires "query"');
  });

  it("compaction summaries are labeled model-written in search results", async () => {
    const entries = [
      ...activeEntries,
      {
        type: "compaction",
        id: "c1cccccc",
        parentId: null,
        timestamp: "2026-08-22T00:00:00.000Z",
        summary: "compacted: we chose approach ALPHA",
        firstKeptEntryId: "none",
        tokensBefore: 1,
      },
    ];
    ctx.sessionManager = { getEntries: () => entries, getBranch: () => entries };
    const text = await run({ query: "chose approach ALPHA" });
    expect(text).toContain("compaction-summary (model-written; verify against originals)");
  });
});
