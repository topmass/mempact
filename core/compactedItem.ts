/**
 * Ported from codex-rs/protocol/src/protocol.rs:3045-3062 CompactedItem -
 * the durable record persisted with every compaction. The legacy
 * numeric-window-id migration shim (protocol/src/compacted_item.rs) is not
 * ported: no legacy data exists here.
 */

import type { HistoryItem } from "./items.ts";

export interface CompactedItem {
  /** Summary text; empty when the replacement history carries the content. */
  message: string;
  replacementHistory?: HistoryItem[];
  /** Monotonic position of this window in the thread. */
  windowNumber?: number;
  /** UUIDv7 of the first window in this thread's chain. */
  firstWindowId?: string;
  /** UUIDv7 of the window immediately before this one. */
  previousWindowId?: string;
  /** UUIDv7 of this window. */
  windowId?: string;
}
