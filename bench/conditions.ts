/**
 * Three compaction rules behind one signature. Each gets the full raw
 * session up to the compaction boundary plus its own state from the last
 * round, and returns the context the agent would see next.
 */

import { readFileSync } from "node:fs";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_SETTINGS, buildSessionContext, compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
// prepareCompaction is not in pi's package exports; import pi's own file
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { COMPACT_USER_MESSAGE_MAX_TOKENS, buildCompactedHistoryWithLimit, isSummaryMessage, summaryBridgeText } from "../core/compact.ts";
import { contentText, messageText } from "../core/items.ts";
import { OverflowError, compactWindow } from "../core/pipeline.ts";

export interface BenchDeps {
  summarize: (systemPrompt: string, messages: Message[], maxTokens: number) => Promise<string>;
  estimateTokens: (message: Message) => number;
  contextWindow: number;
  maxOutputTokens: number;
}

export type Condition = (messages: Message[], previousState: any, deps: BenchDeps) => Promise<{ contextAfter: Message[]; state: unknown }>;

export const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

/** pi's own prepareCompaction + compact over an in-memory session, with
 *  deps.summarize standing in for pi's model call. */
const pi: Condition = async (messages, previous: { entries: SessionEntry[] } | undefined, deps) => {
  const entries = [...(previous?.entries ?? [])];
  const consumed = entries.filter((e) => e.type === "message").length;
  const append = (e: Record<string, unknown>) =>
    entries.push({ ...e, id: `e${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(0).toISOString() } as SessionEntry);
  for (const message of messages.slice(consumed)) append({ type: "message", message });

  const settings = DEFAULT_COMPACTION_SETTINGS;
  const preparation = prepareCompaction(entries, settings);
  if (!preparation) throw new Error("pi prepareCompaction returned nothing");
  const streamFn = async (_model: unknown, context: { systemPrompt?: string; messages: Message[] }, options?: { maxTokens?: number }) => {
    const text = await deps.summarize(context.systemPrompt ?? "", context.messages, options?.maxTokens ?? deps.maxOutputTokens);
    const result = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as AssistantMessage;
    return { result: async () => result };
  };
  const model = { maxTokens: deps.maxOutputTokens, reasoning: false, contextWindow: deps.contextWindow };
  const result = await compact(preparation, model as never, undefined, undefined, undefined, undefined, undefined, streamFn as never);
  append({ type: "compaction", ...result });
  return { contextAfter: convertToLlm(buildSessionContext(entries).messages), state: { entries } };
};

const CODEX_PROMPT = readFileSync(new URL("../reference/codex-rs/prompts/templates/compact/prompt.md", import.meta.url), "utf8");

/** codex compact.rs: summarize the whole in-window history, then keep the
 *  newest real user messages under 20k tokens and put the summary last. */
const codex: Condition = async (messages, previous: { context: Message[]; consumed: number } | undefined, deps) => {
  let history = [...(previous?.context ?? []), ...messages.slice(previous?.consumed ?? 0)];
  let summary: string;
  for (;;) {
    try {
      summary = (await deps.summarize("", [...history, userMessage(CODEX_PROMPT)], deps.maxOutputTokens)).trim();
      break;
    } catch (error) {
      // compact.rs front-trim: drop the oldest item and retry
      if (!(error instanceof OverflowError) || history.length === 0) throw error;
      let i = 1;
      while (i < history.length && history[i]!.role === "toolResult") i++;
      history = history.slice(i);
    }
  }
  const users = history
    .filter((m) => m.role === "user")
    .map((m) => contentText(m.content))
    .filter((t) => t && !isSummaryMessage(t))
    .map((message) => ({ message }));
  const context = buildCompactedHistoryWithLimit([], users, summaryBridgeText(summary), COMPACT_USER_MESSAGE_MAX_TOKENS).map((item) =>
    userMessage(messageText(item) ?? ""),
  );
  return { contextAfter: context, state: { context, consumed: messages.length } };
};

/** core/pipeline.ts, laid out the way pi/index.ts renders it (minus
 *  rehydrated files and project memory, which need a real disk). */
const mempact: Condition = async (messages, previous: { narrative: string; start: number } | undefined, deps) => {
  const r = await compactWindow(
    { messages, previous, contextWindow: deps.contextWindow, maxOutputTokens: deps.maxOutputTokens },
    { summarize: deps.summarize, estimateTokens: deps.estimateTokens },
  );
  return {
    contextAfter: [...r.retainedUserMessages.map(userMessage), userMessage(r.summaryText), ...r.rawTail],
    state: { narrative: r.narrative, start: messages.length - r.rawTail.length },
  };
};

export const CONDITIONS = { pi, codex, mempact } as const;
