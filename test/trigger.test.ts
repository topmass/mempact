/**
 * Tests for the trigger, window, and token-budget ports. Window case adapted
 * from reference/codex-rs/core/src/state/auto_compact_window.rs:137
 * (tracks_prefill_and_window_boundaries) without the prefill and UUID parts.
 */

import { describe, expect, it } from "vitest";
import { autoCompactTokenLimit, autoCompactTokenStatus, tokensUntilCompaction } from "../core/trigger.ts";
import { AutoCompactWindow } from "../core/autoCompactWindow.ts";
import { maybeTokenBudgetReminder } from "../core/tokenBudget.ts";

describe("autoCompactTokenLimit (openai_models.rs:436)", () => {
  it("is 90% of the context window, integer math", () => {
    expect(autoCompactTokenLimit(200_000)).toBe(180_000);
    expect(autoCompactTokenLimit(262_144)).toBe(235_929); // floor(262144*9/10)
  });

  it("is min'd with a configured limit", () => {
    expect(autoCompactTokenLimit(200_000, 100_000)).toBe(100_000);
    expect(autoCompactTokenLimit(200_000, 999_999)).toBe(180_000);
  });

  it("falls back to configured when no window is known", () => {
    expect(autoCompactTokenLimit(null, 50_000)).toBe(50_000);
    expect(autoCompactTokenLimit(null)).toBeNull();
  });
});

describe("autoCompactTokenStatus (turn.rs:820)", () => {
  it("total scope triggers at the limit", () => {
    const status = autoCompactTokenStatus({
      activeContextTokens: 180_000,
      contextWindow: 200_000,
    });
    expect(status.tokenLimitReached).toBe(true);
    expect(status.autoCompactScopeLimit).toBe(180_000);
  });

  it("total scope below the limit does not trigger", () => {
    const status = autoCompactTokenStatus({
      activeContextTokens: 179_999,
      contextWindow: 200_000,
    });
    expect(status.tokenLimitReached).toBe(false);
  });
});

describe("tokensUntilCompaction (turn.rs:325)", () => {
  it("is the limit minus usage, floored at 0", () => {
    const status = (tokens: number) =>
      autoCompactTokenStatus({ activeContextTokens: tokens, contextWindow: 200_000 });
    expect(tokensUntilCompaction(status(175_000))).toBe(5_000);
    expect(tokensUntilCompaction(status(190_000))).toBe(0);
  });
});

describe("AutoCompactWindow (auto_compact_window.rs:137)", () => {
  it("tracks window boundaries", () => {
    const window = new AutoCompactWindow();

    expect(window.windowNumber()).toBe(0);
    window.restore(3);
    expect(window.windowNumber()).toBe(3);
    expect(window.claimTokenBudgetReminder()).toBe(true);
    expect(window.claimTokenBudgetReminder()).toBe(false);
    window.requestNewContextWindow();
    expect(window.takeNewContextWindowRequest()).toBe(true);
    expect(window.takeNewContextWindowRequest()).toBe(false);

    window.requestNewContextWindow();
    expect(window.advance()).toBe(4);
    // advance resets the new-context request and the reminder one-shot
    expect(window.takeNewContextWindowRequest()).toBe(false);
    expect(window.claimTokenBudgetReminder()).toBe(true);
  });
});

describe("maybeTokenBudgetReminder (token_budget.rs:6)", () => {
  it("fires once per window when the threshold is crossed", () => {
    const window = new AutoCompactWindow();
    const input = {
      tokensUntilCompaction: 900,
      reminderThresholdTokens: 1_000,
      claimReminder: () => window.claimTokenBudgetReminder(),
    };
    const first = maybeTokenBudgetReminder(input);
    expect(first).toContain("900");
    expect(maybeTokenBudgetReminder(input)).toBeNull();
  });

  it("does not fire above the threshold", () => {
    expect(
      maybeTokenBudgetReminder({
        tokensUntilCompaction: 5_000,
        reminderThresholdTokens: 1_000,
        claimReminder: () => true,
      }),
    ).toBeNull();
  });

  it("substitutes {n_remaining} in custom templates (token_budget_context.rs:114)", () => {
    expect(
      maybeTokenBudgetReminder({
        tokensUntilCompaction: 42,
        reminderThresholdTokens: 100,
        claimReminder: () => true,
        messageTemplate: "left: {n_remaining} ({n_remaining})",
      }),
    ).toBe("left: 42 (42)");
  });
});
