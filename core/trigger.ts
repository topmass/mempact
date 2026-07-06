/**
 * Ported from codex-rs auto-compaction trigger logic:
 * - protocol/src/openai_models.rs:436 auto_compact_token_limit (the 90% rule)
 * - core/src/session/turn.rs:806-866 auto_compact_token_status
 * - core/src/session/turn.rs:325-335 tokens-until-compaction math
 */

export type AutoCompactTokenLimitScope = "total" | "bodyAfterPrefix";

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
  /** Full active context usage, independent of the configured scope. */
  activeContextTokens: number;
  /** Usage counted against the limit for the current scope. */
  autoCompactScopeTokens: number;
  autoCompactScopeLimit: number;
  fullContextWindowLimit: number | null;
  autoCompactWindowPrefillTokens: number | null;
  fullContextWindowLimitReached: boolean;
  tokenLimitReached: boolean;
}

export interface AutoCompactTokenStatusInput {
  activeContextTokens: number;
  contextWindow: number | null;
  configuredLimit?: number | null;
  scope: AutoCompactTokenLimitScope;
  /** Prefill baseline for bodyAfterPrefix scope (AutoCompactWindow.snapshot()). */
  prefillInputTokens?: number | null;
}

/** turn.rs:820 auto_compact_token_status */
export function autoCompactTokenStatus(input: AutoCompactTokenStatusInput): AutoCompactTokenStatus {
  const { activeContextTokens, contextWindow, configuredLimit, scope } = input;
  let autoCompactWindowPrefillTokens: number | null = null;
  let autoCompactScopeTokens: number;
  let autoCompactScopeLimit: number;
  let fullContextWindowLimit: number | null;

  if (scope === "total") {
    autoCompactScopeTokens = activeContextTokens;
    autoCompactScopeLimit = autoCompactTokenLimit(contextWindow, configuredLimit) ?? Infinity;
    fullContextWindowLimit = null;
  } else {
    autoCompactWindowPrefillTokens = input.prefillInputTokens ?? null;
    const baseline = autoCompactWindowPrefillTokens ?? activeContextTokens;
    autoCompactScopeTokens = Math.max(0, activeContextTokens - baseline);
    autoCompactScopeLimit =
      configuredLimit ?? autoCompactTokenLimit(contextWindow, null) ?? Infinity;
    fullContextWindowLimit = contextWindow;
  }

  const fullContextWindowLimitReached =
    fullContextWindowLimit != null && activeContextTokens >= fullContextWindowLimit;
  const tokenLimitReached =
    autoCompactScopeTokens >= autoCompactScopeLimit || fullContextWindowLimitReached;

  return {
    activeContextTokens,
    autoCompactScopeTokens,
    autoCompactScopeLimit,
    fullContextWindowLimit,
    autoCompactWindowPrefillTokens,
    fullContextWindowLimitReached,
    tokenLimitReached,
  };
}

/** turn.rs:325-335 - tokens remaining before compaction fires, floored at 0. */
export function tokensUntilCompaction(status: AutoCompactTokenStatus): number {
  const fullContextRemaining =
    status.fullContextWindowLimit != null
      ? status.fullContextWindowLimit - status.activeContextTokens
      : Infinity;
  return Math.max(
    0,
    Math.min(status.autoCompactScopeLimit - status.autoCompactScopeTokens, fullContextRemaining),
  );
}
