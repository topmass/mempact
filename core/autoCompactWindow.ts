/**
 * Ported from codex-rs/core/src/state/auto_compact_window.rs (verbatim
 * semantics). Every compaction advances a window chain of time-ordered
 * UUIDv7 ids, so a resumed session can reconstruct which context window it
 * is in and analytics can measure per-window behavior.
 */

import { uuidv7 } from "./uuidv7.ts";

export interface AutoCompactWindowIds {
  firstWindowId: string;
  previousWindowId: string | null;
  windowId: string;
}

export interface AutoCompactWindowSnapshot {
  prefillInputTokens: number | null;
}

// auto_compact_window.rs:17 - server-observed prefill wins over estimated.
type Prefill =
  | { kind: "serverObserved"; tokens: number }
  | { kind: "estimated"; tokens: number };

export class AutoCompactWindow {
  private windowNumberValue = 0;
  private ids: AutoCompactWindowIds;
  private newContextWindowRequested = false;
  /**
   * Absolute input-token baseline for the current compaction window
   * (auto_compact_window.rs:26-31). `bodyAfterPrefix` scope subtracts this
   * from later active-context usage.
   */
  private prefillInputTokens: Prefill | null = null;
  private tokenBudgetReminderDelivered = false;

  constructor() {
    const windowId = uuidv7();
    this.ids = { firstWindowId: windowId, previousWindowId: null, windowId };
  }

  clearPrefill(): void {
    this.prefillInputTokens = null;
  }

  windowNumber(): number {
    return this.windowNumberValue;
  }

  currentIds(): AutoCompactWindowIds {
    return { ...this.ids };
  }

  /** auto_compact_window.rs:65 restore - rebuild chain state on resume. */
  restore(windowNumber: number, ids: AutoCompactWindowIds): void {
    this.windowNumberValue = windowNumber;
    this.ids = { ...ids };
  }

  /** auto_compact_window.rs:70 advance - called on every compaction. */
  advance(): [number, AutoCompactWindowIds] {
    this.windowNumberValue += 1;
    this.ids = {
      firstWindowId: this.ids.firstWindowId,
      previousWindowId: this.ids.windowId,
      windowId: uuidv7(),
    };
    this.newContextWindowRequested = false;
    this.tokenBudgetReminderDelivered = false;
    return [this.windowNumberValue, { ...this.ids }];
  }

  /** auto_compact_window.rs:78 - one-shot: true only on first claim per window. */
  claimTokenBudgetReminder(): boolean {
    const due = !this.tokenBudgetReminderDelivered;
    this.tokenBudgetReminderDelivered = true;
    return due;
  }

  /** Restore the one-shot flag from persisted state on resume. */
  markTokenBudgetReminderDelivered(): void {
    this.tokenBudgetReminderDelivered = true;
  }

  requestNewContextWindow(): void {
    this.newContextWindowRequested = true;
  }

  takeNewContextWindowRequest(): boolean {
    const requested = this.newContextWindowRequested;
    this.newContextWindowRequested = false;
    return requested;
  }

  /**
   * auto_compact_window.rs:95 - records the request-input side of the first
   * server usage sample; the sampled output is body growth and stays counted
   * against the scoped budget. Server-observed values are never overwritten.
   */
  ensureServerObservedPrefillFromUsage(inputTokens: number): void {
    if (this.prefillInputTokens?.kind === "serverObserved") return;
    this.prefillInputTokens = { kind: "serverObserved", tokens: Math.max(0, inputTokens) };
  }

  /** auto_compact_window.rs:109 set_estimated_prefill */
  setEstimatedPrefill(tokens: number): void {
    if (this.prefillInputTokens?.kind === "serverObserved") return;
    this.prefillInputTokens = { kind: "estimated", tokens: Math.max(0, tokens) };
  }

  snapshot(): AutoCompactWindowSnapshot {
    return { prefillInputTokens: this.prefillInputTokens?.tokens ?? null };
  }
}
