/**
 * Tests for the portable remote-compaction behaviors, covering the cases in
 * reference/codex-rs/core/src/compact_remote_v2.rs tests and
 * compact_remote.rs trim/filter logic.
 */

import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
  isRetainedMessage,
  messageTextTokenCount,
  shouldKeepCompactedHistoryItem,
  trimFunctionCallHistoryToFitContextWindow,
  truncateRetainedMessages,
} from "../core/remoteRetention.ts";
import { messageText } from "../core/items.ts";
import type { HistoryItem } from "../core/items.ts";

const user = (text: string): HistoryItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

describe("shouldKeepCompactedHistoryItem (compact_remote.rs:341)", () => {
  it("drops developer messages, tool items, reasoning, and triggers", () => {
    expect(
      shouldKeepCompactedHistoryItem({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "instructions" }],
      }),
    ).toBe(false);
    expect(
      shouldKeepCompactedHistoryItem({ type: "function_call", name: "t", arguments: "", callId: "c" }),
    ).toBe(false);
    expect(shouldKeepCompactedHistoryItem({ type: "reasoning" })).toBe(false);
    expect(shouldKeepCompactedHistoryItem({ type: "compaction_trigger" })).toBe(false);
  });

  it("keeps user text, assistant messages, and compaction markers", () => {
    expect(shouldKeepCompactedHistoryItem(user("hello"))).toBe(true);
    expect(
      shouldKeepCompactedHistoryItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "reply" }],
      }),
    ).toBe(true);
    expect(shouldKeepCompactedHistoryItem({ type: "compaction", encryptedContent: "x" })).toBe(true);
  });
});

describe("truncateRetainedMessages (compact_remote_v2.rs:478)", () => {
  it("selects newest-first under the budget", () => {
    const old = user("old ".repeat(100).trim()); // ~100 tokens
    const recent = user("recent message");
    const kept = truncateRetainedMessages([old, recent], 10);
    // recent kept whole; old truncated into the remaining budget
    expect(messageText(kept[kept.length - 1]!)).toBe("recent message");
    expect(kept.length).toBe(2);
    expect(messageText(kept[0]!)).toContain("tokens truncated");
  });

  it("preserves images at zero text cost", () => {
    const withImage: HistoryItem = {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", imageUrl: "data:image/png;base64,AAAA" },
        { type: "input_text", text: "caption" },
      ],
    };
    expect(messageTextTokenCount(withImage)).toBe(2); // only "caption"
    const kept = truncateRetainedMessages([withImage], 2);
    expect((kept[0] as { content: unknown[] }).content.length).toBe(2);
  });

  it("skips zero-budget leftovers entirely", () => {
    const kept = truncateRetainedMessages([user("a"), user("b"), user("c")], 1);
    expect(kept.length).toBe(1);
    expect(messageText(kept[0]!)).toBe("c");
  });
});

describe("isRetainedMessage (compact_remote_v2.rs:459)", () => {
  it("keeps user/developer/system messages only", () => {
    expect(isRetainedMessage(user("u"))).toBe(true);
    expect(
      isRetainedMessage({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "a" }],
      }),
    ).toBe(false);
    expect(isRetainedMessage({ type: "reasoning" })).toBe(false);
  });
});

describe("trimFunctionCallHistoryToFitContextWindow (compact_remote.rs:369)", () => {
  it("stubs tool outputs tail-first until the estimate fits", () => {
    const items: HistoryItem[] = [
      user("start"),
      { type: "function_call", name: "t", arguments: "{}", callId: "c1" },
      { type: "function_call_output", callId: "c1", output: { content: "x".repeat(40_000) } },
      { type: "function_call", name: "t", arguments: "{}", callId: "c2" },
      { type: "function_call_output", callId: "c2", output: { content: "y".repeat(40_000) } },
    ];
    // ~20k tokens of outputs; window of 12k requires stubbing at least one.
    const [rewritten, deleted] = trimFunctionCallHistoryToFitContextWindow(items, 12_000, "base");
    expect(rewritten).toBeGreaterThan(0);
    expect(deleted).toBeGreaterThan(0);
    // tail output stubbed first
    const lastOutput = items[4] as { output: { content: string } };
    expect(lastOutput.output.content).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
  });

  it("does nothing when the estimate already fits", () => {
    const items: HistoryItem[] = [user("small")];
    expect(trimFunctionCallHistoryToFitContextWindow(items, 100_000, "base")).toEqual([0, 0]);
    expect(messageText(items[0]!)).toBe("small");
  });

  it("returns [0,0] with no context window", () => {
    expect(trimFunctionCallHistoryToFitContextWindow([user("x")], null, "")).toEqual([0, 0]);
  });
});
