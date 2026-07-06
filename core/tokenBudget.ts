/**
 * Ported from codex-rs/core/src/session/token_budget.rs and
 * core/src/context/token_budget_context.rs:107-135. A one-shot model-visible
 * reminder injected when tokens-until-compaction crosses a threshold, so the
 * model can wrap up before being compacted mid-thought.
 */

/**
 * Codex has no built-in template (user-configured, `{n_remaining}`
 * placeholder, max 1000 bytes - config/mod.rs:1090). This default follows
 * the same contract.
 */
export const DEFAULT_REMINDER_MESSAGE_TEMPLATE =
  "You have about {n_remaining} tokens of context left before this conversation is automatically compacted. Prefer wrapping up the current step and recording important state now.";

export interface TokenBudgetReminderInput {
  tokensUntilCompaction: number;
  reminderThresholdTokens: number;
  /** One-shot claim per compaction window (AutoCompactWindow.claimTokenBudgetReminder). */
  claimReminder: () => boolean;
  messageTemplate?: string;
}

/**
 * token_budget.rs:6 maybe_record - returns the reminder text to inject as a
 * model-visible message, or null when not due. token_budget_context.rs:114:
 * the template's `{n_remaining}` is replaced with the remaining count.
 */
export function maybeTokenBudgetReminder(input: TokenBudgetReminderInput): string | null {
  if (input.tokensUntilCompaction > input.reminderThresholdTokens) {
    return null;
  }
  if (!input.claimReminder()) {
    return null;
  }
  const template = input.messageTemplate ?? DEFAULT_REMINDER_MESSAGE_TEMPLATE;
  return template.replaceAll("{n_remaining}", String(input.tokensUntilCompaction));
}
