/**
 * OpenAI-compatible chat client (summarize for the conditions) and the
 * TRACE-style paired replay: at a compaction boundary, ask for the next
 * action once with the full raw history and once with the compacted
 * context, then compare the first tool call.
 */

import type { Message } from "@earendil-works/pi-ai";
import { OverflowError } from "../core/pipeline.ts";
import { collectCommands } from "../core/runFacts.ts";
import { contentText } from "../core/items.ts";

export const USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0";

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function endpointFromEnv(): Endpoint | undefined {
  const { MEMPACT_BENCH_BASE_URL: baseUrl, MEMPACT_BENCH_API_KEY: apiKey = "", MEMPACT_BENCH_MODEL: model } = process.env;
  return baseUrl && model ? { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model } : undefined;
}

const headers = (ep: Endpoint) => ({
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}),
});

/** First id from GET /models, for when MEMPACT_BENCH_MODEL is unset. */
export async function firstModel(baseUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: headers({ baseUrl, apiKey, model: "" }) });
  if (!res.ok) throw new Error(`GET /models: HTTP ${res.status}`);
  const id = ((await res.json()) as { data?: { id: string }[] }).data?.[0]?.id;
  if (!id) throw new Error("GET /models returned no models");
  return id;
}

const toChat = (systemPrompt: string, messages: readonly Message[]) => [
  ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
  ...messages.map((m) => {
    if (m.role === "user") return { role: "user", content: contentText(m.content) };
    if (m.role === "toolResult") return { role: "tool", tool_call_id: m.toolCallId, content: contentText(m.content) };
    const calls = m.content.flatMap((c) =>
      c.type === "toolCall" ? [{ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }] : [],
    );
    return { role: "assistant", content: contentText(m.content) || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  }),
];

interface ChatMessage {
  content?: string | null;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

async function chat(ep: Endpoint, body: Record<string, unknown>): Promise<ChatMessage> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(ep),
      body: JSON.stringify({ model: ep.model, temperature: 0, ...body }),
    }).catch((error: unknown) => error as Error);
    if (res instanceof Response && res.ok) return ((await res.json()) as { choices: { message: ChatMessage }[] }).choices[0]!.message;
    const detail = res instanceof Response ? `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` : res.message;
    if (res instanceof Response && res.status === 400 && /context|too long|exceed|n_ctx|maximum/i.test(detail)) throw new OverflowError(detail);
    if (attempt >= 3) throw new Error(`chat completions failed: ${detail}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

export const endpointSummarize =
  (ep: Endpoint) =>
  async (systemPrompt: string, messages: Message[], maxTokens: number): Promise<string> =>
    (await chat(ep, { messages: toChat(systemPrompt, messages), max_tokens: maxTokens })).content ?? "";

const REPLAY_SYSTEM =
  "You are a coding agent working in a TypeScript repository. Use the tools to act. Reply with exactly one tool call for your next action.";
const param = (props: Record<string, string>) => ({
  type: "object",
  properties: Object.fromEntries(Object.keys(props).map((k) => [k, { type: "string", description: props[k] }])),
  required: Object.keys(props),
});
const TOOLS = [
  { name: "read", description: "Read a file", parameters: param({ path: "file path" }) },
  { name: "write", description: "Write a whole file", parameters: param({ path: "file path", content: "file content" }) },
  { name: "edit", description: "Replace text in a file", parameters: param({ path: "file path", oldText: "text to find", newText: "replacement" }) },
  { name: "bash", description: "Run a shell command", parameters: param({ command: "command line" }) },
].map((function_) => ({ type: "function", function: function_ }));

export interface NextAction {
  tool: string;
  arg: string;
}

export async function nextAction(ep: Endpoint, context: readonly Message[]): Promise<NextAction> {
  const reply = await chat(ep, {
    messages: toChat(REPLAY_SYSTEM, [...context, { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 0 }]),
    tools: TOOLS,
    tool_choice: "auto",
    max_tokens: 2048,
  });
  const call = reply.tool_calls?.[0]?.function;
  if (!call) return { tool: "none", arg: "" };
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {}
  const arg = args.path ?? args.file_path ?? args.command ?? "";
  return { tool: call.name, arg: String(arg).trim() };
}

/** Whether an action repeats work already in the raw history: a read of a
 *  file already read or written, or a command already run. */
export function repeats(action: NextAction, history: readonly Message[]): { reread: number; rerun: number } {
  const paths = new Set<string>();
  for (const m of history)
    if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall" && typeof c.arguments.path === "string") paths.add(c.arguments.path);
  const commands = new Set(collectCommands(history, Infinity).map((c) => c.command));
  return {
    reread: action.tool === "read" && paths.has(action.arg) ? 1 : 0,
    rerun: action.tool === "bash" && commands.has(action.arg) ? 1 : 0,
  };
}
