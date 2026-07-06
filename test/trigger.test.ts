/**
 * Tests for the trigger, window-chain, token-budget, and history-estimation
 * ports. Window-chain case ported from
 * reference/codex-rs/core/src/state/auto_compact_window.rs:137
 * (tracks_prefill_and_window_boundaries).
 */

import { describe, expect, it } from "vitest";
import { autoCompactTokenLimit, autoCompactTokenStatus, tokensUntilCompaction } from "../core/trigger.ts";
import { AutoCompactWindow } from "../core/autoCompactWindow.ts";
import { maybeTokenBudgetReminder } from "../core/tokenBudget.ts";
import { getTotalTokenUsage, processItem, estimateItemTokenCount } from "../core/history.ts";
import { DEFAULT_TRUNCATION_POLICY } from "../core/outputTruncation.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { HistoryItem } from "../core/items.ts";

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
      scope: "total",
    });
    expect(status.tokenLimitReached).toBe(true);
    expect(status.autoCompactScopeLimit).toBe(180_000);
  });

  it("total scope below the limit does not trigger", () => {
    const status = autoCompactTokenStatus({
      activeContextTokens: 179_999,
      contextWindow: 200_000,
      scope: "total",
    });
    expect(status.tokenLimitReached).toBe(false);
  });

  it("bodyAfterPrefix subtracts the prefill baseline", () => {
    const status = autoCompactTokenStatus({
      activeContextTokens: 120_000,
      contextWindow: 200_000,
      configuredLimit: 50_000,
      scope: "bodyAfterPrefix",
      prefillInputTokens: 80_000,
    });
    expect(status.autoCompactScopeTokens).toBe(40_000);
    expect(status.tokenLimitReached).toBe(false);
    expect(status.fullContextWindowLimit).toBe(200_000);
  });

  it("bodyAfterPrefix still triggers when the full window is exhausted", () => {
    const status = autoCompactTokenStatus({
      activeContextTokens: 200_000,
      contextWindow: 200_000,
      configuredLimit: 500_000,
      scope: "bodyAfterPrefix",
      prefillInputTokens: 190_000,
    });
    expect(status.fullContextWindowLimitReached).toBe(true);
    expect(status.tokenLimitReached).toBe(true);
  });
});

describe("tokensUntilCompaction (turn.rs:325)", () => {
  it("is clamped by full-window remaining and floored at 0", () => {
    const status = autoCompactTokenStatus({
      activeContextTokens: 195_000,
      contextWindow: 200_000,
      configuredLimit: 100_000,
      scope: "bodyAfterPrefix",
      prefillInputTokens: 150_000,
    });
    // scope remaining = 100k - 45k = 55k; window remaining = 5k -> 5k wins
    expect(tokensUntilCompaction(status)).toBe(5_000);
  });
});

describe("AutoCompactWindow (auto_compact_window.rs:137)", () => {
  it("tracks prefill and window boundaries", () => {
    const window = new AutoCompactWindow();

    expect(window.windowNumber()).toBe(0);
    const initial = window.currentIds();
    expect(initial.windowId[14]).toBe("7"); // UUID version 7
    expect(initial.firstWindowId).toBe(initial.windowId);
    expect(initial.previousWindowId).toBeNull();

    const restoredWindowId = uuidv7();
    window.restore(3, {
      firstWindowId: initial.firstWindowId,
      previousWindowId: uuidv7(),
      windowId: restoredWindowId,
    });
    expect(window.windowNumber()).toBe(3);
    expect(window.claimTokenBudgetReminder()).toBe(true);
    expect(window.claimTokenBudgetReminder()).toBe(false);
    window.requestNewContextWindow();
    expect(window.takeNewContextWindowRequest()).toBe(true);
    expect(window.takeNewContextWindowRequest()).toBe(false);

    window.requestNewContextWindow();
    const [windowNumber, ids] = window.advance();
    expect(windowNumber).toBe(4);
    expect(ids.firstWindowId).toBe(initial.firstWindowId);
    expect(ids.previousWindowId).toBe(restoredWindowId);
    expect(ids.windowId).not.toBe(restoredWindowId);
    // advance resets the new-context request and the reminder one-shot
    expect(window.takeNewContextWindowRequest()).toBe(false);
    expect(window.claimTokenBudgetReminder()).toBe(true);

    expect(window.snapshot()).toEqual({ prefillInputTokens: null });
    window.setEstimatedPrefill(150);
    expect(window.snapshot()).toEqual({ prefillInputTokens: 150 });
    window.ensureServerObservedPrefillFromUsage(120);
    expect(window.snapshot()).toEqual({ prefillInputTokens: 120 });
    // server-observed wins; later estimates/observations don't overwrite
    window.ensureServerObservedPrefillFromUsage(130);
    window.setEstimatedPrefill(90);
    expect(window.snapshot()).toEqual({ prefillInputTokens: 120 });
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

describe("history token accounting (history.rs)", () => {
  it("processItem caps tool outputs at policy x1.2 and leaves messages alone", () => {
    const bigOutput: HistoryItem = {
      type: "function_call_output",
      callId: "c1",
      output: { content: "x".repeat(50_000) },
    };
    const processed = processItem(bigOutput, DEFAULT_TRUNCATION_POLICY);
    const content = (processed as { output: { content: string } }).output.content;
    expect(content.length).toBeLessThan(13_000); // 10k x 1.2 + marker
    expect(content).toContain("chars truncated");

    const msg: HistoryItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "y".repeat(50_000) }],
    };
    expect(processItem(msg, DEFAULT_TRUNCATION_POLICY)).toBe(msg);
  });

  it("getTotalTokenUsage = server total + estimates for local items after last model item", () => {
    const items: HistoryItem[] = [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "z".repeat(4_000) }] },
    ];
    const localEstimate = estimateItemTokenCount(items[1]!);
    expect(getTotalTokenUsage(items, 50_000)).toBe(50_000 + localEstimate);
    // nothing after the last model-generated item -> server total verbatim
    expect(getTotalTokenUsage([items[0]!], 50_000)).toBe(50_000);
  });

  it("images get the fixed 7373-byte estimate instead of raw base64 size", () => {
    const bigBase64 = "A".repeat(400_000);
    const img: HistoryItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_image", imageUrl: `data:image/png;base64,${bigBase64}` }],
    };
    const tokens = estimateItemTokenCount(img);
    expect(tokens).toBeGreaterThan(1_800); // ~1844 from the fixed estimate
    expect(tokens).toBeLessThan(2_100); // not the ~100k raw base64 would give
  });
});
