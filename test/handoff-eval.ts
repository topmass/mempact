/**
 * Handoff checkride eval - measures compaction handoff quality on REAL
 * conversation data against a live model, as a three-mode ablation:
 *
 *   raw      summary alone (what a naive "summarize at threshold" ships)
 *   spliced  summary + mempact's mechanical file-op lists
 *   full     the real mempact assembly: retained user messages + summary
 *            + splices (exactly what the next window would see)
 *
 * Run:  node test/handoff-eval.ts <claude-code-transcript.jsonl>
 * Env:  ENDPOINT (default http://127.0.0.1:8080/v1)  MODEL (llamacpp)
 *       TOKEN_BUDGET (70000)  MAX_SUMMARY_TOKENS (4096)
 *
 * Requires Node >= 23.6 (native type stripping). No dependencies.
 */

import { readFileSync } from "node:fs";
import { SUMMARIZATION_PROMPT, collectUserMessages, buildCompactedHistory, summaryBridgeText } from "../core/compact.ts";
import { messageText, type HistoryItem } from "../core/items.ts";
import { collectFileOps, renderFileOps } from "../core/fileOps.ts";
import {
  buildProbes,
  extractRunFacts,
  formatQuiz,
  gradeQuiz,
  mustPreserveSection,
  type Probe,
} from "../core/checkride.ts";

const ENDPOINT = process.env.ENDPOINT ?? "http://127.0.0.1:8080/v1";
const MODEL = process.env.MODEL ?? "llamacpp";
const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET ?? 70_000);
const MAX_SUMMARY_TOKENS = Number(process.env.MAX_SUMMARY_TOKENS ?? 4096);
const TOOL_RESULT_CAP = 10_000; // bytes, mirrors the engine's ingestion cap

// ---------------------------------------------------------------------------
// Claude Code transcript -> neutral messages
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

function parseTranscript(path: string): NeutralMessage[] {
  const toolNames = new Map<string, string>();
  const out: NeutralMessage[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
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
  !/<command-name>|<local-command|<system-reminder>|<task-notification>/.test(textOf(m));

// ---------------------------------------------------------------------------
// Model calls (plain OpenAI-compatible HTTP, temperature 0)
// ---------------------------------------------------------------------------

async function chat(messages: { role: string; content: string }[], maxTokens: number): Promise<string> {
  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: maxTokens }),
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
// The eval
// ---------------------------------------------------------------------------

async function quizContext(contextTexts: string[], probes: Probe[]): Promise<{ score: number; failed: Probe[]; answer: string }> {
  const messages = [
    ...contextTexts.map((t) => ({ role: "user", content: t })),
    { role: "user", content: formatQuiz(probes) },
  ];
  const answer = await chat(messages, 700);
  const graded = gradeQuiz(probes, answer);
  return { ...graded, answer };
}

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  console.error("usage: node test/handoff-eval.ts <claude-code-transcript.jsonl>");
  process.exit(1);
}

const all = parseTranscript(transcriptPath);
const slice = sliceNewest(all, TOKEN_BUDGET);
const sliceTokens = slice.reduce((n, m) => n + tokens(JSON.stringify(m)), 0);
console.log(`transcript: ${all.length} messages | slice: ${slice.length} messages, ~${sliceTokens} tokens`);

const fileOps = collectFileOps(slice);
const run = extractRunFacts(slice);
const lastUser = [...slice].reverse().find(isRealUserMessage);
const probes = buildProbes({
  modifiedFiles: fileOps.modifiedFiles,
  lastRun: run.lastRun,
  lastError: run.lastError,
  lastUserMessage: lastUser ? textOf(lastUser) : undefined,
});
console.log(`probes: ${probes.map((p) => p.id).join(", ")}`);
console.log(`facts: ${probes.map((p) => `\n  - ${p.preserveLine.slice(0, 140)}`).join("")}\n`);

console.log("generating summary from the slice…");
const summary = await chat([...toChat(slice), { role: "user", content: SUMMARIZATION_PROMPT }], MAX_SUMMARY_TOKENS);
console.log(`summary: ${tokens(summary)} tokens\n`);

const fileOpsBlock = renderFileOps(fileOps);
const splicedSummary = fileOpsBlock ? `${summary}\n\n${fileOpsBlock}` : summary;

// retained user messages, exactly as the engine computes them
const userItems: HistoryItem[] = slice
  .filter(isRealUserMessage)
  .map((m) => ({ type: "message", role: "user", content: [{ type: "input_text", text: textOf(m) }] }));
const retained = buildCompactedHistory([], collectUserMessages(userItems), summaryBridgeText(splicedSummary))
  .slice(0, -1)
  .map((item) => messageText(item) ?? "")
  .filter(Boolean);

const modes: [string, string[]][] = [
  ["raw", [summaryBridgeText(summary)]],
  ["spliced", [summaryBridgeText(splicedSummary)]],
  ["full", [...retained, summaryBridgeText(splicedSummary)]],
];

const results: Record<string, { score: number; failed: Probe[]; answer: string }> = {};
for (const [name, ctx] of modes) {
  console.log(`quizzing mode: ${name} (context ~${tokens(ctx.join(" "))} tokens)`);
  results[name] = await quizContext(ctx, probes);
}

console.log("\n=== RESULTS ===");
for (const [name] of modes) {
  const r = results[name]!;
  console.log(
    `${name.padEnd(8)} score ${(r.score * 100).toFixed(0).padStart(3)}%  failed: ${r.failed.map((p) => p.id).join(", ") || "none"}`,
  );
  for (const p of r.failed) {
    const haystack = r.answer.toLowerCase();
    const missing = p.groups
      .filter((g) => !g.some((s) => haystack.includes(s.toLowerCase())))
      .map((g) => g[0]!.slice(0, 60));
    console.log(`         ${p.id} missing: ${missing.join(" | ")}`);
  }
}

// escalation demo on the full assembly, if anything failed
const full = results.full!;
if (full.failed.length > 0) {
  console.log("\nfull mode had failures - running MUST-PRESERVE retry…");
  const retryPrompt = `${SUMMARIZATION_PROMPT}\n\n${mustPreserveSection(full.failed)}`;
  const retrySummary = await chat([...toChat(slice), { role: "user", content: retryPrompt }], MAX_SUMMARY_TOKENS);
  const retrySpliced = fileOpsBlock ? `${retrySummary}\n\n${fileOpsBlock}` : retrySummary;
  const second = await quizContext([...retained, summaryBridgeText(retrySpliced)], probes);
  console.log(`retry    score ${(second.score * 100).toFixed(0)}%  failed: ${second.failed.map((p) => p.id).join(", ") || "none"}`);
}

console.log("\nfull-mode quiz answer for inspection:\n" + full.answer);
