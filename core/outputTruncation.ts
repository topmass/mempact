/**
 * Ported from codex-rs/utils/output-truncation/src/lib.rs plus the
 * TruncationPolicy type from codex-rs/protocol/src/protocol.rs:3151-3201.
 */

import type { FunctionCallOutputContentItem } from "./items.ts";
import {
  approxBytesForTokens,
  approxTokenCount,
  approxTokensFromByteCount,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget,
} from "./truncate.ts";

// protocol.rs:3153 TruncationPolicy
export type TruncationPolicy =
  | { mode: "bytes"; limit: number }
  | { mode: "tokens"; limit: number };

export const bytesPolicy = (limit: number): TruncationPolicy => ({ mode: "bytes", limit });
export const tokensPolicy = (limit: number): TruncationPolicy => ({ mode: "tokens", limit });

/**
 * Default per-tool-output policy applied when recording into history:
 * codex-rs/protocol/src/openai_models.rs:674 TruncationPolicyConfig::bytes(10_000).
 */
export const DEFAULT_TRUNCATION_POLICY: TruncationPolicy = bytesPolicy(10_000);

/**
 * Serialization slack applied at record time:
 * codex-rs/core/src/context_manager/history.rs:363 `policy * 1.2`.
 */
export const SERIALIZATION_BUDGET_MULTIPLIER = 1.2;

/** protocol.rs:3167 token_budget */
export function tokenBudget(policy: TruncationPolicy): number {
  return policy.mode === "bytes" ? approxTokensFromByteCount(policy.limit) : policy.limit;
}

/** protocol.rs:3178 byte_budget */
export function byteBudget(policy: TruncationPolicy): number {
  return policy.mode === "bytes" ? policy.limit : approxBytesForTokens(policy.limit);
}

/** protocol.rs:3188 Mul<f64>: scale the limit, ceil */
export function mulPolicy(policy: TruncationPolicy, multiplier: number): TruncationPolicy {
  return { mode: policy.mode, limit: Math.ceil(policy.limit * multiplier) };
}

const encoder = new TextEncoder();
const utf8Len = (s: string): number => encoder.encode(s).length;

/** lib.rs:25 truncate_text */
export function truncateText(content: string, policy: TruncationPolicy): string {
  return policy.mode === "bytes"
    ? truncateMiddleChars(content, policy.limit)
    : truncateMiddleWithTokenBudget(content, policy.limit)[0];
}

/** lib.rs:12 formatted_truncate_text */
export function formattedTruncateText(content: string, policy: TruncationPolicy): string {
  if (utf8Len(content) <= byteBudget(policy)) {
    return content;
  }

  const originalTokenCount = approxTokenCount(content);
  // Rust `str::lines()` counts lines without a trailing empty line.
  const totalLines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
  const result = truncateText(content, policy);
  return `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${totalLines}\n\n${result}`;
}

/**
 * lib.rs:83 truncate_function_output_items_with_policy - walk content items
 * spending a shared budget; oversized item gets a middle-truncated snippet,
 * later text items are dropped behind an `[omitted N text items ...]`
 * trailer; images and encrypted content pass through untouched.
 */
export function truncateFunctionOutputItemsWithPolicy(
  items: readonly FunctionCallOutputContentItem[],
  policy: TruncationPolicy,
): FunctionCallOutputContentItem[] {
  const out: FunctionCallOutputContentItem[] = [];
  let remainingBudget = policy.mode === "bytes" ? byteBudget(policy) : tokenBudget(policy);
  let omittedTextItems = 0;

  for (const item of items) {
    if (item.type === "input_text") {
      if (remainingBudget === 0) {
        omittedTextItems += 1;
        continue;
      }

      const cost = policy.mode === "bytes" ? utf8Len(item.text) : approxTokenCount(item.text);

      if (cost <= remainingBudget) {
        out.push({ ...item });
        remainingBudget -= cost;
      } else {
        const snippet = truncateText(item.text, { mode: policy.mode, limit: remainingBudget });
        if (snippet.length === 0) {
          omittedTextItems += 1;
        } else {
          out.push({ type: "input_text", text: snippet });
        }
        remainingBudget = 0;
      }
    } else {
      out.push({ ...item });
    }
  }

  if (omittedTextItems > 0) {
    out.push({ type: "input_text", text: `[omitted ${omittedTextItems} text items ...]` });
  }

  return out;
}
