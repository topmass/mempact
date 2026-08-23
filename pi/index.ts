/**
 * mempact pi extension - runs the codex compaction engine ("Memento",
 * openai/codex @ rust-v0.142.5) inside the pi coding agent.
 *
 * Takeover points (see project README and reference/PIN.md):
 * - session_before_compact: replaces ALL pi compaction (auto, /compact,
 *   ctx.compact()) with the codex algorithm: summarize the whole active
 *   window with SUMMARIZATION_PROMPT, keep <=20k tokens of real user
 *   messages, summary (SUMMARY_PREFIX-bridged) always LAST.
 * - context: re-orders each request to codex's exact layout (pi renders
 *   compaction summaries first; codex trains the model to see it last).
 * - turn_end: codex trigger - fires at min(configured, contextWindow*9/10),
 *   plus the one-shot token-budget reminder per window.
 * - tool_result: codex record-time cap - 10KB (x1.2 slack) middle-ellipsis
 *   truncation of tool output text before it is persisted.
 * - new_context tool: codex's model-invokable hard reset (no summary).
 *
 * Install (~/.pi/agent/settings.json):
 *   "extensions": ["/home/topmass/Code/mempact/pi/index.ts"],
 *   "compaction": { "enabled": false }   // disables only pi's built-in trigger
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import * as piAiMain from "@earendil-works/pi-ai";
import type {
  CompactionEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import {
  SUMMARIZATION_PROMPT,
  buildCompactedHistory,
  collectUserMessages,
  summaryBridgeText,
} from "../core/compact.ts";
import type { HistoryItem } from "../core/items.ts";
import { messageText } from "../core/items.ts";
import { AutoCompactWindow, type AutoCompactWindowIds } from "../core/autoCompactWindow.ts";
import {
  autoCompactTokenLimit,
  autoCompactTokenStatus,
  tokensUntilCompaction,
} from "../core/trigger.ts";
import {
  MEMORY_SECTIONS,
  appendToSection,
  emptyMemory,
  getSection,
  renderForContext,
  setSection,
} from "../core/memory.ts";
import {
  buildProbes,
  extractRunFacts,
  formatQuiz,
  gradeQuiz,
  handoffFactsBlock,
  mustPreserveSection,
  runFactsBlock,
} from "../core/checkride.ts";
import { clearOldToolOutputs } from "../core/toolClearing.ts";
import { type FileOpLists, collectFileOps, renderFileOps } from "../core/fileOps.ts";
import { type SearchableText, searchTexts } from "../core/recall.ts";
import { maybeTokenBudgetReminder } from "../core/tokenBudget.ts";
import {
  DEFAULT_TRUNCATION_POLICY,
  SERIALIZATION_BUDGET_MULTIPLIER,
  byteBudget,
  mulPolicy,
} from "../core/outputTruncation.ts";
import { truncateMiddleChars } from "../core/truncate.ts";
import { readSpill, searchSpills, spillFullOutput, spillNotice } from "../core/spill.ts";

// ---------------------------------------------------------------------------
// pi-ai compatibility: `complete` moved to "@earendil-works/pi-ai/compat" at
// pi 0.84.x (the main-entry export is gone from the npm typings and slated
// for removal from pi's bundle). Resolve it at runtime, preferring the main
// entry (pi <=0.80 and pi's current bundle), falling back to /compat.
// isContextOverflow (official multi-provider classifier, covers llama.cpp's
// "exceeds the available context size" which the old regex missed) is used
// when available, with the legacy heuristic as fallback.
// ---------------------------------------------------------------------------

type CompleteFn = (
  model: unknown,
  context: { systemPrompt?: string; messages: Message[] },
  options?: Record<string, unknown>,
) => Promise<AssistantMessage>;

let completeFn: CompleteFn | null = (piAiMain as { complete?: CompleteFn }).complete ?? null;
const completeReady: Promise<void> = completeFn
  ? Promise.resolve()
  : import("@earendil-works/pi-ai/compat").then(
      (m) => {
        completeFn = (m as { complete?: CompleteFn }).complete ?? null;
      },
      () => {},
    );

async function completeCompat(
  model: unknown,
  context: { systemPrompt?: string; messages: Message[] },
  options?: Record<string, unknown>,
): Promise<AssistantMessage> {
  if (!completeFn) await completeReady;
  if (!completeFn) throw new Error("pi-ai complete() unavailable (checked main and /compat)");
  // 0.84.x auth headers may carry `null` = "delete this header"; strip them
  // before the raw provider call (pi strips internally, we must too).
  const headers = options?.headers as Record<string, string | null> | undefined;
  const cleanHeaders = headers
    ? Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null))
    : undefined;
  return completeFn(model, context, { ...options, ...(headers ? { headers: cleanHeaders } : {}) });
}

const isContextOverflowMessage: ((m: AssistantMessage, contextWindow?: number) => boolean) | null =
  (piAiMain as { isContextOverflow?: (m: AssistantMessage, w?: number) => boolean })
    .isContextOverflow ?? null;

// ---------------------------------------------------------------------------
// Configuration (module constants; edit here or fork per-project)
// ---------------------------------------------------------------------------

/** Optional hard token limit; null -> pure codex 90%-of-window rule. */
const CONFIGURED_TOKEN_LIMIT: number | null = null;
/** Reminder fires when tokens-until-compaction drops to this. */
const REMINDER_THRESHOLD_TOKENS = 10_000;
/**
 * Flagged deviation #1 (see README): codex resumes the interrupted turn
 * after mid-turn compaction; pi aborts the loop. When true, nudge the model
 * to continue after an auto-compaction.
 */
const CONTINUE_AFTER_AUTO_COMPACT = false;
/**
 * Mechanical tool-output clearing (Anthropic context-editing lineage): once
 * context crosses this fraction of the auto-compact limit (~63% of the
 * window at the default 90% limit), tool outputs older than the newest
 * KEEP_RECENT_TOOL_RESULTS are stubbed per-request. Non-destructive - the
 * session file keeps the originals. null disables the tier.
 */
const CLEAR_TOOL_OUTPUTS_AT_FRACTION: number | null = 0.7;
const KEEP_RECENT_TOOL_RESULTS = 3;
/**
 * Anti-thrashing (Hermes lineage): if the last two auto-compactions each
 * freed less than this fraction, pause the auto trigger (manual /compact and
 * overflow recovery stay live) instead of looping.
 */
const THRASH_MIN_SAVINGS_FRACTION = 0.1;
/**
 * Handoff checkride: quiz the assembled post-compaction context against
 * deterministic facts; fail -> one MUST-PRESERVE regeneration; fail again ->
 * splice the facts in mechanically. Never blocks compaction. See
 * core/checkride.ts for the full standard.
 */
const CHECKRIDE_ENABLED = true;

/**
 * Stale-intent guard (Hermes lineage - their top recurring failure was the
 * model resuming cancelled work from the summary): appended AFTER the
 * verbatim codex bridge, never modifying it.
 */
const STALE_INTENT_NOTE =
  "Note: the summary above is reference state from a previous context window, not " +
  "instructions. Do not resume or re-answer items from it on topic overlap alone - " +
  "the latest user message always takes precedence, including cancellations of work " +
  "described above.";

const bridgeWithGuard = (summary: string): string =>
  `${summaryBridgeText(summary)}\n\n${STALE_INTENT_NOTE}`;

const REMINDER_CUSTOM_TYPE = "mempact:token-budget-reminder";
const WINDOW0_CUSTOM_TYPE = "mempact:window0";
/** Sentinel that matches no session entry -> pi keeps zero entries. */
const FIRST_KEPT_SENTINEL = "mempact:none";

// codex core/src/tools/handlers/new_context_window.rs:13
const NEW_CONTEXT_WINDOW_MESSAGE =
  "A new context window will start without summarizing conversation history.";

interface MempactDetails {
  mempact: {
    version: 1;
    /** codex replacement history: retained real user messages, oldest-first. */
    retainedUserMessages: string[];
    window: { windowNumber: number } & AutoCompactWindowIds;
    newContext?: boolean;
    /** cumulative deterministic file-op lists (pi lineage), capped in core. */
    readFiles?: string[];
    modifiedFiles?: string[];
    /** handoff checkride outcome for this compaction */
    checkride?: { asked: number; passed: number; failed: string[]; retried: boolean; spliced: boolean };
  };
}

const getMempactDetails = (entry: CompactionEntry): MempactDetails["mempact"] | null => {
  const details = entry.details as MempactDetails | undefined;
  return details?.mempact ?? null;
};

const latestCompactionEntry = (entries: SessionEntry[]): CompactionEntry | null => {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") return entries[i] as CompactionEntry;
  }
  return null;
};

const userMsg = (text: string, timestamp: number): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const textOf = (content: string | readonly { type: string; text?: string }[]): string =>
  typeof content === "string"
    ? content
    : content
        .filter((c): c is TextContent => c.type === "text" && !!(c as TextContent).text)
        .map((c) => c.text)
        .join("\n");

/**
 * Project memory (Letta/MemGPT memory-block lineage): a plain markdown file
 * the model maintains via the update_memory tool. Injected fresh from disk
 * on every request, so it is never part of compacted history - it survives
 * compaction and restarts by construction. No file -> zero overhead.
 */
const memoryFilePath = (cwd: string): string => join(cwd, ".mempact", "memory.md");
const readMemoryFile = (cwd: string): string | null => {
  try {
    return readFileSync(memoryFilePath(cwd), "utf8");
  } catch {
    return null;
  }
};

/**
 * Heuristic overflow classifier - fallback when pi-ai's official
 * `isContextOverflow` is unavailable (pi <=0.80). The llama.cpp / LM Studio /
 * Groq alternates were missing from the original regex (audit F4): llama.cpp
 * reports "exceeds the available context size", which never matched.
 */
export const isContextOverflowError = (error: unknown): boolean => {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /context.{0,20}(window|length|limit|size)|too (long|large|many tokens)|maximum (context|.{0,20}tokens)|prompt is too long|exceeds? the (context|token|available context)|greater than the context length|reduce the length of the messages|input token count exceeds|maximum prompt length is/.test(
      msg,
    )
  );
};

export default function (pi: ExtensionAPI) {
  const window = new AutoCompactWindow();
  let compacting = false;
  let newContextRequested = false;
  let warnedAboutBuiltinTrigger = false;
  let lastClearedCount = 0;
  // Anti-thrashing: savings fraction of the last two compactions, measured
  // when post-compaction usage first becomes known.
  const recentSavings: number[] = [];
  let pendingTokensBefore: number | null = null;
  let thrashNotified = false;
  // "Nothing to compact" backoff (audit F3): pi's prepareCompaction measures
  // session entries against keepRecentTokens, while our trigger measures the
  // full request envelope (system prompt included). When they disagree, pi
  // throws before session_before_compact ever fires - retrying every turn_end
  // would abort in-flight work forever. Pause until the branch has grown.
  let nothingToCompactAtEntryCount: number | null = null;
  const NOTHING_TO_COMPACT_RETRY_GROWTH = 8;
  let printModeNotified = false;

  // -------------------------------------------------------------------------
  // session_start: restore window chain + reminder one-shot from the JSONL
  // -------------------------------------------------------------------------
  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const lastCompaction = latestCompactionEntry(entries);
    const mempact = lastCompaction ? getMempactDetails(lastCompaction) : null;
    if (mempact) {
      window.restore(mempact.window.windowNumber, {
        firstWindowId: mempact.window.firstWindowId,
        previousWindowId: mempact.window.previousWindowId,
        windowId: mempact.window.windowId,
      });
    } else {
      const window0 = entries.find(
        (e) => e.type === "custom" && e.customType === WINDOW0_CUSTOM_TYPE,
      );
      if (window0 && window0.type === "custom") {
        const data = window0.data as AutoCompactWindowIds | undefined;
        if (data?.windowId) window.restore(0, { ...data, previousWindowId: null });
      } else {
        pi.appendEntry(WINDOW0_CUSTOM_TYPE, window.currentIds());
      }
    }

    // Reminder already delivered in the current window? (survives restarts)
    const lastCompactionIdx = lastCompaction ? entries.indexOf(lastCompaction) : -1;
    const reminderDelivered = entries
      .slice(lastCompactionIdx + 1)
      .some((e) => e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE);
    if (reminderDelivered) window.markTokenBudgetReminderDelivered();
  });

  // -------------------------------------------------------------------------
  // session_before_compact: the codex compaction takeover
  // -------------------------------------------------------------------------
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, signal } = event;

    if (preparation.settings.enabled && !warnedAboutBuiltinTrigger && ctx.hasUI) {
      warnedAboutBuiltinTrigger = true;
      ctx.ui.notify(
        'mempact: set {"compaction":{"enabled":false}} in ~/.pi/agent/settings.json so the codex 90% trigger owns compaction timing',
        "warning",
      );
    }

    // new_context tool path: hard reset, no summary, no LLM call
    // (codex core/src/session/mod.rs:3395 maybe_start_new_context_window).
    if (window.takeNewContextWindowRequest()) {
      const [windowNumber, ids] = window.advance();
      return {
        compaction: {
          // window id suffix keeps every summary unique: pi locates the saved
          // entry by summary string equality (agent-session.ts:1956), so two
          // identical summaries would hand session_compact the WRONG entry.
          summary: `Context window cleared via new_context. [window ${ids.windowId}]`,
          firstKeptEntryId: FIRST_KEPT_SENTINEL,
          tokensBefore: preparation.tokensBefore,
          details: {
            mempact: {
              version: 1,
              retainedUserMessages: [],
              window: { windowNumber, ...ids },
              newContext: true,
            },
          } satisfies MempactDetails,
        },
      };
    }

    if (!ctx.model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) {
      if (ctx.hasUI) ctx.ui.notify("mempact: no model auth, falling back to pi compaction", "warning");
      return undefined;
    }

    // Rebuild the FULL active window (codex summarizes everything in
    // context, not just pi's pre-cut segment): entries after the last
    // compaction, with the previous mempact layout re-applied in front.
    // `realUserTexts` tracks only genuine user prompts - synthetic
    // user-role context (custom_message entries like our token-budget
    // reminder) stays in the summarization input but is excluded from
    // retention, matching codex's contextual-fragment filter
    // (event_mapping.rs:44).
    const effective: AgentMessage[] = [];
    const realUserTexts: string[] = [];
    const lastCompaction = latestCompactionEntry(branchEntries);
    if (lastCompaction) {
      const prev = getMempactDetails(lastCompaction);
      const ts = Date.parse(lastCompaction.timestamp) || Date.now();
      if (prev) {
        for (const text of prev.retainedUserMessages) {
          effective.push(userMsg(text, ts));
          realUserTexts.push(text);
        }
        if (!prev.newContext) effective.push(userMsg(bridgeWithGuard(lastCompaction.summary), ts));
      } else if (lastCompaction.summary) {
        effective.push(userMsg(bridgeWithGuard(lastCompaction.summary), ts));
      }
    }
    const start = lastCompaction ? branchEntries.indexOf(lastCompaction) + 1 : 0;
    for (const entry of branchEntries.slice(start)) {
      if (entry.type === "message") {
        effective.push(entry.message);
        if (entry.message.role === "user") realUserTexts.push(textOf(entry.message.content));
      } else if (entry.type === "custom_message") {
        effective.push(userMsg(textOf(entry.content), Date.parse(entry.timestamp) || Date.now()));
      }
    }

    // codex compact.rs:84,212: append the summarization prompt as a user
    // message on top of real history; custom instructions override it.
    const promptText = event.customInstructions?.trim() || SUMMARIZATION_PROMPT;
    const history: Message[] = convertToLlm(effective);
    const systemPrompt = ctx.getSystemPrompt();

    // codex compact.rs:233-296 front-trim retry loop, on pi's flat message
    // model: dropping a leading message also drops the toolResults that
    // would be orphaned (pairing rule from context_manager/normalize.rs).
    const dropOldest = (msgs: Message[]): void => {
      msgs.shift();
      while (msgs.length > 0 && msgs[0]!.role === "toolResult") msgs.shift();
    };
    const maxRetries = 3;
    let retries = 0;
    let summary = "";
    try {
      for (;;) {
        const messages: Message[] = [...history, userMsg(promptText, Date.now())];
        try {
          const response = await completeCompat(
            ctx.model,
            { systemPrompt, messages },
            {
              apiKey: auth.apiKey,
              headers: auth.headers,
              maxTokens: ctx.model.maxTokens,
              signal,
            },
          );
          summary = response.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (response.stopReason === "error") {
            throw new Error(response.errorMessage ?? "summarization request failed");
          }
          break;
        } catch (error) {
          if (signal.aborted) return undefined;
          if (isContextOverflowError(error) && history.length > 1) {
            dropOldest(history);
            retries = 0;
            continue;
          }
          if (retries < maxRetries) {
            retries += 1;
            await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** retries, 5_000)));
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (ctx.hasUI) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`mempact compaction failed (${msg}); falling back to pi compaction`, "error");
      }
      return undefined;
    }

    if (!summary.trim()) {
      if (!signal.aborted && ctx.hasUI)
        ctx.ui.notify("mempact: empty summary, falling back to pi compaction", "warning");
      return undefined;
    }

    // Deterministic file-op lists (pi lineage): extracted mechanically from
    // this window's toolCalls, merged with the previous compaction's lists,
    // appended to the summary so file state survives the summarizer.
    const prevOps: FileOpLists = {
      readFiles: (lastCompaction && getMempactDetails(lastCompaction)?.readFiles) || [],
      modifiedFiles: (lastCompaction && getMempactDetails(lastCompaction)?.modifiedFiles) || [],
    };
    const fileOps = collectFileOps(effective, prevOps);
    const runFacts = extractRunFacts(effective as never);
    const spliceBlock = [
      renderFileOps(fileOps),
      runFactsBlock({ ...runFacts, lastUserMessage: realUserTexts[realUserTexts.length - 1] }),
    ]
      .filter(Boolean)
      .join("\n");
    if (spliceBlock) summary = `${summary}\n\n${spliceBlock}`;

    // codex replacement history: <=20k tokens of real user messages
    // (newest-first selection, oldest middle-truncated) + summary last.
    const userItems: HistoryItem[] = realUserTexts.map((text) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    }));
    const collected = collectUserMessages(userItems);
    const rebuilt = buildCompactedHistory([], collected, summaryBridgeText(summary));
    const retainedUserMessages = rebuilt
      .slice(0, -1)
      .map((item) => messageText(item) ?? "")
      .filter((t) => t.length > 0);

    // Handoff checkride: quiz the ACTUAL post-compaction context against
    // deterministic facts. Wrapped so the safety layer can never break the
    // compaction it protects.
    let checkride: NonNullable<MempactDetails["mempact"]["checkride"]> | undefined;
    if (CHECKRIDE_ENABLED) {
      try {
        const memoryMd = readMemoryFile(ctx.cwd);
        const probes = buildProbes({
          modifiedFiles: fileOps.modifiedFiles,
          lastRun: runFacts.lastRun,
          lastError: runFacts.lastError,
          lastUserMessage: realUserTexts[realUserTexts.length - 1],
          memoryNext: memoryMd ? getSection(memoryMd, "Next") : undefined,
          memoryDoneItems: memoryMd
            ? getSection(memoryMd, "Plan").split("\n").filter((l) => /\[x\]/i.test(l))
            : undefined,
          memoryDecisions: memoryMd
            ? getSection(memoryMd, "Decisions").split("\n").filter((l) => l.trim())
            : undefined,
        });
        if (probes.length > 0) {
          const quiz = async (candidateSummary: string) => {
            const quizMessages: Message[] = [
              ...retainedUserMessages.map((t) => userMsg(t, Date.now())),
              userMsg(bridgeWithGuard(candidateSummary), Date.now()),
              ...(memoryMd ? [userMsg(renderForContext(memoryMd), Date.now())] : []),
              userMsg(formatQuiz(probes), Date.now()),
            ];
            const response = await completeCompat(
              ctx.model!,
              {
                systemPrompt: "You answer verification questions strictly from the provided record.",
                messages: quizMessages,
              },
              { apiKey: auth.apiKey!, headers: auth.headers, maxTokens: 1500, signal },
            );
            const answer = response.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            return gradeQuiz(probes, answer);
          };

          let result = await quiz(summary);
          let retried = false;
          let spliced = false;
          if (result.failed.length > 0) {
            retried = true;
            try {
              const retryPrompt = `${promptText}\n\n${mustPreserveSection(result.failed)}`;
              const response = await completeCompat(
                ctx.model!,
                { systemPrompt, messages: [...history, userMsg(retryPrompt, Date.now())] },
                { apiKey: auth.apiKey!, headers: auth.headers, maxTokens: ctx.model!.maxTokens, signal },
              );
              const retriedSummary = response.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n");
              if (retriedSummary.trim()) {
                const candidate = spliceBlock ? `${retriedSummary}\n\n${spliceBlock}` : retriedSummary;
                const second = await quiz(candidate);
                if (second.failed.length < result.failed.length) {
                  summary = candidate;
                  result = second;
                }
              }
            } catch {
              // retry is best-effort; the original summary stands
            }
            if (result.failed.length > 0) {
              // Mechanical splice: the facts get through without any model
              // cooperation. Compaction ships regardless.
              spliced = true;
              summary = `${summary}\n\n${handoffFactsBlock(result.failed)}`;
            }
          }
          checkride = {
            asked: probes.length,
            passed: probes.length - result.failed.length,
            failed: result.failed.map((p) => p.id),
            retried,
            spliced,
          };
        }
      } catch {
        // never block compaction on verification machinery
      }
    }

    const [windowNumber, ids] = window.advance();
    return {
      compaction: {
        summary,
        firstKeptEntryId: FIRST_KEPT_SENTINEL,
        tokensBefore: preparation.tokensBefore,
        details: {
          mempact: {
            version: 1,
            retainedUserMessages,
            window: { windowNumber, ...ids },
            readFiles: fileOps.readFiles,
            modifiedFiles: fileOps.modifiedFiles,
            checkride,
          },
        } satisfies MempactDetails,
      },
    };
  });

  // -------------------------------------------------------------------------
  // session_compact_failed (pi >=0.84): reset in-flight state when a
  // compaction we did not start fails, so the trigger cannot stay wedged.
  // Registered via a cast: 0.78 typings lack the event; 0.78 runtimes simply
  // never emit it.
  // -------------------------------------------------------------------------
  (pi.on as (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => void)(
    "session_compact_failed",
    (event) => {
      compacting = false;
      const msg = String((event as { errorMessage?: string })?.errorMessage ?? "");
      if (/nothing to compact/i.test(msg) && nothingToCompactAtEntryCount == null) {
        nothingToCompactAtEntryCount = 0;
      }
    },
  );

  // -------------------------------------------------------------------------
  // session_compact: bookkeeping after ANY compaction (ours or foreign)
  // -------------------------------------------------------------------------
  pi.on("session_compact", (event, ctx) => {
    compacting = false;
    nothingToCompactAtEntryCount = null;
    pendingTokensBefore = event.compactionEntry.tokensBefore ?? null;
    thrashNotified = false;
    // Foreign compaction (pi fallback or another extension): still advance
    // the window chain so numbering matches codex semantics.
    if (!getMempactDetails(event.compactionEntry)) window.advance();
    if (CONTINUE_AFTER_AUTO_COMPACT && !ctx.isIdle()) return;
  });

  // -------------------------------------------------------------------------
  // context: enforce codex's exact post-compaction request layout, then the
  // mechanical clearing tier, then the project-memory injection
  // -------------------------------------------------------------------------
  pi.on("context", (event, ctx) => {
    let messages = event.messages;

    // 1) codex layout: retained user messages + SUMMARY_PREFIX bridge LAST
    const idx = messages.findIndex((m) => m.role === "compactionSummary");
    if (idx !== -1) {
      const entry = latestCompactionEntry(ctx.sessionManager.getBranch());
      const mempact = entry ? getMempactDetails(entry) : null;
      if (mempact) {
        const summaryMsg = messages[idx]! as { timestamp?: number };
        const ts = summaryMsg.timestamp ?? Date.now();
        const replacement: AgentMessage[] = mempact.newContext
          ? []
          : [
              ...mempact.retainedUserMessages.map((text) => userMsg(text, ts)),
              // codex compact.rs:301: SUMMARY_PREFIX bridge as a user message, LAST
              userMsg(bridgeWithGuard(entry!.summary), ts),
            ];
        messages = [...messages];
        messages.splice(idx, 1, ...replacement);
      }
    }

    // 2) clearing tier: stub old tool outputs once past the threshold.
    // usage only grows within a window, so this stays on until compaction
    // resets it - no flapping, and stubs are byte-stable across requests.
    if (CLEAR_TOOL_OUTPUTS_AT_FRACTION != null) {
      const usage = ctx.getContextUsage();
      const limit = usage ? autoCompactTokenLimit(usage.contextWindow, CONFIGURED_TOKEN_LIMIT) : null;
      if (usage?.tokens != null && limit != null && usage.tokens >= limit * CLEAR_TOOL_OUTPUTS_AT_FRACTION) {
        const result = clearOldToolOutputs(messages, KEEP_RECENT_TOOL_RESULTS);
        if (result.cleared > 0) {
          messages = result.messages;
          lastClearedCount = result.cleared;
        }
      }
    }

    // 3) project memory: injected fresh from disk every request so mid-session
    // edits and compaction can't stale or drop it. Placed immediately BEFORE
    // the last real user message (audit F7): the ordering invariant is
    // "latest real user instruction > memory", so memory must never sit below
    // the live request where it competes for last-message recency and can be
    // mistaken for the newest user turn.
    const memory = readMemoryFile(ctx.cwd);
    if (memory) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as { role?: string }).role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const ts =
        lastUserIdx >= 0
          ? ((messages[lastUserIdx] as { timestamp?: number }).timestamp ?? Date.now())
          : Date.now();
      const block = userMsg(renderForContext(memory), ts);
      messages = [...messages];
      if (lastUserIdx >= 0) messages.splice(lastUserIdx, 0, block);
      else messages.push(block);
    }

    return messages === event.messages ? undefined : { messages };
  });

  // -------------------------------------------------------------------------
  // turn_end: codex trigger (90% rule) + token-budget reminder + deferred
  // new_context compact
  // -------------------------------------------------------------------------
  pi.on("turn_end", (event, ctx) => {
    const triggerCompaction = () => {
      if (compacting) return;
      compacting = true;
      // The callbacks run async; the extension ctx may be stale by then
      // (session replaced, /reload, or -p mode exiting), so guard all use.
      ctx.compact({
        onComplete: () => {
          compacting = false;
          if (CONTINUE_AFTER_AUTO_COMPACT) {
            try {
              pi.sendMessage(
                {
                  customType: "mempact:continue",
                  content:
                    "Context was compacted mid-task. Continue the previous task using the handoff summary above.",
                  display: false,
                },
                { triggerTurn: true },
              );
            } catch {
              // stale runtime; nothing to continue
            }
          }
        },
        onError: (error) => {
          compacting = false;
          if (/nothing to compact/i.test(error.message)) {
            try {
              nothingToCompactAtEntryCount = ctx.sessionManager.getBranch().length;
            } catch {
              nothingToCompactAtEntryCount = 0;
            }
          }
          try {
            if (ctx.hasUI) ctx.ui.notify(`mempact compaction failed: ${error.message}`, "error");
          } catch {
            // stale runtime after session teardown; drop the notification
          }
        },
      });
    };

    if (newContextRequested) {
      newContextRequested = false;
      window.requestNewContextWindow();
      triggerCompaction();
      return;
    }

    // Replaces pi's built-in overflow recovery (disabled via settings).
    // Prefer pi-ai's official multi-provider classifier (covers llama.cpp's
    // "exceeds the available context size", silent overflow, etc. - audit F4);
    // fall back to the string heuristic on old pi versions.
    const message = event.message as { stopReason?: string; errorMessage?: string };
    const cw = ctx.getContextUsage()?.contextWindow;
    const overflowed = isContextOverflowMessage
      ? isContextOverflowMessage(event.message as unknown as AssistantMessage, cw)
      : message.stopReason === "error" && isContextOverflowError(message.errorMessage ?? "");
    if (overflowed) {
      triggerCompaction();
      return;
    }

    const usage = ctx.getContextUsage();
    if (usage?.tokens == null) return;

    // Print mode (audit F2): ctx.compact() aborts the in-flight run, and a
    // -p process exits before the async compaction persists - the task dies
    // mid-tool-chain and the compaction is lost. Threshold-triggered
    // compaction is therefore disabled in print mode (overflow recovery
    // above stays live as a last resort).
    if ((ctx as { mode?: string }).mode === "print") {
      if (!printModeNotified) {
        printModeNotified = true;
        try {
          if (ctx.hasUI) ctx.ui.notify("mempact: print mode - threshold auto-compaction disabled", "info");
        } catch {
          // no UI in print mode; expected
        }
      }
      return;
    }

    // "Nothing to compact" backoff (audit F3): wait for real entry growth
    // before re-arming the threshold trigger.
    if (nothingToCompactAtEntryCount != null) {
      const grown =
        ctx.sessionManager.getBranch().length >=
        nothingToCompactAtEntryCount + NOTHING_TO_COMPACT_RETRY_GROWTH;
      if (!grown) return;
      nothingToCompactAtEntryCount = null;
    }

    // Record the previous compaction's savings once real usage is known.
    if (pendingTokensBefore != null && pendingTokensBefore > 0) {
      recentSavings.push(1 - usage.tokens / pendingTokensBefore);
      if (recentSavings.length > 2) recentSavings.shift();
      pendingTokensBefore = null;
    }

    const status = autoCompactTokenStatus({
      activeContextTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      configuredLimit: CONFIGURED_TOKEN_LIMIT,
      scope: "total",
    });
    if (status.tokenLimitReached) {
      // Anti-thrashing: two consecutive near-no-op compactions -> pause the
      // auto trigger (overflow recovery above and manual /compact stay live).
      const thrashing =
        recentSavings.length === 2 &&
        recentSavings.every((s) => s < THRASH_MIN_SAVINGS_FRACTION);
      if (thrashing) {
        if (!thrashNotified && ctx.hasUI) {
          thrashNotified = true;
          ctx.ui.notify(
            "mempact: auto-compaction paused - the last two compactions each freed <10%. /compact manually or start a new session.",
            "warning",
          );
        }
        return;
      }
      triggerCompaction();
      return;
    }

    const reminder = maybeTokenBudgetReminder({
      tokensUntilCompaction: tokensUntilCompaction(status),
      reminderThresholdTokens: REMINDER_THRESHOLD_TOKENS,
      claimReminder: () => window.claimTokenBudgetReminder(),
    });
    if (reminder) {
      // Pre-compaction memory flush (OpenClaw lineage), folded into the
      // one-shot reminder when a memory file exists.
      // ponytail: nudge only; upgrade to a forced silent turn if models
      // ignore it in practice.
      const content = readMemoryFile(ctx.cwd)
        ? `${reminder}\n\n[mempact] Compaction is approaching. Persist durable state to project memory NOW via update_memory: decisions made, files touched and why, and the exact next step.`
        : reminder;
      pi.sendMessage(
        { customType: REMINDER_CUSTOM_TYPE, content, display: true },
        { triggerTurn: false },
      );
    }
  });

  // -------------------------------------------------------------------------
  // tool_result: codex record-time ingestion cap (10KB x1.2, middle-ellipsis)
  // history.rs:362 process_item / truncate_function_output_payload
  //
  // AUDIT F1 FIX - spill-first retention: upstream codex applies this cap
  // only to the in-memory model history while its rollout JSONL keeps the
  // full item; pi has no second store, and this hook runs BEFORE pi persists
  // the result, so plain truncation destroyed the only canonical copy. Now
  // the full text is spilled to .mempact/spill/<toolCallId>.txt (atomic,
  // sha256-indexed, git-ignored) BEFORE the preview cap, and the preview
  // carries an exact locator. Spill failure falls back to the pure codex
  // behavior (fail-open) - the cap itself is never skipped.
  // -------------------------------------------------------------------------
  pi.on("tool_result", (event, ctx) => {
    const policy = mulPolicy(DEFAULT_TRUNCATION_POLICY, SERIALIZATION_BUDGET_MULTIPLIER);
    const capBytes = byteBudget(policy);
    const encoder = new TextEncoder();
    let changed = false;
    const content = event.content.map((c) => {
      if (c.type !== "text" || encoder.encode(c.text).length <= capBytes) return c;
      changed = true;
      const fullBytes = encoder.encode(c.text).length;
      const preview = truncateMiddleChars(c.text, byteBudget(DEFAULT_TRUNCATION_POLICY));
      const ref = spillFullOutput(ctx.cwd, event.toolCallId, event.toolName, c.text);
      if (!ref) return { ...c, text: preview }; // fail-open: codex-verbatim behavior
      const omitted = Math.max(0, fullBytes - encoder.encode(preview).length);
      return { ...c, text: `${preview}\n${spillNotice(ref, omitted)}` };
    });
    return changed ? { content } : undefined;
  });

  // -------------------------------------------------------------------------
  // new_context tool - codex tools/handlers/new_context_window_spec.rs
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "new_context",
    label: "New context window",
    description: "Start a new context window.",
    parameters: Type.Object({}),
    async execute() {
      // Deferred: compacting inside execute would abort the very turn
      // recording this tool result. turn_end picks the flag up.
      newContextRequested = true;
      return {
        content: [{ type: "text", text: NEW_CONTEXT_WINDOW_MESSAGE }],
        details: undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // update_memory tool - durable project memory at .mempact/memory.md
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "update_memory",
    label: "Update project memory",
    description:
      "Update the durable project memory (.mempact/memory.md). It is re-injected " +
      "into context every turn and survives context compaction and restarts. " +
      "For substantial or long-running tasks: set Goal once from the task/spec; " +
      "keep Plan checkboxes and Next current (Next = the exact next action, " +
      "concrete enough to act on cold); append one-line Decisions with a short " +
      "rationale; list important Files as 'path - why it matters'. " +
      "action 'set' replaces the whole section; 'append' adds one line.",
    parameters: Type.Object({
      section: Type.Union(MEMORY_SECTIONS.map((s) => Type.Literal(s))),
      action: Type.Union([Type.Literal("set"), Type.Literal("append")]),
      content: Type.String({ description: "Section text (set) or a single line (append)." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = memoryFilePath(ctx.cwd);
      const current = readMemoryFile(ctx.cwd) ?? emptyMemory();
      const next =
        params.action === "append"
          ? appendToSection(current, params.section, params.content)
          : setSection(current, params.section, params.content);
      mkdirSync(dirname(path), { recursive: true });
      // atomic write (audit F8): a crash mid-write must never leave a
      // half-written memory.md - it is the durable working-state layer.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, next, "utf8");
      renameSync(tmp, path);
      return {
        content: [{ type: "text", text: `Project memory updated (${params.section}).` }],
        details: undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // recall tool v2 - two-stage retrieval over the append-only session record
  // and the full-output spill artifacts (audit F6):
  //   search -> ranked snippets with stable entry ids + provenance
  //   read   -> exact source content by id (entry or spill artifact)
  // Scope is explicit: "active" (default) searches only the current lineage;
  // "all" also searches abandoned branches, labeled as off-branch evidence.
  // -------------------------------------------------------------------------
  const RECALL_READ_MAX_LINES = 400;
  /** Keep read replies under the record-time cap so a recall result is never
   *  itself spilled (which would be harmless but confusing). */
  const RECALL_READ_MAX_BYTES = 9_000;
  const capReadText = (text: string): string => {
    const enc = new TextEncoder();
    if (enc.encode(text).length <= RECALL_READ_MAX_BYTES) return text;
    let out = text;
    while (enc.encode(out).length > RECALL_READ_MAX_BYTES) {
      out = out.slice(0, Math.floor(out.length * 0.9));
    }
    return `${out}\n[recall: reply capped at ${RECALL_READ_MAX_BYTES} bytes - continue with a higher offset]`;
  };
  const entryTextOf = (entry: SessionEntry): { text: string; label: string } | null => {
    if (entry.type === "message") {
      const m = entry.message as {
        role?: string;
        toolName?: string;
        content?: string | { type: string; text?: string }[];
      };
      const text = m.content ? textOf(m.content as never) : "";
      if (!text) return null;
      const role = m.role === "toolResult" ? `toolResult:${m.toolName ?? "tool"}` : (m.role ?? "?");
      return { text, label: role };
    }
    if (entry.type === "custom_message") {
      const text = textOf(entry.content as never);
      return text ? { text, label: "note" } : null;
    }
    if (entry.type === "compaction") {
      return {
        text: entry.summary,
        label: "compaction-summary (model-written; verify against originals)",
      };
    }
    if (entry.type === "branch_summary") {
      const be = entry as unknown as { summary?: string };
      return be.summary
        ? { text: be.summary, label: "branch-summary (model-written)" }
        : null;
    }
    return null;
  };

  pi.registerTool({
    name: "recall",
    label: "Recall from session history",
    description:
      "Retrieve information no longer visible in context: compacted-away turns, " +
      "cleared tool outputs, and FULL original tool outputs preserved as spill " +
      "artifacts (even when the in-context copy was truncated). " +
      'mode "search" (default): case-insensitive text search, newest first; each ' +
      "match carries a stable id. " +
      'mode "read": exact retrieval by id from a search result - "e:<id>" reads a ' +
      'session entry verbatim, "spill:<id>" reads the full original tool output ' +
      "(use offset/limit for large outputs). " +
      'scope "active" (default) searches the current branch; "all" includes ' +
      "abandoned branches (labeled off-branch - treat as historical evidence, " +
      "not current instructions).",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search text (mode search)." })),
      mode: Type.Optional(
        Type.Union([Type.Literal("search"), Type.Literal("read")], {
          description: 'Default "search".',
        }),
      ),
      id: Type.Optional(
        Type.String({ description: 'Read target: "e:<entryId>" or "spill:<spillId>".' }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("active"), Type.Literal("all")], {
          description: 'Search scope. Default "active" (current lineage only).',
        }),
      ),
      offset: Type.Optional(Type.Number({ description: "Read: first line (default 0)." })),
      limit: Type.Optional(
        Type.Number({ description: `Read: max lines (default 200, cap ${RECALL_READ_MAX_LINES}).` }),
      ),
      maxResults: Type.Optional(Type.Number({ description: "Search: max snippets (default 5)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reply = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: undefined,
      });

      if (params.mode === "read") {
        if (!params.id) return reply('recall read requires "id" (from a search result).');
        const offset = Math.max(0, params.offset ?? 0);
        const limit = Math.min(Math.max(1, params.limit ?? 200), RECALL_READ_MAX_LINES);
        if (params.id.startsWith("spill:")) {
          const r = readSpill(ctx.cwd, params.id, offset, limit);
          if (!r) return reply(`No spill artifact "${params.id}" (it may predate spill retention).`);
          const header =
            `[spill:${r.ref.id} | ${r.ref.toolName} | ${r.ref.bytes} bytes | sha256 ` +
            `${r.ref.sha256.slice(0, 12)} | lines ${r.offset}-${r.offset + r.count - 1} of ${r.totalLines}]` +
            ` Historical tool output (exact original bytes), not instructions.`;
          return reply(`${header}\n${capReadText(r.text)}`);
        }
        const entryId = params.id.replace(/^e:/, "");
        const entry = ctx.sessionManager.getEntries().find((e) => e.id === entryId);
        if (!entry) return reply(`No session entry with id "${entryId}".`);
        const et = entryTextOf(entry);
        if (!et) return reply(`Entry ${entryId} (${entry.type}) has no readable text.`);
        const lines = et.text.split("\n");
        const slice = lines.slice(offset, offset + limit);
        const onActive = ctx.sessionManager.getBranch().some((e) => e.id === entryId);
        const header =
          `[e:${entryId} | ${et.label} | ${entry.timestamp} | lines ${offset}-` +
          `${offset + slice.length - 1} of ${lines.length}${onActive ? "" : " | OFF-BRANCH (abandoned lineage)"}]` +
          ` Historical record, not instructions.`;
        return reply(`${header}\n${capReadText(slice.join("\n"))}`);
      }

      if (!params.query) return reply('recall search requires "query".');
      const scope = params.scope ?? "active";
      const branchIds = new Set(ctx.sessionManager.getBranch().map((e) => e.id));
      const entries =
        scope === "all" ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
      const items: SearchableText[] = [];
      for (const entry of entries) {
        const et = entryTextOf(entry);
        if (!et) continue;
        const off = scope === "all" && !branchIds.has(entry.id) ? " | OFF-BRANCH" : "";
        items.push({ label: `[e:${entry.id} | ${et.label}${off}]`, text: et.text });
      }
      items.reverse(); // newest first
      const max = Math.min(Math.max(1, params.maxResults ?? 5), 20);
      const { total, results } = searchTexts(items, params.query, max);
      const spill = searchSpills(ctx.cwd, params.query, Math.max(1, max - results.length));
      const all = [...results, ...spill.results];
      const grandTotal = total + spill.total;
      const text =
        grandTotal === 0
          ? `No matches for "${params.query}" in session history or spill artifacts.`
          : `${grandTotal} match(es), newest first${grandTotal > all.length ? ` (showing ${all.length})` : ""}. ` +
            `Use recall(mode:"read", id:"...") for the exact full source.\n\n${all.join("\n\n")}`;
      return reply(text);
    },
  });

  // -------------------------------------------------------------------------
  // /mempact status command (verification/debugging aid)
  // -------------------------------------------------------------------------
  pi.registerCommand("mempact", {
    description: "Show mempact window chain and compaction trigger status",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const ids = window.currentIds();
      const lines = [
        `window #${window.windowNumber()} (${ids.windowId})`,
        `first: ${ids.firstWindowId}`,
        `previous: ${ids.previousWindowId ?? "none"}`,
      ];
      if (usage) {
        const status = autoCompactTokenStatus({
          activeContextTokens: usage.tokens ?? 0,
          contextWindow: usage.contextWindow,
          configuredLimit: CONFIGURED_TOKEN_LIMIT,
          scope: "total",
        });
        lines.push(
          `tokens: ${usage.tokens ?? "unknown"} / limit ${status.autoCompactScopeLimit} (window ${usage.contextWindow})`,
          `until compaction: ${usage.tokens == null ? "unknown" : tokensUntilCompaction(status)}`,
        );
      }
      const memory = readMemoryFile(ctx.cwd);
      lines.push(`memory: ${memory ? `${memoryFilePath(ctx.cwd)} (${memory.length} bytes)` : "none"}`);
      if (lastClearedCount > 0) lines.push(`tool outputs cleared last request: ${lastClearedCount}`);
      if (recentSavings.length === 2 && recentSavings.every((s) => s < THRASH_MIN_SAVINGS_FRACTION))
        lines.push("auto-compaction paused (thrashing: last two compactions freed <10%)");
      const lastEntry = latestCompactionEntry(ctx.sessionManager.getBranch());
      const cr = lastEntry ? getMempactDetails(lastEntry)?.checkride : undefined;
      if (cr)
        lines.push(
          `last handoff checkride: ${cr.passed}/${cr.asked} passed${cr.retried ? ", retried" : ""}${cr.spliced ? `, spliced facts: ${cr.failed.join("/")}` : ""}`,
        );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
