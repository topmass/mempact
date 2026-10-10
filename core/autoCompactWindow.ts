/**
 * Ported from codex-rs/core/src/state/auto_compact_window.rs: the per-window
 * state that every compaction resets. codex also chains UUIDv7 window ids
 * for analytics; mempact keeps only the window number, which /mempact shows.
 */

export class AutoCompactWindow {
  private windowNumberValue = 0;
  private newContextWindowRequested = false;
  private tokenBudgetReminderDelivered = false;

  windowNumber(): number {
    return this.windowNumberValue;
  }

  /** auto_compact_window.rs:65 restore - rebuild chain state on resume. */
  restore(windowNumber: number): void {
    this.windowNumberValue = windowNumber;
  }

  /** auto_compact_window.rs:70 advance - called on every compaction. */
  advance(): number {
    this.windowNumberValue += 1;
    this.newContextWindowRequested = false;
    this.tokenBudgetReminderDelivered = false;
    return this.windowNumberValue;
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
}
