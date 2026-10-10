/**
 * Ported from codex-rs/utils/output-truncation/src/lib.rs plus the
 * TruncationPolicy type from codex-rs/protocol/src/protocol.rs:3151-3201.
 */

import { approxBytesForTokens, truncateMiddleChars, truncateMiddleWithTokenBudget } from "./truncate.ts";

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

/** protocol.rs:3178 byte_budget */
export function byteBudget(policy: TruncationPolicy): number {
  return policy.mode === "bytes" ? policy.limit : approxBytesForTokens(policy.limit);
}

/** protocol.rs:3188 Mul<f64>: scale the limit, ceil */
export function mulPolicy(policy: TruncationPolicy, multiplier: number): TruncationPolicy {
  return { mode: policy.mode, limit: Math.ceil(policy.limit * multiplier) };
}

/** lib.rs:25 truncate_text */
export function truncateText(content: string, policy: TruncationPolicy): string {
  return policy.mode === "bytes"
    ? truncateMiddleChars(content, policy.limit)
    : truncateMiddleWithTokenBudget(content, policy.limit)[0];
}
