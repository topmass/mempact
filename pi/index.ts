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

import { complete } from "@earendil-works/pi-ai";
import type { Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
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
import { autoCompactTokenStatus, tokensUntilCompaction } from "../core/trigger.ts";
import { maybeTokenBudgetReminder } from "../core/tokenBudget.ts";
import {
  DEFAULT_TRUNCATION_POLICY,
  SERIALIZATION_BUDGET_MULTIPLIER,
  byteBudget,
  mulPolicy,
} from "../core/outputTruncation.ts";
import { truncateMiddleChars } from "../core/truncate.ts";

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

/** Heuristic overflow classifier (pi does not export its internal one). */
export const isContextOverflowError = (error: unknown): boolean => {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /context.{0,20}(window|length|limit)|too (long|large|many tokens)|maximum (context|.{0,20}tokens)|prompt is too long|exceeds? the (context|token)/.test(
      msg,
    )
  );
};

export default function (pi: ExtensionAPI) {
  const window = new AutoCompactWindow();
  let compacting = false;
  let newContextRequested = false;
  let warnedAboutBuiltinTrigger = false;

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
          summary: "Context window cleared via new_context.",
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
        if (!prev.newContext) effective.push(userMsg(summaryBridgeText(lastCompaction.summary), ts));
      } else if (lastCompaction.summary) {
        effective.push(userMsg(summaryBridgeText(lastCompaction.summary), ts));
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
          const response = await complete(
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
          },
        } satisfies MempactDetails,
      },
    };
  });

  // -------------------------------------------------------------------------
  // session_compact: bookkeeping after ANY compaction (ours or foreign)
  // -------------------------------------------------------------------------
  pi.on("session_compact", (event, ctx) => {
    compacting = false;
    // Foreign compaction (pi fallback or another extension): still advance
    // the window chain so numbering matches codex semantics.
    if (!getMempactDetails(event.compactionEntry)) window.advance();
    if (CONTINUE_AFTER_AUTO_COMPACT && !ctx.isIdle()) return;
  });

  // -------------------------------------------------------------------------
  // context: enforce codex's exact post-compaction request layout
  // -------------------------------------------------------------------------
  pi.on("context", (event, ctx) => {
    const idx = event.messages.findIndex((m) => m.role === "compactionSummary");
    if (idx === -1) return undefined;

    const entry = latestCompactionEntry(ctx.sessionManager.getBranch());
    const mempact = entry ? getMempactDetails(entry) : null;
    if (!mempact) return undefined; // foreign compaction: keep pi's rendering

    const summaryMsg = event.messages[idx]! as { timestamp?: number };
    const ts = summaryMsg.timestamp ?? Date.now();
    const replacement: AgentMessage[] = mempact.newContext
      ? []
      : [
          ...mempact.retainedUserMessages.map((text) => userMsg(text, ts)),
          // codex compact.rs:301: SUMMARY_PREFIX bridge as a user message, LAST
          userMsg(summaryBridgeText(entry!.summary), ts),
        ];
    const messages = [...event.messages];
    messages.splice(idx, 1, ...replacement);
    return { messages };
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
    const message = event.message as { stopReason?: string; errorMessage?: string };
    if (message.stopReason === "error" && isContextOverflowError(message.errorMessage ?? "")) {
      triggerCompaction();
      return;
    }

    const usage = ctx.getContextUsage();
    if (usage?.tokens == null) return;

    const status = autoCompactTokenStatus({
      activeContextTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      configuredLimit: CONFIGURED_TOKEN_LIMIT,
      scope: "total",
    });
    if (status.tokenLimitReached) {
      triggerCompaction();
      return;
    }

    const reminder = maybeTokenBudgetReminder({
      tokensUntilCompaction: tokensUntilCompaction(status),
      reminderThresholdTokens: REMINDER_THRESHOLD_TOKENS,
      claimReminder: () => window.claimTokenBudgetReminder(),
    });
    if (reminder) {
      pi.sendMessage(
        { customType: REMINDER_CUSTOM_TYPE, content: reminder, display: true },
        { triggerTurn: false },
      );
    }
  });

  // -------------------------------------------------------------------------
  // tool_result: codex record-time ingestion cap (10KB x1.2, middle-ellipsis)
  // history.rs:362 process_item / truncate_function_output_payload
  // -------------------------------------------------------------------------
  pi.on("tool_result", (event) => {
    const policy = mulPolicy(DEFAULT_TRUNCATION_POLICY, SERIALIZATION_BUDGET_MULTIPLIER);
    const capBytes = byteBudget(policy);
    const encoder = new TextEncoder();
    let changed = false;
    const content = event.content.map((c) => {
      if (c.type !== "text" || encoder.encode(c.text).length <= capBytes) return c;
      changed = true;
      return { ...c, text: truncateMiddleChars(c.text, byteBudget(DEFAULT_TRUNCATION_POLICY)) };
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
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
