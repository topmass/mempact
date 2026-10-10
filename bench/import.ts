/**
 * Turns a real transcript into the fixture shape, with no planted facts:
 * a Claude Code transcript (~/.claude/projects/<project>/<session>.jsonl)
 * or a pi session file (~/.pi/agent/sessions/<cwd>/<session>.jsonl). Only
 * the cost and replay metrics apply to the result.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Fixture } from "./fixtures/generate.ts";

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Block[];
  is_error?: boolean;
}

const blockText = (c: string | Block[] | undefined): string =>
  typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");

const emptyAssistant = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "import",
  model: "transcript",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 0,
});

export function importTranscript(path: string): Fixture {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, any>);
  const name = basename(path, ".jsonl");

  // pi session: entries of type "message" hold AgentMessages
  if (lines.some((l) => l.type === "session")) {
    return { name, seed: 0, messages: convertToLlm(lines.filter((l) => l.type === "message").map((l) => l.message)) };
  }

  // Claude Code: one line per content block; side chains are subagents
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  for (const l of lines) {
    if ((l.type !== "user" && l.type !== "assistant") || l.isSidechain || l.isMeta) continue;
    const content: string | Block[] = l.message?.content ?? "";
    if (l.type === "assistant") {
      const last = messages.at(-1);
      const target = last?.role === "assistant" ? last : (messages.push(emptyAssistant()), messages.at(-1) as AssistantMessage);
      for (const b of typeof content === "string" ? [{ type: "text", text: content }] : content) {
        if (b.type === "text" && b.text) target.content.push({ type: "text", text: b.text });
        if (b.type === "tool_use" && b.id && b.name) {
          toolNames.set(b.id, b.name);
          target.content.push({ type: "toolCall", id: b.id, name: b.name, arguments: b.input ?? {} });
          target.stopReason = "toolUse";
        }
      }
      continue;
    }
    if (typeof content === "string") {
      if (content.trim()) messages.push({ role: "user", content: [{ type: "text", text: content }], timestamp: 0 });
      continue;
    }
    for (const b of content) {
      if (b.type === "tool_result" && b.tool_use_id) {
        messages.push({
          role: "toolResult",
          toolCallId: b.tool_use_id,
          toolName: toolNames.get(b.tool_use_id) ?? "unknown",
          content: [{ type: "text", text: blockText(b.content) }],
          isError: b.is_error === true,
          timestamp: 0,
        });
      }
    }
    const text = blockText(content);
    if (text.trim()) messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
  }
  return { name, seed: 0, messages: messages.filter((m) => m.role !== "assistant" || m.content.length > 0) };
}
