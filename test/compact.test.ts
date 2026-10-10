/**
 * Parity tests ported from reference/codex-rs/core/src/compact_tests.rs
 * (the pure-function cases; session-bound cases like
 * process_compacted_history_* need a live codex session and are covered by
 * the pi extension's live verification instead).
 */

import { describe, expect, it } from "vitest";
import {
  SUMMARY_PREFIX,
  buildCompactedHistory,
  buildCompactedHistoryWithLimit,
  collectUserMessages,
  isSummaryMessage,
  summaryBridgeText,
} from "../core/compact.ts";
import { contentItemsToText, messageText } from "../core/items.ts";
import type { HistoryItem } from "../core/items.ts";
import { markTruncatedSummary } from "../pi/index.ts";

const userMessage = (text: string): HistoryItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const assistantMessage = (text: string): HistoryItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

describe("contentItemsToText (compact_tests.rs:47,66)", () => {
  it("joins non-empty segments", () => {
    expect(
      contentItemsToText([
        { type: "input_text", text: "hello" },
        { type: "output_text", text: "" },
        { type: "output_text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });

  it("ignores image-only content", () => {
    expect(contentItemsToText([{ type: "input_image", imageUrl: "file://image.png" }])).toBeNull();
  });
});

describe("collectUserMessages (compact_tests.rs:78)", () => {
  it("extracts user text only", () => {
    const items: HistoryItem[] = [assistantMessage("ignored"), userMessage("first"), { type: "other" }];
    expect(collectUserMessages(items)).toEqual([{ message: "first" }]);
  });

  it("skips previous compaction summaries", () => {
    const items = [userMessage(summaryBridgeText("old summary")), userMessage("real")];
    expect(collectUserMessages(items)).toEqual([{ message: "real" }]);
  });

  it("applies the contextual-message predicate (codex parse_turn_item filter)", () => {
    const items = [
      userMessage("<ENVIRONMENT_CONTEXT>cwd=/tmp</ENVIRONMENT_CONTEXT>"),
      userMessage("real user message"),
    ];
    expect(collectUserMessages(items, (t) => t.startsWith("<ENVIRONMENT_CONTEXT>"))).toEqual([
      { message: "real user message" },
    ]);
  });
});

describe("buildCompactedHistory (compact_tests.rs:169,212)", () => {
  it("truncates overlong user messages under the token limit", () => {
    const maxTokens = 16;
    const big = "word ".repeat(200);
    const history = buildCompactedHistoryWithLimit([], [{ message: big }], "SUMMARY", maxTokens);
    expect(history.length).toBe(2);

    const truncatedText = messageText(history[0]!)!;
    expect(truncatedText).toContain("tokens truncated");
    expect(truncatedText).not.toContain(big);

    expect(messageText(history[1]!)).toBe("SUMMARY");
  });

  it("appends summary message last", () => {
    const history = buildCompactedHistory([], [{ message: "first user message" }], "summary text");
    expect(history.length).toBeGreaterThan(0);
    expect(messageText(history[history.length - 1]!)).toBe("summary text");
  });

  it("selects newest-first under the budget", () => {
    // Each message ~5 tokens ("word word word word" = 19 bytes -> 5 tokens);
    // budget of 6 keeps the newest fully and truncates the older one.
    const messages = [{ message: "older ".repeat(4).trim() }, { message: "newest msg" }];
    const history = buildCompactedHistoryWithLimit([], messages, "S", 6);
    // order preserved oldest-first, summary last
    expect(messageText(history[history.length - 2]!)).toBe("newest msg");
    expect(messageText(history[history.length - 1]!)).toBe("S");
  });

  it('falls back to "(no summary available)" for empty summaries', () => {
    const history = buildCompactedHistory([], [], "");
    expect(messageText(history[history.length - 1]!)).toBe("(no summary available)");
  });
});

describe("isSummaryMessage (compact.rs:495)", () => {
  it("matches only the exact prefix + newline", () => {
    expect(isSummaryMessage(`${SUMMARY_PREFIX}\nrest`)).toBe(true);
    expect(isSummaryMessage(SUMMARY_PREFIX)).toBe(false);
    expect(isSummaryMessage("unrelated")).toBe(false);
  });
});

describe("markTruncatedSummary (pi/index.ts)", () => {
  it("cuts at the latest complete boundary, not the first boundary type found", () => {
    const out = markTruncatedSummary("## Summary\n\nFixed the parser. Added a test. Then started on the cach");
    expect(out.startsWith("## Summary\n\nFixed the parser. Added a test.\n\n[summary truncated")).toBe(true);
  });
});
