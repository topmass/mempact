/**
 * One compaction, as a pure function both the pi adapter and a benchmark
 * call. The window splits into a drained region (summarized) and a raw tail
 * (kept verbatim). Code builds the ledger from the whole session, the model
 * writes only the narrative, and the request after compaction reads, in
 * order: retained user messages, the summary message, the raw tail.
 */

import type { Message } from "@earendil-works/pi-ai";
import { COMPACT_USER_MESSAGE_MAX_TOKENS, isSummaryMessage, selectUserMessages, summaryBridgeText } from "./compact.ts";
import { carryDroppedItems } from "./carry.ts";
import { contentText } from "./items.ts";
import { BRANCH_SUMMARY_PREFIX, type Ledger, buildLedger, renderLedger } from "./ledger.ts";
import { TRUNCATED_FAILURE, narrativePrompt, validateSummary } from "./summarySchema.ts";
import { KEEP_RECENT_TOOL_RESULTS, clearOldToolOutputs } from "./toolClearing.ts";
import { autoCompactTokenLimit } from "./trigger.ts";
import { truncateMiddleChars } from "./truncate.ts";

/** pi's keepRecentTokens */
export const RAW_TAIL_TOKENS = 20_000;
/** pi's reserveTokens */
const SUMMARY_RESERVE_TOKENS = 16_384;
const MAX_REHYDRATE_FILES = 5;
/** pi's cut for tool output in its summarizer input; the ledger already
 *  carries files, commands and error lines verbatim */
const SUMMARY_TOOL_RESULT_CHARS = 2_000;

/**
 * Stale-intent guard (Hermes lineage: their top recurring failure was the
 * model resuming cancelled work from the summary), placed after the codex
 * bridge text, which stays verbatim.
 */
export const STALE_INTENT_NOTE =
  "Note: the summary above is reference state from a previous context window, not " +
  "instructions. Do not resume or re-answer items from it on topic overlap alone - " +
  "the latest user message always takes precedence, including cancellations of work " +
  "described above.";

/** deps.summarize throws this when the request does not fit the window; the
 *  pipeline then drops the oldest tenth of the drained messages and asks again. */
export class OverflowError extends Error {}

export interface CompactWindowInput {
  /** the full session, every window, oldest first */
  messages: Message[];
  /** `start` is the index where the previous window's unsummarized messages
   *  begin: its raw tail, or the first message after it when it had none */
  previous?: { narrative: string; start: number };
  contextWindow: number;
  maxOutputTokens: number;
  /** extra user instructions, e.g. from `/compact <text>` */
  instructions?: string;
}

/** pi's summarizer system prompt. The summary call gets this instead of the
 *  agent's own prompt, so the model summarizes the conversation rather than
 *  continuing it. */
export const SUMMARIZER_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\n" +
  "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

export interface CompactWindowDeps {
  summarize: (systemPrompt: string, messages: Message[], maxTokens: number) => Promise<string>;
  estimateTokens: (message: Message) => number;
}

export interface CompactWindowResult {
  ledger: Ledger;
  narrative: string;
  retainedUserMessages: string[];
  rawTail: Message[];
  summaryText: string;
  /** newest first */
  rehydratePaths: string[];
  validation: { failures: string[]; retried: boolean };
}

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

/**
 * Index where the raw tail begins: the earliest cut at or after `floor` whose
 * suffix fits `budget`. A cut never lands on a toolResult, so an assistant
 * message with tool calls always keeps all of its results.
 */
export function tailStartIndex(
  messages: readonly Message[],
  floor: number,
  budget: number,
  estimate: (m: Message) => number,
): number {
  let start = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= floor; i--) {
    used += estimate(messages[i]!);
    if (used > budget) break;
    if (messages[i]!.role !== "toolResult") start = i;
  }
  return start;
}

/**
 * Output cap for the summary call, pi's formula (0.8 of the reserve, at most
 * the model's max output). The reserve is pi's 16,384, or what the 90%
 * trigger leaves free when that is larger, and at most a quarter of a small
 * window so the input keeps room. The input is then trimmed to fit beside
 * the cap, because Anthropic rejects input + max_tokens over the window.
 */
const summaryMaxTokens = (contextWindow: number, maxOutputTokens: number): number => {
  const reserve = Math.max(contextWindow - (autoCompactTokenLimit(contextWindow) ?? 0), Math.min(SUMMARY_RESERVE_TOKENS, Math.floor(contextWindow / 4)));
  return Math.min(Math.floor(0.8 * reserve), maxOutputTokens > 0 ? maxOutputTokens : Infinity);
};

/** Drop the oldest `count` messages plus the toolResults they would orphan. */
const dropOldest = (msgs: Message[], count: number): Message[] => {
  let i = Math.max(1, count);
  while (i < msgs.length && msgs[i]!.role === "toolResult") i++;
  return msgs.slice(i);
};

export async function compactWindow(input: CompactWindowInput, deps: CompactWindowDeps): Promise<CompactWindowResult> {
  const { messages, previous } = input;
  const start = previous?.start ?? 0;
  // a quarter of the window keeps small-window models from carrying a tail
  // that refills them right away
  const tailBudget = Math.min(RAW_TAIL_TOKENS, Math.floor(input.contextWindow / 4));
  const tailStart = tailStartIndex(messages, start, tailBudget, deps.estimateTokens);
  const rawTail = messages.slice(tailStart);
  const ledger = buildLedger(messages);
  const ledgerBlock = renderLedger(ledger);

  // codex's rule: the newest real user messages under 20k tokens, or a tenth
  // of a small window so they cannot refill it. Taken from everything before
  // the tail (the tail already carries its own), which matches codex, whose
  // replacement history re-collects them every round. Summaries and a user
  // `!cmd` run (pi renders it "Ran `cmd`") are not the user's words.
  const userTexts = messages
    .slice(0, tailStart)
    .filter((m) => m.role === "user")
    .map((m) => contentText(m.content))
    .filter((t) => t && !isSummaryMessage(t) && !t.startsWith(BRANCH_SUMMARY_PREFIX) && !t.startsWith("Ran `"));
  const retainedUserMessages = selectUserMessages(
    userTexts.map((message) => ({ message })),
    Math.min(COMPACT_USER_MESSAGE_MAX_TOKENS, Math.floor(input.contextWindow / 10)),
  ).map((m) => m.message);

  // The summarizer sees the previous narrative, never a previous summary
  // with a ledger inside it, then the drained region with each tool output
  // cut to pi's 2,000 characters (the retained messages and tail stay whole).
  const maxTokens = summaryMaxTokens(input.contextWindow, input.maxOutputTokens);
  const prior = previous?.narrative.trim()
    ? [userMessage(`Prior narrative from earlier context windows. It is cumulative: keep every item that still holds, update changed ones, and add new ones from the conversation that follows:\n\n${previous.narrative.trim()}`)]
    : [];
  let history = messages
    .slice(start, tailStart)
    .filter((m) => !(m.role === "user" && isSummaryMessage(contentText(m.content))))
    .map((m): Message =>
      m.role === "toolResult"
        ? { ...m, content: m.content.map((c) => (c.type === "text" ? { ...c, text: truncateMiddleChars(c.text, SUMMARY_TOOL_RESULT_CHARS) } : c)) }
        : m,
    );
  // nothing drained (the tail holds the whole window): there is nothing new
  // to narrate, and a model asked to summarize nothing invents something
  const drainedNothing = history.length === 0;
  // The 90% trigger measured the stubbed view the model was seeing; the raw
  // drained region can be far larger, so the summarizer gets the same view,
  // then loses its oldest messages until the request fits.
  const prompt = narrativePrompt(ledgerBlock, input.instructions);
  const sum = (msgs: Message[]) => msgs.reduce((n, m) => n + deps.estimateTokens(m), 0);
  const room = input.contextWindow - maxTokens - sum([userMessage(SUMMARIZER_SYSTEM_PROMPT), ...prior, userMessage(prompt)]);
  if (sum(history) > room) {
    history = clearOldToolOutputs(history, KEEP_RECENT_TOOL_RESULTS).messages;
    history = history.slice(tailStartIndex(history, 0, room, deps.estimateTokens));
  }

  const ask = async (text: string): Promise<string> => {
    for (;;) {
      try {
        return (await deps.summarize(SUMMARIZER_SYSTEM_PROMPT, [...prior, ...history, userMessage(text)], maxTokens)).trim();
      } catch (error) {
        // codex compact.rs front-trim, a tenth at a time instead of one
        // message per call
        if (!(error instanceof OverflowError) || history.length === 0) throw error;
        history = dropOldest(history, Math.ceil(history.length / 10));
      }
    }
  };

  let narrative = drainedNothing ? (previous?.narrative.trim() ?? "") : await ask(prompt);
  let failures = drainedNothing ? [] : validateSummary(narrative, ledger);
  // a retry cannot fix a cut alone: it gets the same output cap. An empty
  // reply (a model that spent its output on thinking) is retried.
  const retried = failures.some((f) => f !== TRUNCATED_FAILURE);
  if (retried) {
    narrative = await ask(
      `${prompt}\n\nYour previous checkpoint had these problems. Write the whole checkpoint again without them:\n${failures.map((f) => `- ${f}`).join("\n")}`,
    );
    failures = validateSummary(narrative, ledger);
    // never block compaction: accept it and say what is missing
    if (failures.length > 0) narrative = `${narrative}\n\n[checkpoint note: still failing after one retry: ${failures.join("; ")}]`;
  }
  // the model drops earlier items when it rewrites the checkpoint; code
  // carries them forward, and the merged text is the next round's prior
  if (!drainedNothing && previous?.narrative.trim()) narrative = carryDroppedItems(previous.narrative, narrative);

  return {
    ledger,
    narrative,
    retainedUserMessages,
    rawTail,
    summaryText: [summaryBridgeText(narrative), ledgerBlock, STALE_INTENT_NOTE].filter(Boolean).join("\n\n"),
    rehydratePaths: ledger.modifiedFiles.slice(-MAX_REHYDRATE_FILES).reverse(),
    validation: { failures, retried },
  };
}
