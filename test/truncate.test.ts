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
import { bytesPolicy, truncateText } from "../core/outputTruncation.ts";

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

describe("truncateText (truncate_tests.rs)", () => {
  it("truncate_middle_bytes_handles_utf8_content (via truncateText)", () => {
    const s = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n";
    expect(truncateText(s, bytesPolicy(20))).toBe("😀😀…21 chars truncated…with text\n");
  });
});
