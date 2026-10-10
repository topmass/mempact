/**
 * Ported from codex-rs auto-compaction trigger logic:
 * - protocol/src/openai_models.rs:436 auto_compact_token_limit (the 90% rule)
 * - core/src/session/turn.rs:806-866 auto_compact_token_status
 * - core/src/session/turn.rs:325-335 tokens-until-compaction math
 */

/**
 * openai_models.rs:436 - compaction threshold: 90% of the context window
 * (integer math: cw*9/10), min'd with any configured limit.
 */
export function autoCompactTokenLimit(
  contextWindow: number | null,
  configuredLimit?: number | null,
): number | null {
  const contextLimit = contextWindow != null ? Math.floor((contextWindow * 9) / 10) : null;
  if (contextLimit != null) {
    return configuredLimit != null ? Math.min(configuredLimit, contextLimit) : contextLimit;
  }
  return configuredLimit ?? null;
}

export interface AutoCompactTokenStatus {
  activeContextTokens: number;
  autoCompactScopeLimit: number;
  tokenLimitReached: boolean;
}

export interface AutoCompactTokenStatusInput {
  activeContextTokens: number;
  contextWindow: number | null;
  configuredLimit?: number | null;
}

/** turn.rs:820 auto_compact_token_status, "total" scope (the only one pi can
 *  measure: it reports whole-request usage, not a prefill baseline). */
export function autoCompactTokenStatus(input: AutoCompactTokenStatusInput): AutoCompactTokenStatus {
  const { activeContextTokens, contextWindow, configuredLimit } = input;
  const autoCompactScopeLimit = autoCompactTokenLimit(contextWindow, configuredLimit) ?? Infinity;
  return {
    activeContextTokens,
    autoCompactScopeLimit,
    tokenLimitReached: activeContextTokens >= autoCompactScopeLimit,
  };
}

/** turn.rs:325-335 - tokens remaining before compaction fires, floored at 0. */
export function tokensUntilCompaction(status: AutoCompactTokenStatus): number {
  return Math.max(0, status.autoCompactScopeLimit - status.activeContextTokens);
}
