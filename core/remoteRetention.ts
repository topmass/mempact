/**
 * Portable client-side behaviors learned from codex's remote compaction:
 * - codex-rs/core/src/compact_remote.rs:341 should_keep_compacted_history_item
 * - codex-rs/core/src/compact_remote.rs:369 trim_function_call_history_to_fit_context_window
 * - codex-rs/core/src/compact_remote_v2.rs:449-570 retained-message budget
 * The server contracts themselves (POST responses/compact, CompactionTrigger
 * sentinel) require OpenAI's backend and are not ported.
 */

import type { HistoryItem } from "./items.ts";
import { messageText } from "./items.ts";
import { approxTokenCount } from "./truncate.ts";
import { tokensPolicy, truncateText } from "./outputTruncation.ts";
import { estimateTokenCountWithBaseInstructions } from "./history.ts";

// compact_remote_v2.rs:49-51 - mirrors the /responses/compact server default.
export const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

// compact_remote.rs:41
export const CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated";

/**
 * compact_remote.rs:341 should_keep_compacted_history_item - post-filter for
 * a compacted transcript: drop developer/wrapper/tool/reasoning items; keep
 * user and assistant messages and compaction markers.
 */
export function shouldKeepCompactedHistoryItem(item: HistoryItem): boolean {
  switch (item.type) {
    case "message":
      if (item.role === "developer") return false;
      if (item.role === "user") return messageText(item) != null;
      return item.role === "assistant";
    case "compaction":
    case "context_compaction":
      return true;
    default:
      return false;
  }
}

/** compact_remote_v2.rs:459 is_retained_for_remote_compaction_v2 */
export function isRetainedMessage(item: HistoryItem): boolean {
  return (
    item.type === "message" &&
    (item.role === "user" || item.role === "developer" || item.role === "system")
  );
}

/**
 * compact_remote_v2.rs:504 message_text_token_count - images cost zero text
 * tokens (they are preserved, not budgeted).
 */
export function messageTextTokenCount(item: HistoryItem): number {
  if (item.type !== "message") return 0;
  let total = 0;
  for (const c of item.content) {
    if (c.type === "input_text" || c.type === "output_text") total += approxTokenCount(c.text);
  }
  return total;
}

/** compact_remote_v2.rs:520 truncate_message_text_to_token_budget */
export function truncateMessageTextToTokenBudget(
  item: HistoryItem,
  maxTokens: number,
): HistoryItem | null {
  if (item.type !== "message") return item;

  let remaining = maxTokens;
  const truncatedContent: typeof item.content = [];
  for (const contentItem of item.content) {
    if (contentItem.type === "input_text" || contentItem.type === "output_text") {
      if (remaining === 0) continue;
      const tokenCount = approxTokenCount(contentItem.text);
      let text = contentItem.text;
      if (tokenCount <= remaining) {
        remaining -= tokenCount;
      } else {
        text = truncateText(text, tokensPolicy(remaining));
        remaining = 0;
      }
      if (text.length > 0) truncatedContent.push({ ...contentItem, text });
    } else {
      truncatedContent.push(contentItem);
    }
  }

  if (truncatedContent.length === 0) return null;
  return { ...item, content: truncatedContent };
}

/**
 * compact_remote_v2.rs:478 truncate_retained_messages_for_remote_compaction -
 * newest-first selection under the token budget; the message crossing the
 * budget is text-truncated; images pass through at zero cost.
 */
export function truncateRetainedMessages(
  items: readonly HistoryItem[],
  maxTokens: number = RETAINED_MESSAGE_TOKEN_BUDGET,
): HistoryItem[] {
  let remaining = maxTokens;
  const truncatedReversed: HistoryItem[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (remaining === 0) continue;
    const item = items[i]!;
    const tokenCount = Math.max(1, messageTextTokenCount(item));
    if (tokenCount <= remaining) {
      truncatedReversed.push(item);
      remaining -= tokenCount;
    } else {
      const truncatedItem = truncateMessageTextToTokenBudget(item, remaining);
      if (truncatedItem != null) {
        truncatedReversed.push(truncatedItem);
        remaining = 0;
      }
    }
  }
  truncatedReversed.reverse();
  return truncatedReversed;
}

/**
 * compact_remote.rs:369 trim_function_call_history_to_fit_context_window -
 * walking from the TAIL, stub tool outputs with a fixed message until the
 * estimated token count fits the context window. Mutates `items`; returns
 * [rewrittenOutputs, estimatedDeletedTokens].
 */
export function trimFunctionCallHistoryToFitContextWindow(
  items: HistoryItem[],
  contextWindow: number | null,
  baseInstructions: string,
): [number, number] {
  if (contextWindow == null) return [0, 0];
  let rewrittenOutputs = 0;
  let estimatedDeletedTokens = 0;

  for (let index = items.length - 1; index >= 0; index--) {
    const estimatedTokensBefore = estimateTokenCountWithBaseInstructions(items, baseInstructions);
    if (estimatedTokensBefore <= contextWindow) break;
    const rewrittenItem = rewrittenOutputForContextWindow(items[index]!);
    if (rewrittenItem == null) break;
    items[index] = rewrittenItem;
    const estimatedTokensAfter = estimateTokenCountWithBaseInstructions(items, baseInstructions);
    rewrittenOutputs += 1;
    estimatedDeletedTokens += Math.max(0, estimatedTokensBefore - estimatedTokensAfter);
  }

  return [rewrittenOutputs, estimatedDeletedTokens];
}

/** compact_remote.rs:411 rewritten_output_for_context_window */
function rewrittenOutputForContextWindow(item: HistoryItem): HistoryItem | null {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return {
      ...item,
      output: {
        content: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
        success: item.output.success,
      },
    };
  }
  if (item.type === "tool_search_output") {
    return { ...item };
  }
  return null;
}
