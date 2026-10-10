/**
 * mempact pi extension - runs core/pipeline.ts compaction inside the pi
 * coding agent, on top of codex's trigger and record-time rules
 * (openai/codex @ rust-v0.142.5).
 *
 * Takeover points (see project README and reference/PIN.md):
 * - session_before_compact: replaces ALL pi compaction (auto, /compact,
 *   ctx.compact()) with compactWindow: a code-built ledger, a structured
 *   narrative from the model, <=20k tokens of real user messages, and a
 *   raw tail of recent turns kept verbatim (pi keeps those entries via
 *   firstKeptEntryId).
 * - context: renders retained user messages, then the summary, then the
 *   raw tail, then the once-per-window rehydrated files (pi renders the
 *   compaction summary first; codex trains the model to see it last), with
 *   project memory as the first message.
 * - turn_end: codex trigger - fires at min(configured, contextWindow*9/10),
 *   plus the one-shot token-budget reminder per window.
 * - tool_result: codex record-time cap - outputs over 12,000 bytes (10KB
 *   policy x1.2 slack) are middle-truncated to 12,000 before they persist,
 *   after the full text is saved as an artifact recall can page through.
 * - new_context tool: codex's model-invokable hard reset (no summary).
 *
 * Install: `pi install git:github.com/topmass/mempact`, then set
 * "compaction": { "enabled": false } in ~/.pi/agent/settings.json. That also
 * turns off pi's own overflow recovery, so mempact's turn_end handler is the
 * only recovery left.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { complete, isContextOverflow } from "@earendil-works/pi-ai";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type {
  CompactionEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { summaryBridgeText } from "../core/compact.ts";
import { contentText } from "../core/items.ts";
import { type CompactWindowResult, OverflowError, STALE_INTENT_NOTE, compactWindow } from "../core/pipeline.ts";
import { markTruncatedSummary } from "../core/summarySchema.ts";
import { AutoCompactWindow } from "../core/autoCompactWindow.ts";
import {
  autoCompactTokenLimit,
  autoCompactTokenStatus,
  tokensUntilCompaction,
} from "../core/trigger.ts";
import {
  MEMORY_SECTIONS,
  appendToSection,
  emptyMemory,
  renderForContext,
  setSection,
} from "../core/memory.ts";
import { KEEP_RECENT_TOOL_RESULTS, clearOldToolOutputs } from "../core/toolClearing.ts";
import { type SearchableText, artifactNote, grepLines, searchTexts, sliceLines } from "../core/recall.ts";
import { maybeTokenBudgetReminder } from "../core/tokenBudget.ts";
import {
  DEFAULT_TRUNCATION_POLICY,
  SERIALIZATION_BUDGET_MULTIPLIER,
  byteBudget,
  mulPolicy,
} from "../core/outputTruncation.ts";
import { approxTokenCount, truncateMiddleChars } from "../core/truncate.ts";

// ---------------------------------------------------------------------------
// Configuration (module constants; edit here or fork per-project)
// ---------------------------------------------------------------------------

/** Optional hard token limit; null -> pure codex 90%-of-window rule. */
const CONFIGURED_TOKEN_LIMIT: number | null = null;
/** Reminder fires when tokens-until-compaction drops to this. */
const REMINDER_THRESHOLD_TOKENS = 10_000;
/**
 * codex resumes the interrupted turn after mid-turn compaction; pi's
 * ctx.compact() aborts the running loop and would leave the agent idle until
 * the user types "continue". When true, a hidden continuation prompt (oh-my-pi
 * auto-continue lineage) resumes the task after an AUTO compaction that
 * interrupted a tool loop or recovered an overflow; a finished answer that
 * crossed 90% and manual /compact never auto-continue. Interactive and RPC
 * modes only: print mode (-p) ends its one-shot run when the loop aborts.
 */
const CONTINUE_AFTER_AUTO_COMPACT = true;
const CONTINUE_PROMPT =
  "Context was compacted mid-task. Resume the user's latest intent: re-read the retained " +
  "user messages and the handoff summary above to confirm the latest request, then continue " +
  "from the exact next step. If no work remains, say so briefly; do not invent work.";
/**
 * Mechanical tool-output clearing (Anthropic context-editing lineage): once
 * context crosses this fraction of the auto-compact limit (~63% of the
 * window at the default 90% limit), tool outputs older than the newest
 * KEEP_RECENT_TOOL_RESULTS are stubbed per-request. Non-destructive - the
 * session file keeps the originals. null disables the tier.
 * The tier is decided from a token estimate of the UNSTUBBED messages, not
 * from pi's reported usage: usage comes from the last request, which was
 * already stubbed, so a usage threshold flips on and off every other turn
 * and thrashes the prompt cache.
 */
const CLEAR_TOOL_OUTPUTS_AT_FRACTION: number | null = 0.7;
/**
 * Anti-thrashing (Hermes lineage): if the last two auto-compactions each
 * freed less than this fraction, pause the auto trigger (manual /compact and
 * overflow recovery stay live) instead of looping.
 */
const THRASH_MIN_SAVINGS_FRACTION = 0.1;
/** Claude Code lineage: after compaction, re-read the files the agent was
 *  editing so it does not work from stale reads. Larger files are listed. */
const REHYDRATE_FILE_MAX_TOKENS = 5_000;

/** Whether the clearing tier applies to these unstubbed messages (see the constant). */
const clearingDue = (messages: AgentMessage[], contextWindow: number | undefined): boolean => {
  if (CLEAR_TOOL_OUTPUTS_AT_FRACTION == null) return false;
  const limit = autoCompactTokenLimit(contextWindow ?? null, CONFIGURED_TOKEN_LIMIT);
  if (limit == null) return false;
  const estimate = messages.reduce((n, m) => n + estimateTokens(m), 0);
  return estimate >= limit * CLEAR_TOOL_OUTPUTS_AT_FRACTION;
};

const REMINDER_CUSTOM_TYPE = "mempact:token-budget-reminder";
/** Sentinel that matches no session entry -> pi keeps zero entries. */
const FIRST_KEPT_SENTINEL = "mempact:none";

// codex core/src/tools/handlers/new_context_window.rs:13
const NEW_CONTEXT_WINDOW_MESSAGE =
  "A new context window will start without summarizing conversation history.";

interface MempactDetails {
  mempact: {
    /** 1: Phase 0 entries (summary + staples in entry.summary, no raw tail) */
    version: 1 | 2;
    /** codex replacement history: retained real user messages, oldest-first. */
    retainedUserMessages: string[];
    window: { windowNumber: number };
    newContext?: boolean;
    /** the summary message as rendered: bridge, narrative, ledger, guard */
    summaryText?: string;
    /** what the next compaction gives the summarizer, never the ledger */
    narrative?: string;
    /** messages pi renders from firstKeptEntryId up to this entry (the raw tail) */
    tailMessages?: number;
    rehydratePaths?: string[];
    /** file contents read once at compaction, rendered after the raw tail */
    rehydrated?: string;
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
 * Artifacts: a tool output over the record-time cap is saved whole before it
 * is truncated, named by content hash so a repeated output reuses its file.
 */
const artifactPath = (cwd: string, id: string): string => join(cwd, ".mempact", "artifacts", `${id}.txt`);
const saveArtifact = (cwd: string, text: string): string => {
  const id = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const path = artifactPath(cwd, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return id;
};
const readArtifact = (cwd: string, id: string): string | null => {
  // the id comes from the model; anything but 12 hex chars could walk the filesystem
  if (!/^[0-9a-f]{12}$/.test(id)) return null;
  try {
    return readFileSync(artifactPath(cwd, id), "utf8");
  } catch {
    return null;
  }
};

/**
 * Read the most recently modified files once, at compaction time. Stored in
 * the compaction entry, so every request in the window renders the same
 * bytes (prompt-cache stable) instead of re-reading disk each turn. Files of
 * 5k tokens or more, files past a tenth of the window, and missing files are
 * listed by path only.
 */
const rehydrateFiles = (cwd: string, paths: string[], contextWindow: number): string | undefined => {
  if (paths.length === 0) return undefined;
  let budget = Math.floor(contextWindow / 10);
  const files: string[] = [];
  const listed: string[] = [];
  for (const path of paths) {
    let text: string | null = null;
    try {
      text = readFileSync(resolve(cwd, path), "utf8");
    } catch {
      // deleted or moved since the edit
    }
    const tokens = text == null ? Infinity : approxTokenCount(text);
    if (text != null && tokens < REHYDRATE_FILE_MAX_TOKENS && tokens <= budget) {
      budget -= tokens;
      files.push(`<file path="${path}">\n${text.replace(/\n$/, "")}\n</file>`);
    } else listed.push(text == null ? `${path} (not found on disk)` : path);
  }
  return [
    "[mempact] Rehydrated file content: the files modified most recently, read from disk when the context was compacted, after every edit shown above.",
    ...files,
    ...(listed.length > 0 ? [`Also modified recently, not included (read them if needed): ${listed.join(", ")}`] : []),
  ].join("\n\n");
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

  // -------------------------------------------------------------------------
  // session_start: restore window number + reminder one-shot from the JSONL
  // -------------------------------------------------------------------------
  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch();
    const lastCompaction = latestCompactionEntry(entries);
    const mempact = lastCompaction ? getMempactDetails(lastCompaction) : null;
    if (mempact) window.restore(mempact.window.windowNumber);

    // Reminder already delivered in the current window? (survives restarts)
    const lastCompactionIdx = lastCompaction ? entries.indexOf(lastCompaction) : -1;
    const reminderDelivered = entries
      .slice(lastCompactionIdx + 1)
      .some((e) => e.type === "custom_message" && e.customType === REMINDER_CUSTOM_TYPE);
    if (reminderDelivered) window.markTokenBudgetReminderDelivered();
  });

  // -------------------------------------------------------------------------
  // session_before_compact: the compaction takeover
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
      const windowNumber = window.advance();
      return {
        compaction: {
          summary: "Context window cleared via new_context.",
          firstKeptEntryId: FIRST_KEPT_SENTINEL,
          tokensBefore: preparation.tokensBefore,
          details: {
            mempact: {
              version: 2,
              retainedUserMessages: [],
              window: { windowNumber },
              newContext: true,
            },
          } satisfies MempactDetails,
        },
      };
    }

    const model = ctx.model;
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      if (ctx.hasUI) ctx.ui.notify("mempact: no model auth, falling back to pi compaction", "warning");
      return undefined;
    }
    const { apiKey, headers } = auth;

    // The full session as pi-ai messages, every window, with the branch
    // index each came from. Compaction entries are not messages, so the
    // ledger is built from source records and never from a summary. Custom
    // messages (mempact's own reminder and continue notes) stay out too:
    // they are not the user's words.
    const messages: Message[] = [];
    const entryIndex: number[] = [];
    branchEntries.forEach((entry, i) => {
      if (entry.type !== "message") return;
      for (const m of convertToLlm([entry.message])) {
        messages.push(m);
        entryIndex.push(i);
      }
    });

    // The previous window began at its raw tail (the entries pi kept from
    // firstKeptEntryId) or right after its compaction entry when it had none.
    const lastCompaction = latestCompactionEntry(branchEntries);
    let previous: { narrative: string; start: number } | undefined;
    if (lastCompaction) {
      const compactionIdx = branchEntries.indexOf(lastCompaction);
      const keptIdx = branchEntries.findIndex((e) => e.id === lastCompaction.firstKeptEntryId);
      const startEntry = keptIdx !== -1 && keptIdx < compactionIdx ? keptIdx : compactionIdx + 1;
      const start = entryIndex.findIndex((i) => i >= startEntry);
      const prev = getMempactDetails(lastCompaction);
      previous = {
        narrative: prev?.newContext ? "" : (prev?.narrative ?? lastCompaction.summary),
        start: start === -1 ? messages.length : start,
      };
    }

    let result: CompactWindowResult;
    try {
      result = await compactWindow(
        {
          messages,
          previous,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxTokens,
          systemPrompt: ctx.getSystemPrompt(),
          instructions: event.customInstructions,
        },
        {
          estimateTokens,
          summarize: async (systemPrompt, msgs, maxTokens) => {
            for (let retries = 0; ; retries++) {
              try {
                const response = await complete(model, { systemPrompt, messages: msgs }, { apiKey, headers, maxTokens, signal });
                if (isContextOverflow(response, model.contextWindow)) throw new OverflowError();
                if (response.stopReason === "error") throw new Error(response.errorMessage ?? "summarization request failed");
                const text = contentText(response.content);
                return response.stopReason === "length" ? markTruncatedSummary(text) : text;
              } catch (error) {
                // overflow is the pipeline's to handle (it trims the front)
                if (error instanceof OverflowError || signal.aborted || retries >= 3) throw error;
                await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** (retries + 1), 5_000)));
              }
            }
          },
        },
      );
    } catch (error) {
      if (signal.aborted) return undefined;
      if (ctx.hasUI) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`mempact compaction failed (${msg}); falling back to pi compaction`, "error");
      }
      return undefined;
    }

    // pi keeps the raw tail itself: every entry from firstKeptEntryId up to
    // the compaction entry renders after the summary message.
    const tailStart = messages.length - result.rawTail.length;
    const tailEntry = tailStart < messages.length ? entryIndex[tailStart]! : branchEntries.length;
    const tailMessages = branchEntries
      .slice(tailEntry)
      .filter((e) => e.type === "message" || e.type === "custom_message" || (e.type === "branch_summary" && e.summary)).length;

    const windowNumber = window.advance();
    return {
      compaction: {
        summary: result.summaryText,
        firstKeptEntryId: branchEntries[tailEntry]?.id ?? FIRST_KEPT_SENTINEL,
        tokensBefore: preparation.tokensBefore,
        details: {
          mempact: {
            version: 2,
            retainedUserMessages: result.retainedUserMessages,
            window: { windowNumber },
            summaryText: result.summaryText,
            narrative: result.narrative,
            tailMessages,
            rehydratePaths: result.rehydratePaths,
            rehydrated: rehydrateFiles(ctx.cwd, result.rehydratePaths, model.contextWindow),
          },
        } satisfies MempactDetails,
      },
    };
  });

  // -------------------------------------------------------------------------
  // session_compact: bookkeeping after ANY compaction (ours or foreign)
  // -------------------------------------------------------------------------
  pi.on("session_compact", (event) => {
    compacting = false;
    pendingTokensBefore = event.compactionEntry.tokensBefore ?? null;
    thrashNotified = false;
    // Foreign compaction (pi fallback or another extension): still advance
    // the window number so numbering matches codex semantics.
    if (!getMempactDetails(event.compactionEntry)) window.advance();
  });

  // -------------------------------------------------------------------------
  // context: enforce codex's exact post-compaction request layout, then the
  // mechanical clearing tier, then the project-memory injection
  // -------------------------------------------------------------------------
  pi.on("context", (event, ctx) => {
    let messages = event.messages;

    // 1) layout: retained user messages, the summary message, the raw tail
    // (pi already renders it right after the summary), then the rehydrated
    // files, which were read after every edit in the tail
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
              userMsg(mempact.summaryText ?? `${summaryBridgeText(entry!.summary)}\n\n${STALE_INTENT_NOTE}`, ts),
            ];
        const tailEnd = idx + 1 + (mempact.tailMessages ?? 0);
        messages = [
          ...messages.slice(0, idx),
          ...replacement,
          ...messages.slice(idx + 1, tailEnd),
          ...(mempact.rehydrated ? [userMsg(mempact.rehydrated, ts)] : []),
          ...messages.slice(tailEnd),
        ];
      }
    }

    // 2) clearing tier: stub old tool outputs once the unstubbed messages
    // pass the threshold (see the constant). Stubs are byte-stable across
    // requests.
    if (clearingDue(messages, ctx.model?.contextWindow)) {
      const result = clearOldToolOutputs(messages, KEEP_RECENT_TOOL_RESULTS);
      if (result.cleared > 0) {
        messages = result.messages;
        lastClearedCount = result.cleared;
      }
    }

    // 3) project memory: the first message, so the prompt-cache prefix stays
    // stable across turns until the file itself changes. Read fresh from
    // disk so mid-session edits and compaction cannot stale or drop it.
    const memory = readMemoryFile(ctx.cwd);
    if (memory) messages = [userMsg(renderForContext(memory), 0), ...messages];

    return messages === event.messages ? undefined : { messages };
  });

  // -------------------------------------------------------------------------
  // turn_end: codex trigger (90% rule) + token-budget reminder + deferred
  // new_context compact
  // -------------------------------------------------------------------------
  pi.on("turn_end", (event, ctx) => {
    // `resume`: the compaction interrupted work (a tool loop was still running,
    // or the request overflowed) - only then is the continuation prompt sent.
    // A finished answer that merely crossed 90% must not spawn unasked work.
    const triggerCompaction = (resume: boolean) => {
      if (compacting) return;
      compacting = true;
      // The callbacks run async; the extension ctx may be stale by then
      // (session replaced, /reload, or -p mode exiting), so guard all use.
      ctx.compact({
        onComplete: () => {
          compacting = false;
          if (CONTINUE_AFTER_AUTO_COMPACT && resume) {
            try {
              // a user prompt that arrived during compaction owns the next turn
              if (!ctx.isIdle()) return;
              pi.sendMessage(
                { customType: "mempact:continue", content: CONTINUE_PROMPT, display: false },
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

    // The turn ran tools, so the loop was going to continue: resume after.
    const midTask = event.toolResults.length > 0;

    if (newContextRequested) {
      newContextRequested = false;
      window.requestNewContextWindow();
      // never auto-continue: the turn's own new_context result would count as
      // mid-task, and the continue prompt points at a summary the reset deleted
      triggerCompaction(false);
      return;
    }

    // Replaces pi's built-in overflow recovery (disabled via settings).
    if (event.message.role === "assistant" && isContextOverflow(event.message, ctx.model?.contextWindow)) {
      triggerCompaction(true);
      return;
    }

    const usage = ctx.getContextUsage();
    if (usage?.tokens == null) return;

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
      triggerCompaction(midTask);
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
  // history.rs:362 process_item truncates to policy*1.2, not to the policy
  // -------------------------------------------------------------------------
  pi.on("tool_result", (event, ctx) => {
    const capBytes = byteBudget(mulPolicy(DEFAULT_TRUNCATION_POLICY, SERIALIZATION_BUDGET_MULTIPLIER));
    let changed = false;
    const content = event.content.map((c) => {
      if (c.type !== "text") return c;
      const bytes = Buffer.byteLength(c.text);
      if (bytes <= capBytes) return c;
      changed = true;
      const cut = truncateMiddleChars(c.text, capBytes);
      let id: string;
      try {
        id = saveArtifact(ctx.cwd, c.text);
      } catch {
        return { ...c, text: cut }; // unwritable cwd: plain codex truncation
      }
      return { ...c, text: cut.replace(/…\d+ chars truncated…/, (marker) => `${marker}\n${artifactNote(id, bytes)}\n`) };
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
  // get_context_remaining tool - codex main ships this beside new_context so
  // the model can plan around the budget instead of guessing (SelfCompact,
  // arXiv 2606.23525: unprompted models do not notice degraded context).
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "get_context_remaining",
    label: "Context remaining",
    description:
      "Report how much context window remains before automatic compaction. Use it before " +
      "starting a large step to decide whether to persist state (update_memory) first.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage();
      if (!usage || usage.tokens == null)
        return { content: [{ type: "text", text: "Context usage unknown until the next model response." }], details: undefined };
      const status = autoCompactTokenStatus({
        activeContextTokens: usage.tokens,
        contextWindow: usage.contextWindow,
        configuredLimit: CONFIGURED_TOKEN_LIMIT,
      });
      const remaining = tokensUntilCompaction(status);
      const text = `${remaining} tokens remain before automatic compaction (${usage.tokens} of ${status.autoCompactScopeLimit} used, window ${usage.contextWindow}).`;
      return { content: [{ type: "text", text }], details: undefined };
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
      writeFileSync(path, next, "utf8");
      return {
        content: [{ type: "text", text: `Project memory updated (${params.section}).` }],
        details: undefined,
      };
    },
  });

  // -------------------------------------------------------------------------
  // recall tool - search the full append-only session history (including
  // compacted-away turns and cleared tool outputs; nothing is ever deleted)
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "recall",
    label: "Recall from session history",
    description:
      "Search the FULL session history - including conversation that was " +
      "compacted away and tool outputs that were cleared from context - for a " +
      "text query. Use it to retrieve details no longer visible: an old tool " +
      "output, an exact error message, an earlier decision or file content. " +
      "Returns matching snippets, newest first. With `artifact`, reads a saved full " +
      "tool output instead: pass `lines` for a range, or `query` to find line numbers.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Text to search for (case-insensitive)." })),
      maxResults: Type.Optional(Type.Number({ description: "Max snippets to return (default 5)." })),
      artifact: Type.Optional(Type.String({ description: "Artifact id named in a truncated or cleared tool output." })),
      lines: Type.Optional(Type.String({ description: 'Line range in the artifact, e.g. "120-180" (default 1-200).' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.artifact) {
        const full = readArtifact(ctx.cwd, params.artifact);
        const text =
          full == null
            ? `No artifact "${params.artifact}".`
            : params.query && !params.lines
              ? grepLines(full, params.query)
              : sliceLines(full, params.lines);
        return { content: [{ type: "text", text }], details: undefined };
      }
      if (!params.query) {
        return { content: [{ type: "text", text: "Give a query, or an artifact id with a line range." }], details: undefined };
      }
      const query = params.query;
      const entries = ctx.sessionManager.getBranch();
      const items: SearchableText[] = [];
      entries.forEach((entry, i) => {
        if (entry.type === "message") {
          const text = contentText((entry.message as { content?: unknown }).content);
          if (text) items.push({ label: `[entry ${i} ${entry.message.role}]`, text });
        } else if (entry.type === "custom_message") {
          const text = contentText(entry.content);
          if (text) items.push({ label: `[entry ${i} note]`, text });
        } else if (entry.type === "compaction") {
          items.push({ label: `[entry ${i} compaction-summary]`, text: entry.summary });
        }
      });
      items.reverse(); // newest first
      const max = Math.min(Math.max(1, params.maxResults ?? 5), 20);
      const { total, results } = searchTexts(items, query, max);
      const text =
        total === 0
          ? `No matches for "${query}" in session history.`
          : `${total} match(es), newest first${total > results.length ? ` (showing ${results.length})` : ""}:\n\n${results.join("\n\n")}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // -------------------------------------------------------------------------
  // /mempact status command (verification/debugging aid)
  // -------------------------------------------------------------------------
  pi.registerCommand("mempact", {
    description: "Show mempact window number and compaction trigger status",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      const lines = [`window #${window.windowNumber()}`];
      if (usage) {
        const status = autoCompactTokenStatus({
          activeContextTokens: usage.tokens ?? 0,
          contextWindow: usage.contextWindow,
          configuredLimit: CONFIGURED_TOKEN_LIMIT,
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
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
