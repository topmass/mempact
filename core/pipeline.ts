/**
 * One compaction, as a pure function both the pi adapter and a benchmark
 * call. The window splits into a drained region (summarized) and a raw tail
 * (kept verbatim). Code builds the ledger from the whole session, the model
 * writes only the narrative, and the request after compaction reads, in
 * order: retained user messages, the summary message, the raw tail.
 */

import type { Message } from "@earendil-works/pi-ai";
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  buildCompactedHistoryWithLimit,
  isSummaryMessage,
  summaryBridgeText,
} from "./compact.ts";
import { contentText, messageText } from "./items.ts";
import { type Ledger, buildLedger, renderLedger } from "./ledger.ts";
import { narrativePrompt, validateSummary } from "./summarySchema.ts";
import { KEEP_RECENT_TOOL_RESULTS, clearOldToolOutputs } from "./toolClearing.ts";
import { autoCompactTokenLimit } from "./trigger.ts";

export const RAW_TAIL_TOKENS = 12_000;
const MAX_REHYDRATE_FILES = 5;

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
 *  pipeline then drops the oldest drained message and asks again. */
export class OverflowError extends Error {}

export interface CompactWindowInput {
  /** the full session, every window, oldest first */
  messages: Message[];
  /** `start` is the index where the previous window's unsummarized messages
   *  begin: its raw tail, or the first message after it when it had none */
  previous?: { narrative: string; start: number };
  contextWindow: number;
  maxOutputTokens: number;
  /** the agent's own system prompt, reused so the summary call shares its cache prefix */
  systemPrompt?: string;
  /** extra user instructions, e.g. from `/compact <text>` */
  instructions?: string;
}

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
 * the model's max output) with the reserve the 90% trigger leaves free.
 * Asking for the model's full max output on a 90%-full window makes
 * Anthropic reject input + max_tokens as over the limit.
 */
const summaryMaxTokens = (contextWindow: number, maxOutputTokens: number): number => {
  const reserve = contextWindow - (autoCompactTokenLimit(contextWindow) ?? 0);
  return Math.min(Math.floor(0.8 * reserve), maxOutputTokens > 0 ? maxOutputTokens : Infinity);
};

/** Drop the oldest message plus the toolResults it would orphan. */
const dropOldest = (msgs: Message[]): Message[] => {
  let i = 1;
  while (i < msgs.length && msgs[i]!.role === "toolResult") i++;
  return msgs.slice(i);
};

export async function compactWindow(input: CompactWindowInput, deps: CompactWindowDeps): Promise<CompactWindowResult> {
  const { messages, previous } = input;
  const start = previous?.start ?? 0;
  // a tenth of the window keeps small-window models from carrying a tail
  // that refills them right away
  const tailBudget = Math.min(RAW_TAIL_TOKENS, Math.floor(input.contextWindow / 10));
  const tailStart = tailStartIndex(messages, start, tailBudget, deps.estimateTokens);
  const rawTail = messages.slice(tailStart);
  const ledger = buildLedger(messages);
  const ledgerBlock = renderLedger(ledger);

  // codex's rule: the newest real user messages under 20k tokens. Taken from
  // everything before the tail (the tail already carries its own), which
  // matches codex, whose replacement history re-collects them every round.
  const userTexts = messages
    .slice(0, tailStart)
    .filter((m) => m.role === "user")
    .map((m) => contentText(m.content))
    .filter((t) => t && !isSummaryMessage(t));
  const retainedUserMessages = buildCompactedHistoryWithLimit(
    [],
    userTexts.map((message) => ({ message })),
    "",
    COMPACT_USER_MESSAGE_MAX_TOKENS,
  )
    .slice(0, -1)
    .map((item) => messageText(item) ?? "")
    .filter(Boolean);

  // The summarizer sees the previous narrative, never a previous summary
  // with a ledger inside it, then the drained region.
  const maxTokens = summaryMaxTokens(input.contextWindow, input.maxOutputTokens);
  const prior = previous?.narrative.trim()
    ? [userMessage(`Prior narrative from earlier context windows. Keep what still holds and update it with the conversation that follows:\n\n${previous.narrative.trim()}`)]
    : [];
  let history = messages.slice(start, tailStart).filter((m) => !(m.role === "user" && isSummaryMessage(contentText(m.content))));
  // The 90% trigger measured the stubbed view the model was seeing; the raw
  // drained region can be far larger, so the summarizer gets the same view.
  const prompt = narrativePrompt(ledgerBlock, input.instructions);
  const size = [...prior, ...history, userMessage(prompt)].reduce((n, m) => n + deps.estimateTokens(m), 0);
  if (size > input.contextWindow - maxTokens) history = clearOldToolOutputs(history, KEEP_RECENT_TOOL_RESULTS).messages;

  const ask = async (text: string): Promise<string> => {
    for (;;) {
      try {
        return (await deps.summarize(input.systemPrompt ?? "", [...prior, ...history, userMessage(text)], maxTokens)).trim();
      } catch (error) {
        // codex compact.rs front-trim: on overflow drop the oldest and retry
        if (!(error instanceof OverflowError) || history.length === 0) throw error;
        history = dropOldest(history);
      }
    }
  };

  // nothing drained (the tail holds the whole window): there is nothing new
  // to narrate, and a model asked to summarize nothing invents something
  const drainedNothing = history.length === 0;
  let narrative = drainedNothing ? (previous?.narrative.trim() ?? "") : await ask(prompt);
  let failures = drainedNothing ? [] : validateSummary(narrative, ledger);
  const retried = failures.length > 0;
  if (retried) {
    narrative = await ask(
      `${prompt}\n\nYour previous checkpoint had these problems. Write the whole checkpoint again without them:\n${failures.map((f) => `- ${f}`).join("\n")}`,
    );
    failures = validateSummary(narrative, ledger);
    // never block compaction: accept it and say what is missing
    if (failures.length > 0) narrative = `${narrative}\n\n[checkpoint note: still failing after one retry: ${failures.join("; ")}]`;
  }

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
