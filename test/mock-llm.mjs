// Minimal OpenAI-chat-completions-compatible mock for mempact verification.
// - Logs every request body to requests.jsonl for layout inspection.
// - If the request contains the codex compaction prompt, returns a canned
//   summary; otherwise returns filler text sized via the FILLER_TOKENS env.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = 8377;
const LOG = new URL("./requests.jsonl", import.meta.url).pathname;
const FILLER_TOKENS = Number(process.env.FILLER_TOKENS ?? 900);

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
      return;
    }
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    appendFileSync(LOG, JSON.stringify({ url: req.url, body: parsed }) + "\n");

    const msgs = parsed.messages ?? [];
    const flat = JSON.stringify(msgs);
    const isCompaction = flat.includes("CONTEXT CHECKPOINT COMPACTION");
    const lastMsg = msgs[msgs.length - 1] ?? {};
    const lastText = JSON.stringify(lastMsg.content ?? "");
    const hasToolResult = msgs.some((m) => m.role === "tool");

    // Magic prompts to make the model "call" tools deterministically.
    let toolCall = null;
    if (!isCompaction && !hasToolResult) {
      if (lastText.includes("USE_NEW_CONTEXT"))
        toolCall = { id: "call_nc1", name: "new_context", arguments: "{}" };
      else if (lastText.includes("USE_BASH_BIG"))
        toolCall = { id: "call_bb1", name: "bash", arguments: JSON.stringify({ command: "seq 1 20000" }) };
    }

    const text = isCompaction
      ? "MOCK HANDOFF SUMMARY: goal X, decisions Y, next steps Z."
      : hasToolResult
        ? "tool finished, done."
        : `ack. ${"filler word soup. ".repeat(Math.ceil((FILLER_TOKENS * 4) / 18))}`;

    const promptTokens = Math.ceil(flat.length / 4);
    const completionTokens = Math.ceil(text.length / 4);

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = "chatcmpl-mock";
      sse(res, { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] });
      if (toolCall) {
        sse(res, {
          id,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } },
                ],
              },
            },
          ],
        });
        sse(res, {
          id,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      sse(res, { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] });
      sse(res, {
        id,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        }),
      );
    }
  });
}).listen(PORT, () => console.log(`mock llm on :${PORT}, log: ${LOG}`));
