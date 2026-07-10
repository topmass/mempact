/**
 * Handoff checkride eval - measures compaction handoff quality on REAL
 * conversation data against a live model, as a three-mode ablation:
 *
 *   raw      summary alone (what a naive "summarize at threshold" ships)
 *   spliced  summary + mempact's mechanical file-op lists
 *   full     the real mempact assembly: retained user messages + summary
 *            + splices (exactly what the next window would see)
 *
 * Run:  node test/handoff-eval.ts <transcript.jsonl> [more transcripts...]
 *       Accepts Claude Code project transcripts AND codex rollout files
 *       (format auto-detected). Multiple paths -> batch table.
 * Env:  ENDPOINT (default http://127.0.0.1:8080/v1)  MODEL (llamacpp)
 *       TOKEN_BUDGET (70000)  MAX_SUMMARY_TOKENS (4096)
 *
 * Requires Node >= 23.6 (native type stripping). No dependencies.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { SUMMARIZATION_PROMPT, collectUserMessages, buildCompactedHistory, summaryBridgeText } from "../core/compact.ts";
import { messageText, type HistoryItem } from "../core/items.ts";
import { collectFileOps, renderFileOps } from "../core/fileOps.ts";
import {
  buildProbes,
  extractRunFacts,
  formatQuiz,
  gradeQuiz,
  mustPreserveSection,
  runFactsBlock,
  type Probe,
} from "../core/checkride.ts";
import { getSection, renderForContext } from "../core/memory.ts";

const ENDPOINT = process.env.ENDPOINT ?? "http://127.0.0.1:8080/v1";
const MODEL = process.env.MODEL ?? "llamacpp";
const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET ?? 70_000);
const MAX_SUMMARY_TOKENS = Number(process.env.MAX_SUMMARY_TOKENS ?? 4096);
const TOOL_RESULT_CAP = 10_000; // bytes, mirrors the engine's ingestion cap
/** Optional .mempact/memory.md to exercise the done/next/constraints probes
 *  (injected into the full assembly exactly as the pi extension does). */
const MEMORY_FILE = process.env.MEMORY_FILE;
/** CHAIN=1: two consecutive compactions; quiz window 3 on window-1 facts. */
const CHAIN = process.env.CHAIN === "1";

// ---------------------------------------------------------------------------
// Transcript parsers -> neutral messages
// ---------------------------------------------------------------------------

interface NeutralMessage {
  role: "user" | "assistant" | "toolResult";
  content: { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

const capText = (t: string): string =>
  t.length <= TOOL_RESULT_CAP ? t : `${t.slice(0, TOOL_RESULT_CAP / 2)}\n…[truncated]…\n${t.slice(-TOOL_RESULT_CAP / 2)}`;

const blockText = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
      : "";

function parseClaude(lines: string[]): NeutralMessage[] {
  const toolNames = new Map<string, string>();
  const out: NeutralMessage[] = [];
  for (const line of lines) {
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (entry.type === "assistant" && Array.isArray(content)) {
      const blocks: NeutralMessage["content"] = [];
      for (const b of content) {
        if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
        if (b.type === "tool_use") {
          toolNames.set(b.id, b.name);
          blocks.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.input ?? {} });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else if (entry.type === "user") {
      if (typeof content === "string") {
        if (content.trim()) out.push({ role: "user", content: [{ type: "text", text: content }] });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") {
            out.push({
              role: "toolResult",
              toolCallId: b.tool_use_id,
              toolName: toolNames.get(b.tool_use_id) ?? "tool",
              isError: b.is_error === true,
              content: [{ type: "text", text: capText(blockText(b.content)) }],
            });
          } else if (b.type === "text" && b.text?.trim()) {
            out.push({ role: "user", content: [{ type: "text", text: b.text }] });
          }
        }
      }
    }
  }
  return out;
}

/** Patch-format file extraction for codex apply_patch calls. */
const patchFiles = (patch: string): { name: string; path: string }[] =>
  [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => ({
    name: m[1] === "Add" ? "write" : "edit",
    path: m[2]!.trim(),
  }));

function parseCodex(lines: string[]): NeutralMessage[] {
  const toolNames = new Map<string, string>();
  const out: NeutralMessage[] = [];
  for (const line of lines) {
    let entry: { type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "response_item" || !entry.payload) continue;
    const p = entry.payload as {
      type: string;
      role?: string;
      content?: unknown;
      name?: string;
      arguments?: string;
      input?: string;
      call_id?: string;
      output?: unknown;
    };
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = Array.isArray(p.content)
        ? (p.content as { type: string; text?: string }[])
            .filter((c) => typeof c.text === "string")
            .map((c) => c.text)
            .join("\n")
        : "";
      if (text.trim()) out.push({ role: p.role, content: [{ type: "text", text }] });
    } else if (p.type === "function_call" && p.call_id) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(p.arguments ?? "{}");
      } catch {}
      toolNames.set(p.call_id, p.name ?? "tool");
      out.push({
        role: "assistant",
        content: [{ type: "toolCall", id: p.call_id, name: p.name ?? "tool", arguments: args }],
      });
    } else if (p.type === "custom_tool_call" && p.call_id) {
      toolNames.set(p.call_id, p.name ?? "tool");
      const blocks: NeutralMessage["content"] =
        p.name === "apply_patch"
          ? patchFiles(p.input ?? "").map((f, i) => ({
              type: "toolCall",
              id: `${p.call_id}-${i}`,
              name: f.name,
              arguments: { path: f.path },
            }))
          : [{ type: "toolCall", id: p.call_id, name: p.name ?? "tool", arguments: {} }];
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && p.call_id) {
      let text = typeof p.output === "string" ? p.output : blockText(p.output) || JSON.stringify(p.output ?? "");
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.output === "string") text = parsed.output;
      } catch {}
      out.push({
        role: "toolResult",
        toolCallId: p.call_id,
        toolName: toolNames.get(p.call_id) ?? "tool",
        isError: false,
        content: [{ type: "text", text: capText(text) }],
      });
    }
  }
  return out;
}

function parseTranscript(path: string): NeutralMessage[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const first = lines.find((l) => l.includes('"type"')) ?? "";
  const isCodex = first.includes('"payload"') || /"type":\s*"(session_meta|response_item|turn_context)"/.test(first);
  return isCodex ? parseCodex(lines) : parseClaude(lines);
}

const textOf = (m: NeutralMessage): string => m.content.filter((b) => b.text).map((b) => b.text).join("\n");
const tokens = (s: string): number => Math.ceil(s.length / 4);

/** Newest slice under the token budget, no leading orphan tool results. */
function sliceNewest(messages: NeutralMessage[], budget: number): NeutralMessage[] {
  const slice: NeutralMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = tokens(JSON.stringify(messages[i]));
    if (used + cost > budget) break;
    used += cost;
    slice.unshift(messages[i]!);
  }
  while (slice.length > 0 && slice[0]!.role === "toolResult") slice.shift();
  return slice;
}

const isRealUserMessage = (m: NeutralMessage): boolean =>
  m.role === "user" &&
  !/<command-name>|<local-command|<system-reminder>|<task-notification>|<environment_context>|<user_instructions>|<permissions instructions>|<turn_aborted>/.test(
    textOf(m),
  );

// ---------------------------------------------------------------------------
// Model calls (plain OpenAI-compatible HTTP, temperature 0)
// ---------------------------------------------------------------------------

async function chat(messages: { role: string; content: string }[], maxTokens: number): Promise<string> {
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, seed: 42, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  console.log(`    (model call: ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return body.choices[0]?.message.content ?? "";
}

/** Role-preserving flatten for the summarization request. */
const toChat = (messages: NeutralMessage[]): { role: string; content: string }[] =>
  messages.map((m) => {
    if (m.role === "toolResult") return { role: "user", content: `[tool result: ${m.toolName}]\n${textOf(m)}` };
    if (m.role === "assistant") {
      const calls = m.content
        .filter((b) => b.type === "toolCall")
        .map((b) => `[called ${b.name}: ${JSON.stringify(b.arguments).slice(0, 300)}]`)
        .join("\n");
      return { role: "assistant", content: [textOf(m), calls].filter(Boolean).join("\n") };
    }
    return { role: "user", content: textOf(m) };
  });

// ---------------------------------------------------------------------------
// One transcript -> one result row
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  sliceTokens: number;
  handoffTokens: number;
  probeIds: string[];
  scores: Record<string, { score: number; failed: string[] }>;
  retryScore?: number;
}

async function quizContext(contextTexts: string[], probes: Probe[]) {
  const messages = [
    ...contextTexts.map((t) => ({ role: "user", content: t })),
    { role: "user", content: formatQuiz(probes) },
  ];
  const answer = await chat(messages, 900);
  return { ...gradeQuiz(probes, answer), answer };
}

async function runOne(path: string, verbose: boolean): Promise<Row | null> {
  const all = parseTranscript(path);
  const slice = sliceNewest(all, TOKEN_BUDGET);
  const sliceTokens = slice.reduce((n, m) => n + tokens(JSON.stringify(m)), 0);
  console.log(`\n### ${basename(path)}: ${all.length} messages | slice ${slice.length} msgs ~${sliceTokens} tokens`);

  const fileOps = collectFileOps(slice);
  const run = extractRunFacts(slice);
  const lastUser = [...slice].reverse().find(isRealUserMessage);
  const memoryMd = MEMORY_FILE ? readFileSync(MEMORY_FILE, "utf8") : undefined;
  const probes = buildProbes({
    modifiedFiles: fileOps.modifiedFiles,
    lastRun: run.lastRun,
    lastError: run.lastError,
    lastUserMessage: lastUser ? textOf(lastUser) : undefined,
    memoryNext: memoryMd ? getSection(memoryMd, "Next") : undefined,
    memoryDoneItems: memoryMd
      ? getSection(memoryMd, "Plan").split("\n").filter((l) => /\[x\]/i.test(l))
      : undefined,
    memoryDecisions: memoryMd
      ? getSection(memoryMd, "Decisions").split("\n").filter((l) => l.trim())
      : undefined,
  });
  if (probes.length === 0) {
    console.log("no probes derivable (no tool activity found) - skipping");
    return null;
  }
  console.log(`probes: ${probes.map((p) => p.id).join(", ")}`);
  if (verbose) console.log(`facts: ${probes.map((p) => `\n  - ${p.preserveLine.slice(0, 140)}`).join("")}`);

  const summary = await chat([...toChat(slice), { role: "user", content: SUMMARIZATION_PROMPT }], MAX_SUMMARY_TOKENS);
  const spliceBlock = [
    renderFileOps(fileOps),
    runFactsBlock({ ...run, lastUserMessage: lastUser ? textOf(lastUser) : undefined }),
  ]
    .filter(Boolean)
    .join("\n");
  const splicedSummary = spliceBlock ? `${summary}\n\n${spliceBlock}` : summary;

  const userItems: HistoryItem[] = slice
    .filter(isRealUserMessage)
    .map((m) => ({ type: "message", role: "user", content: [{ type: "input_text", text: textOf(m) }] }));
  const retained = buildCompactedHistory([], collectUserMessages(userItems), summaryBridgeText(splicedSummary))
    .slice(0, -1)
    .map((item) => messageText(item) ?? "")
    .filter(Boolean);

  const fullContext = [
    ...retained,
    summaryBridgeText(splicedSummary),
    ...(memoryMd ? [renderForContext(memoryMd)] : []),
  ];
  const handoffTokens = tokens(fullContext.join("\n"));
  console.log(`summary ${tokens(summary)} tokens | retained user msgs ${tokens(retained.join("\n"))} tokens | full handoff ${handoffTokens} tokens (${((handoffTokens / sliceTokens) * 100).toFixed(1)}% of window content)`);

  const modes: [string, string[]][] = [
    ["raw", [summaryBridgeText(summary)]],
    ["spliced", [summaryBridgeText(splicedSummary)]],
    ["full", fullContext],
  ];
  const row: Row = { name: basename(path).slice(0, 28), sliceTokens, handoffTokens, probeIds: probes.map((p) => p.id), scores: {} };
  let fullResult: Awaited<ReturnType<typeof quizContext>> | undefined;
  for (const [name, ctx] of modes) {
    const r = await quizContext(ctx, probes);
    row.scores[name] = { score: r.score, failed: r.failed.map((p) => p.id) };
    if (name === "full") fullResult = r;
    console.log(`  ${name.padEnd(8)} ${(r.score * 100).toFixed(0).padStart(3)}%  failed: ${r.failed.map((p) => p.id).join(", ") || "none"}`);
    if (verbose) {
      console.log(`           answer ${r.answer.length} chars: ${JSON.stringify(r.answer.slice(0, 220))}`);
      for (const p of r.failed) {
        const haystack = r.answer.toLowerCase();
        const missing = p.groups.filter((g) => !g.some((s) => haystack.includes(s.toLowerCase()))).map((g) => g[0]!.slice(0, 60));
        console.log(`           ${p.id} missing: ${missing.join(" | ")}`);
      }
    }
  }

  if (fullResult && fullResult.failed.length > 0) {
    console.log("  full failed - MUST-PRESERVE retry:");
    const retryPrompt = `${SUMMARIZATION_PROMPT}\n\n${mustPreserveSection(fullResult.failed)}`;
    const retrySummary = await chat([...toChat(slice), { role: "user", content: retryPrompt }], MAX_SUMMARY_TOKENS);
    const retrySpliced = spliceBlock ? `${retrySummary}\n\n${spliceBlock}` : retrySummary;
    const second = await quizContext([...retained, summaryBridgeText(retrySpliced)], probes);
    row.retryScore = second.score;
    console.log(`  retry    ${(second.score * 100).toFixed(0).padStart(3)}%  failed: ${second.failed.map((p) => p.id).join(", ") || "none"}`);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Chain mode: window1 -> compact -> window2 -> compact -> quiz window 3 on
// WINDOW-1 facts. Tests what everyone's summary-of-summary loses: whether
// the cumulative mechanical splice carries early-project state through
// repeated compactions.
// ---------------------------------------------------------------------------

async function runChain(path: string): Promise<void> {
  const all = parseTranscript(path);
  const tail = sliceNewest(all, TOKEN_BUDGET);
  const mid = Math.floor(tail.length / 2);
  const s1 = tail.slice(0, mid);
  const s2 = tail.slice(mid);
  console.log(`\n### CHAIN ${basename(path)}: window1 ${s1.length} msgs, window2 ${s2.length} msgs`);

  // window 1 -> handoff 1
  const ops1 = collectFileOps(s1);
  const summary1 = await chat([...toChat(s1), { role: "user", content: SUMMARIZATION_PROMPT }], MAX_SUMMARY_TOKENS);
  const spliced1 = renderFileOps(ops1) ? `${summary1}\n\n${renderFileOps(ops1)}` : summary1;
  const items1: HistoryItem[] = s1
    .filter(isRealUserMessage)
    .map((m) => ({ type: "message", role: "user", content: [{ type: "input_text", text: textOf(m) }] }));
  const retained1 = buildCompactedHistory([], collectUserMessages(items1), summaryBridgeText(spliced1))
    .slice(0, -1)
    .map((item) => messageText(item) ?? "")
    .filter(Boolean);

  // window 2 = handoff1 + s2 -> handoff 2 (cumulative file ops, real engine path)
  const ops2 = collectFileOps(s2, ops1);
  const window2Chat = [
    ...retained1.map((t) => ({ role: "user", content: t })),
    { role: "user", content: summaryBridgeText(spliced1) },
    ...toChat(s2),
    { role: "user", content: SUMMARIZATION_PROMPT },
  ];
  const summary2 = await chat(window2Chat, MAX_SUMMARY_TOKENS);
  const spliced2 = renderFileOps(ops2) ? `${summary2}\n\n${renderFileOps(ops2)}` : summary2;
  const items2: HistoryItem[] = s2
    .filter(isRealUserMessage)
    .map((m) => ({ type: "message", role: "user", content: [{ type: "input_text", text: textOf(m) }] }));
  const retained2 = buildCompactedHistory([], collectUserMessages(items2), summaryBridgeText(spliced2))
    .slice(0, -1)
    .map((item) => messageText(item) ?? "")
    .filter(Boolean);

  // quiz window 3 on WINDOW-1 facts only
  const w1Files = ops1.modifiedFiles.filter((f) => !collectFileOps(s2).modifiedFiles.includes(f));
  const probes = buildProbes({ modifiedFiles: w1Files.length > 0 ? w1Files : ops1.modifiedFiles });
  if (probes.length === 0) {
    console.log("no window-1 file facts to chain-test - pick a transcript with more tool activity");
    return;
  }
  console.log(`window-1-only files probed: ${(w1Files.length > 0 ? w1Files : ops1.modifiedFiles).length}`);
  const mechanical = probes[0]!.groups.filter((g) =>
    g.some((s) => spliced2.toLowerCase().includes(s.toLowerCase())),
  ).length;
  console.log(`mechanically present in window-3 splice: ${mechanical}/${probes[0]!.groups.length}`);
  const r = await quizContext([...retained2, summaryBridgeText(spliced2)], probes);
  console.log(`window-3 quiz recall of window-1 files: ${(r.score * 100).toFixed(0)}% (${r.failed.length === 0 ? "PASS" : "FAIL"})`);
}

// ---------------------------------------------------------------------------

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node test/handoff-eval.ts <transcript.jsonl> [more...]");
  process.exit(1);
}

if (CHAIN) {
  for (const p of paths) await runChain(p);
  process.exit(0);
}

const rows: Row[] = [];
for (const p of paths) {
  try {
    const row = await runOne(p, paths.length === 1);
    if (row) rows.push(row);
  } catch (e) {
    console.error(`  ERROR on ${p}: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
  }
}

if (rows.length > 1) {
  console.log("\n=== BATCH SUMMARY ===");
  console.log("transcript".padEnd(30) + "probes".padEnd(28) + "raw".padEnd(6) + "splice".padEnd(8) + "full".padEnd(6) + "retry".padEnd(7) + "handoff-tokens");
  for (const r of rows) {
    const pct = (m: string) => `${((r.scores[m]?.score ?? 0) * 100).toFixed(0)}%`;
    console.log(
      r.name.padEnd(30) +
        r.probeIds.join(",").slice(0, 26).padEnd(28) +
        pct("raw").padEnd(6) +
        pct("spliced").padEnd(8) +
        pct("full").padEnd(6) +
        (r.retryScore != null ? `${(r.retryScore * 100).toFixed(0)}%` : "-").padEnd(7) +
        `${r.handoffTokens} (${((r.handoffTokens / r.sliceTokens) * 100).toFixed(1)}%)`,
    );
  }
  const avg = (m: string) => rows.reduce((n, r) => n + (r.scores[m]?.score ?? 0), 0) / rows.length;
  console.log(
    "AVERAGE".padEnd(58) +
      `${(avg("raw") * 100).toFixed(0)}%`.padEnd(6) +
      `${(avg("spliced") * 100).toFixed(0)}%`.padEnd(8) +
      `${(avg("full") * 100).toFixed(0)}%`,
  );
  // per-probe pass rates in full mode - which probe is the weak link
  const probeStats = new Map<string, { asked: number; passed: number }>();
  for (const r of rows)
    for (const id of r.probeIds) {
      const s = probeStats.get(id) ?? { asked: 0, passed: 0 };
      s.asked += 1;
      if (!r.scores.full?.failed.includes(id)) s.passed += 1;
      probeStats.set(id, s);
    }
  console.log(
    "full-mode per-probe: " +
      [...probeStats.entries()].map(([id, s]) => `${id} ${s.passed}/${s.asked}`).join("  "),
  );
}
