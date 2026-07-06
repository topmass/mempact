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
import { removeFirstItem } from "./history.ts";

export { SUMMARIZATION_PROMPT, SUMMARY_PREFIX } from "./prompts.ts";

// compact.rs:52
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

// compact.rs:344 - post-compaction user warning, verbatim.
export const COMPACTION_WARNING =
  "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

/**
 * compact.rs:63 InitialContextInjection.
 * - doNotInject: pre-turn/manual compaction; the next regular turn reinjects
 *   initial context in full.
 * - beforeLastUserMessage: mid-turn compaction; the model is trained to see
 *   the summary as the LAST item, so initial context goes just above the
 *   last real user message.
 */
export type InitialContextInjection = "beforeLastUserMessage" | "doNotInject";

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

/**
 * compact.rs:509 insert_initial_context_before_last_real_user_or_summary.
 * Placement ladder (compact.rs:500-508):
 * 1. immediately before the last real user message;
 * 2. else before the last compaction summary (summaries are user messages);
 * 3. else before the last compaction item, so it stays last;
 * 4. else append.
 */
export function insertInitialContextBeforeLastRealUserOrSummary(
  compactedHistory: HistoryItem[],
  initialContext: readonly HistoryItem[],
): HistoryItem[] {
  let lastUserOrSummaryIndex: number | null = null;
  let lastRealUserIndex: number | null = null;
  for (let i = compactedHistory.length - 1; i >= 0; i--) {
    const item = compactedHistory[i]!;
    if (item.type !== "message" || item.role !== "user") continue;
    const text = messageText(item);
    if (text == null) continue;
    lastUserOrSummaryIndex ??= i;
    if (!isSummaryMessage(text)) {
      lastRealUserIndex = i;
      break;
    }
  }
  let lastCompactionIndex: number | null = null;
  for (let i = compactedHistory.length - 1; i >= 0; i--) {
    const t = compactedHistory[i]!.type;
    if (t === "compaction" || t === "context_compaction") {
      lastCompactionIndex = i;
      break;
    }
  }
  const insertionIndex = lastRealUserIndex ?? lastUserOrSummaryIndex ?? lastCompactionIndex;

  if (insertionIndex != null) {
    compactedHistory.splice(insertionIndex, 0, ...initialContext);
  } else {
    compactedHistory.push(...initialContext);
  }

  return compactedHistory;
}

export interface CompactionRetryOptions {
  /** Classifies a thrown error as a context-window overflow. */
  isContextOverflowError: (error: unknown) => boolean;
  /** Max retries for transient (non-overflow) errors. codex: provider stream_max_retries. */
  maxRetries?: number;
  /**
   * Delay before transient retry `attempt` (1-based), ms.
   * Approximates codex util::backoff (exponential).
   */
  backoffMs?: (attempt: number) => number;
  onRetry?: (attempt: number, maxRetries: number, error: unknown) => void;
}

const defaultBackoffMs = (attempt: number): number => Math.min(200 * 2 ** attempt, 10_000);

/**
 * compact.rs:233-296 - the summarization-request driver. On context-window
 * overflow, trim history from the FRONT one item at a time (with paired
 * tool-call partner removal), preserving the prompt-cache prefix, and reset
 * the transient-retry counter; transient errors retry with backoff.
 *
 * `items` is mutated (front-trimming). `callModel` receives the current
 * items and must return the summary text.
 */
export async function runCompactionWithRetry(
  items: HistoryItem[],
  callModel: (items: readonly HistoryItem[]) => Promise<string>,
  options: CompactionRetryOptions,
): Promise<string> {
  const maxRetries = options.maxRetries ?? 5;
  const backoff = options.backoffMs ?? defaultBackoffMs;
  let retries = 0;

  for (;;) {
    const turnInputLen = items.length;
    try {
      return await callModel(items);
    } catch (error) {
      if (options.isContextOverflowError(error)) {
        if (turnInputLen > 1) {
          // compact.rs:262 - trim from the beginning to preserve cache
          // (prefix-based) and keep recent messages intact.
          removeFirstItem(items);
          retries = 0;
          continue;
        }
        throw error;
      }
      if (retries < maxRetries) {
        retries += 1;
        options.onRetry?.(retries, maxRetries, error);
        await new Promise((resolve) => setTimeout(resolve, backoff(retries)));
        continue;
      }
      throw error;
    }
  }
}

/**
 * codex session/turn.rs get_last_assistant_message_from_turn - the summary
 * is the last assistant message of the compaction turn.
 */
export function getLastAssistantMessageFromTurn(items: readonly HistoryItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "message" && item.role === "assistant") {
      return messageText(item);
    }
  }
  return null;
}
