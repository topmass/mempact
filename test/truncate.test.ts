/**
 * Parity tests ported from:
 * - reference/codex-rs/utils/string/src/truncate/tests.rs
 * - reference/codex-rs/utils/output-truncation/src/truncate_tests.rs
 * Expectations are byte-exact copies of the Rust assertions.
 */

import { describe, expect, it } from "vitest";
import {
  approxTokenCount,
  splitString,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget,
} from "../core/truncate.ts";
import {
  bytesPolicy,
  formattedTruncateText,
  tokensPolicy,
  truncateFunctionOutputItemsWithPolicy,
  truncateText,
} from "../core/outputTruncation.ts";
import type { FunctionCallOutputContentItem } from "../core/items.ts";

describe("splitString (truncate/tests.rs)", () => {
  it("split_string_works", () => {
    expect(splitString("hello world", 5, 5)).toEqual([1, "hello", "world"]);
    expect(splitString("abc", 0, 0)).toEqual([3, "", ""]);
  });

  it("split_string_handles_empty_string", () => {
    expect(splitString("", 4, 4)).toEqual([0, "", ""]);
  });

  it("split_string_only_keeps_prefix_when_tail_budget_is_zero", () => {
    expect(splitString("abcdef", 3, 0)).toEqual([3, "abc", ""]);
  });

  it("split_string_only_keeps_suffix_when_prefix_budget_is_zero", () => {
    expect(splitString("abcdef", 0, 3)).toEqual([3, "", "def"]);
  });

  it("split_string_handles_overlapping_budgets_without_removal", () => {
    expect(splitString("abcdef", 4, 4)).toEqual([0, "abcd", "ef"]);
  });

  it("split_string_respects_utf8_boundaries", () => {
    expect(splitString("😀abc😀", 5, 5)).toEqual([1, "😀a", "c😀"]);
    expect(splitString("😀😀😀😀😀", 1, 1)).toEqual([5, "", ""]);
    expect(splitString("😀😀😀😀😀", 7, 7)).toEqual([3, "😀", "😀"]);
    expect(splitString("😀😀😀😀😀", 8, 8)).toEqual([1, "😀😀", "😀😀"]);
  });
});

describe("truncateMiddleWithTokenBudget (truncate/tests.rs)", () => {
  it("returns original when under limit", () => {
    expect(truncateMiddleWithTokenBudget("short output", 100)).toEqual(["short output", null]);
  });

  it("reports truncation at zero limit", () => {
    expect(truncateMiddleWithTokenBudget("abcdef", 0)).toEqual(["…2 tokens truncated…", 2]);
  });

  it("handles utf8 content", () => {
    const s = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n";
    expect(truncateMiddleWithTokenBudget(s, 8)).toEqual([
      "😀😀😀😀…8 tokens truncated… line with text\n",
      16,
    ]);
  });
});

describe("truncateMiddleChars (truncate/tests.rs)", () => {
  it("handles utf8 content", () => {
    const s = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n";
    expect(truncateMiddleChars(s, 20)).toBe("😀😀…21 chars truncated…with text\n");
  });
});

describe("formattedTruncateText (truncate_tests.rs)", () => {
  it("truncate_bytes_less_than_placeholder_returns_placeholder", () => {
    expect(formattedTruncateText("example output", bytesPolicy(1))).toBe(
      "Warning: truncated output (original token count: 4)\nTotal output lines: 1\n\n…13 chars truncated…t",
    );
  });

  it("truncate_tokens_less_than_placeholder_returns_placeholder", () => {
    expect(formattedTruncateText("example output", tokensPolicy(1))).toBe(
      "Warning: truncated output (original token count: 4)\nTotal output lines: 1\n\nex…3 tokens truncated…ut",
    );
  });

  it("returns original under limit (tokens and bytes)", () => {
    expect(formattedTruncateText("example output", tokensPolicy(10))).toBe("example output");
    expect(formattedTruncateText("example output", bytesPolicy(20))).toBe("example output");
  });

  it("truncate_tokens_over_limit_returns_truncated", () => {
    const content = "this is an example of a long output that should be truncated";
    expect(formattedTruncateText(content, tokensPolicy(5))).toBe(
      "Warning: truncated output (original token count: 15)\nTotal output lines: 1\n\nthis is an…10 tokens truncated… truncated",
    );
  });

  it("truncate_bytes_over_limit_returns_truncated", () => {
    const content = "this is an example of a long output that should be truncated";
    expect(formattedTruncateText(content, bytesPolicy(30))).toBe(
      "Warning: truncated output (original token count: 15)\nTotal output lines: 1\n\nthis is an exam…30 chars truncated…ld be truncated",
    );
  });

  it("truncate_bytes_reports_original_line_count_when_truncated", () => {
    const content =
      "this is an example of a long output that should be truncated\nalso some other line";
    expect(formattedTruncateText(content, bytesPolicy(30))).toBe(
      "Warning: truncated output (original token count: 21)\nTotal output lines: 2\n\nthis is an exam…51 chars truncated…some other line",
    );
  });

  it("truncate_tokens_reports_original_line_count_when_truncated", () => {
    const content =
      "this is an example of a long output that should be truncated\nalso some other line";
    expect(formattedTruncateText(content, tokensPolicy(10))).toBe(
      "Warning: truncated output (original token count: 21)\nTotal output lines: 2\n\nthis is an example o…11 tokens truncated…also some other line",
    );
  });

  it("truncate_middle_bytes_handles_utf8_content (via truncateText)", () => {
    const s = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n";
    expect(truncateText(s, bytesPolicy(20))).toBe("😀😀…21 chars truncated…with text\n");
  });
});

describe("truncateFunctionOutputItemsWithPolicy (truncate_tests.rs)", () => {
  it("truncates_across_multiple_under_limit_texts_and_reports_omitted", () => {
    const chunk =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.\n";
    const chunkTokens = approxTokenCount(chunk);
    expect(chunkTokens).toBeGreaterThan(0);
    const limit = chunkTokens * 3;
    const items: FunctionCallOutputContentItem[] = [
      { type: "input_text", text: chunk },
      { type: "input_text", text: chunk },
      { type: "input_image", imageUrl: "img:mid" },
      { type: "input_text", text: chunk.repeat(10) },
      { type: "input_text", text: chunk },
      { type: "input_text", text: chunk },
    ];

    const out = truncateFunctionOutputItemsWithPolicy(items, tokensPolicy(limit));

    expect(out.length).toBe(5);
    expect(out[0]).toEqual({ type: "input_text", text: chunk });
    expect(out[1]).toEqual({ type: "input_text", text: chunk });
    expect(out[2]).toEqual({ type: "input_image", imageUrl: "img:mid" });
    expect((out[3] as { text: string }).text).toContain("tokens truncated");
    expect((out[4] as { text: string }).text).toContain("omitted 2 text items");
  });

  it("preserves encrypted content untouched", () => {
    const items: FunctionCallOutputContentItem[] = [
      { type: "input_text", text: "x".repeat(100) },
      { type: "encrypted_content", encryptedContent: "opaque-blob" },
    ];
    const out = truncateFunctionOutputItemsWithPolicy(items, bytesPolicy(10));
    expect(out).toContainEqual({ type: "encrypted_content", encryptedContent: "opaque-blob" });
  });
});
