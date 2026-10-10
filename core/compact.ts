/**
 * Ported from codex-rs/core/src/compact.rs - the "Memento" compaction
 * strategy. Replacement history = [recent real user messages under a
 * 20k-token budget] + [SUMMARY_PREFIX + model-written summary, ALWAYS LAST].
 */

import type { HistoryItem } from "./items.ts";
import { messageText } from "./items.ts";
import { SUMMARY_PREFIX } from "./prompts.ts";
import { approxTokenCount } from "./truncate.ts";
import { tokensPolicy, truncateText } from "./outputTruncation.ts";

export { SUMMARIZATION_PROMPT, SUMMARY_PREFIX } from "./prompts.ts";

// compact.rs:52
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

/** compact.rs:495 is_summary_message */
export function isSummaryMessage(message: string): boolean {
  return message.startsWith(`${SUMMARY_PREFIX}\n`);
}

export interface CompactedUserMessage {
  message: string;
}

/**
 * compact.rs:470 collect_user_messages - real user messages only, previous
 * compaction summaries excluded. Codex additionally excludes contextual
 * wrapper messages (user_instructions, environment_context, legacy warnings)
 * via parse_turn_item's fragment registry (event_mapping.rs:44,
 * context/contextual_user_message.rs); that registry is codex-session
 * specific, so it is exposed here as an optional predicate instead - hosts
 * whose transcripts contain synthetic user-role wrappers should supply one.
 */
export function collectUserMessages(
  items: readonly HistoryItem[],
  isContextualUserMessage?: (text: string) => boolean,
): CompactedUserMessage[] {
  const out: CompactedUserMessage[] = [];
  for (const item of items) {
    if (item.type !== "message" || item.role !== "user") continue;
    const text = messageText(item);
    if (text == null || isSummaryMessage(text)) continue;
    if (isContextualUserMessage?.(text)) continue;
    out.push({ message: text });
  }
  return out;
}

/** compact.rs:300 - the summary bridge as it appears in replacement history. */
export function summaryBridgeText(summarySuffix: string): string {
  return `${SUMMARY_PREFIX}\n${summarySuffix}`;
}

/** compact.rs:556 build_compacted_history */
export function buildCompactedHistory(
  initialContext: HistoryItem[],
  userMessages: readonly CompactedUserMessage[],
  summaryText: string,
): HistoryItem[] {
  return buildCompactedHistoryWithLimit(
    initialContext,
    userMessages,
    summaryText,
    COMPACT_USER_MESSAGE_MAX_TOKENS,
  );
}

/**
 * compact.rs:569 build_compacted_history_with_limit - newest-first selection
 * of user messages under the token budget; the message that crosses the
 * budget is middle-truncated to the remainder; summary always last;
 * "(no summary available)" fallback.
 */
export function buildCompactedHistoryWithLimit(
  history: HistoryItem[],
  userMessages: readonly CompactedUserMessage[],
  summaryText: string,
  maxTokens: number,
): HistoryItem[] {
  const selectedMessages: CompactedUserMessage[] = [];
  if (maxTokens > 0) {
    let remaining = maxTokens;
    for (let i = userMessages.length - 1; i >= 0; i--) {
      if (remaining === 0) break;
      const message = userMessages[i]!;
      const tokens = approxTokenCount(message.message);
      if (tokens <= remaining) {
        selectedMessages.push({ ...message });
        remaining -= tokens;
      } else {
        const truncated = truncateText(message.message, tokensPolicy(remaining));
        selectedMessages.push({ message: truncated });
        break;
      }
    }
    selectedMessages.reverse();
  }

  for (const message of selectedMessages) {
    history.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: message.message }],
    });
  }

  const summary = summaryText.length === 0 ? "(no summary available)" : summaryText;

  history.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: summary }],
  });

  return history;
}
