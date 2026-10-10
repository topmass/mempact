import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SUMMARY_PREFIX, summaryBridgeText } from "../core/compact.ts";
import { OverflowError, compactWindow, tailStartIndex } from "../core/pipeline.ts";
import { NARRATIVE_SECTIONS } from "../core/summarySchema.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const edit = (id: string, path: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path } }] });
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] });

const good = NARRATIVE_SECTIONS.map((s) => `## ${s}\n${s === "Next step" ? "Finish b.ts." : "None"}`).join("\n\n");
const flat = (msgs: Message[]) => JSON.stringify(msgs);

// 10 messages, 10 tokens each
const session = [
  user("first ask"),
  edit("a", "a.ts"),
  result("a"),
  text("done a"),
  user("second ask"),
  { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "edit", arguments: { path: "b.ts" } }, { type: "toolCall", id: "b2", name: "read", arguments: { path: "c.ts" } }] },
  result("b1"),
  result("b2"),
  text("done b"),
  user("third ask"),
] as unknown as Message[];

const run = (replies: (string | Error)[], extra: Partial<Parameters<typeof compactWindow>[0]> = {}) => {
  const calls: Message[][] = [];
  const out = compactWindow(
    { messages: session, contextWindow: 400, maxOutputTokens: 1000, ...extra },
    {
      estimateTokens: () => 10,
      summarize: async (_sys, msgs) => {
        calls.push(msgs);
        const r = replies.shift() ?? good;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  );
  return { out, calls };
};

describe("tailStartIndex", () => {
  it("cuts only where an assistant tool call keeps all of its results", () => {
    for (let budget = 0; budget <= 100; budget += 5) {
      const start = tailStartIndex(session, 0, budget, () => 10);
      expect(session[start]?.role).not.toBe("toolResult");
    }
    // 40 tokens would start at result("b1"); the cut moves to after the pair
    expect(tailStartIndex(session, 0, 40, () => 10)).toBe(8);
    expect(tailStartIndex(session, 0, 50, () => 10)).toBe(5);
  });
});

describe("compactWindow", () => {
  it("keeps the tail verbatim, summarizes the rest, and composes the summary message", async () => {
    const { out, calls } = run([good]);
    const r = await out;
    // contextWindow 400 -> a 40-token tail budget -> tail starts after the b pair
    expect(r.rawTail).toEqual(session.slice(8));
    expect(calls).toHaveLength(1);
    expect(flat(calls[0]!)).not.toContain("done b");
    expect(r.retainedUserMessages).toEqual(["first ask", "second ask"]);
    expect(r.summaryText.startsWith(`${SUMMARY_PREFIX}\n## Goal`)).toBe(true);
    expect(r.summaryText).toContain("<ledger>");
    expect(r.rehydratePaths).toEqual(["b.ts", "a.ts"]);
    expect(r.validation).toEqual({ failures: [], retried: false });
  });

  it("retries once with the failures, then accepts with a note", async () => {
    const fixed = run(["Continue the task.", good]);
    expect((await fixed.out).validation).toEqual({ failures: [], retried: true });
    expect(fixed.calls).toHaveLength(2);
    expect(flat(fixed.calls[1]!)).toContain('missing section \\"Goal\\"');

    const still = run(["bad", "still bad"]);
    const r = await still.out;
    expect(still.calls).toHaveLength(2);
    expect(r.narrative).toContain("[checkpoint note: still failing after one retry");
  });

  it("gives the summarizer the prior narrative, never a previous summary", async () => {
    const withOld = [user(summaryBridgeText("OLD SUMMARY <ledger>x</ledger>")), ...session] as Message[];
    const { out, calls } = run([good], { messages: withOld, previous: { narrative: "PRIOR STORY", start: 0 } });
    await out;
    expect(flat(calls[0]!)).toContain("PRIOR STORY");
    expect(flat(calls[0]!)).not.toContain("OLD SUMMARY");
  });

  it("skips the model when the tail holds the whole window", async () => {
    const { out, calls } = run([], { contextWindow: 10_000, previous: { narrative: "KEEP ME", start: 0 } });
    const r = await out;
    expect(calls).toHaveLength(0);
    expect(r.rawTail).toEqual(session);
    expect(r.narrative).toBe("KEEP ME");
  });

  it("drops the oldest message and its orphaned results on overflow", async () => {
    const { out, calls } = run([new OverflowError(), good], { previous: { narrative: "", start: 1 } });
    await out;
    expect(calls[0]![0]).toMatchObject({ role: "assistant" });
    expect(calls[1]![0]).toMatchObject({ role: "assistant", content: [{ text: "done a" }] });
  });
});
