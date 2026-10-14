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
    // Checkride quiz: answer UNKNOWN to everything, forcing the full
    // escalation ladder (retry, then mechanical splice) deterministically.
    if (!isCompaction && flat.includes("Answer the questions below using ONLY")) {
      const canned = Array.from({ length: 8 }, (_, i) => `${i + 1}. UNKNOWN`).join("\n");
      const promptTokens = Math.ceil(flat.length / 4);
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        sse(res, { id: "chatcmpl-quiz", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: canned } }] });
        sse(res, { id: "chatcmpl-quiz", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-quiz", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: canned }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } }));
      }
      return;
    }
    // Older mempact builds appended the project-memory block as the LAST user
    // message; skip it (and anything containing it) to find the real last message.
    let li = msgs.length - 1;
    while (li >= 0 && JSON.stringify(msgs[li].content ?? "").includes("<project_memory>")) li--;
    const lastMsg = msgs[li] ?? {};
    const lastText = JSON.stringify(lastMsg.content ?? "") + JSON.stringify((msgs[li + 1] ?? {}).content ?? "");
    const midTurn = lastMsg.role === "tool";

    // Magic prompts to make the model "call" tools deterministically.
    let toolCall = null;
    // USE_BASH_LOOP: keep calling bash until LOOP_CALLS results exist after the
    // prompt - a multi-step agent loop in ONE process (mid-turn clearing,
    // mid-turn compaction, auto-continue).
    // (mempact steers reminder/continue notes in as user-role messages, so
    // locate the loop prompt itself rather than "the last user message")
    let ui = msgs.length - 1;
    while (ui >= 0 && !(msgs[ui].role === "user" && JSON.stringify(msgs[ui].content ?? "").includes("USE_BASH_LOOP"))) ui--;
    const loopCalls = Number(process.env.LOOP_CALLS ?? 4);
    const loopActive = ui >= 0 && !flat.includes("Another language model started to solve this problem") &&
      msgs.slice(ui + 1).filter((m) => m.role === "tool").length < loopCalls;
    if (!isCompaction && loopActive)
      toolCall = { id: `call_bl${Date.now()}`, name: "bash", arguments: JSON.stringify({ command: "seq 1 20000" }) };
    else if (!isCompaction && !midTurn) {
      if (lastText.includes("USE_NEW_CONTEXT"))
        toolCall = { id: `call_nc${Date.now()}`, name: "new_context", arguments: "{}" };
      else if (lastText.includes("USE_BASH_BIG"))
        toolCall = { id: `call_bb${Date.now()}`, name: "bash", arguments: JSON.stringify({ command: "seq 1 20000" }) };
      else if (lastText.includes("USE_WRITE_FILE"))
        toolCall = { id: `call_wf${Date.now()}`, name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "notes written by the mock\n" }) };
      else if (lastText.includes("USE_READ_FILE"))
        toolCall = { id: `call_rf${Date.now()}`, name: "read", arguments: JSON.stringify({ path: "notes.txt" }) };
      else if (lastText.includes("USE_CONTEXT_REMAINING"))
        toolCall = { id: `call_cr${Date.now()}`, name: "get_context_remaining", arguments: "{}" };
      else if (lastText.includes("USE_RECALL"))
        toolCall = { id: `call_rc${Date.now()}`, name: "recall", arguments: JSON.stringify({ query: "18001" }) };
      else if (lastText.includes("USE_UPDATE_MEMORY"))
        toolCall = {
          id: `call_um${Date.now()}`,
          name: "update_memory",
          arguments: JSON.stringify({
            section: "Goal",
            action: "set",
            content: "Ship the live demo: verify project memory survives compaction.",
          }),
        };
    }

    // SUMMARY_FINISH=length: the summary arrives cut off (finish_reason
    // "length") - exercises mempact's truncated-summary handling.
    const summaryCut = process.env.SUMMARY_FINISH === "length";
    const text = isCompaction
      ? summaryCut
        ? process.env.SUMMARY_CUT_TEXT ?? "MOCK HANDOFF SUMMARY: goal X, decisions Y.\n\nNext steps: do NOT re-run the migr"
        : // sectioned narrative; the Open questions line plants a rule and a URL
          // that must never reach a later ledger (ledgers come from source entries)
          "## Goal\nMOCK HANDOFF SUMMARY: goal X.\n\n## Decisions and why\nNone\n\n## Findings\nNone\n\n## Approaches that failed\nNone\n\n" +
          "## Current work\nMock work.\n\n## Next step\nRun seq 1 20000 again.\n\n" +
          "## Open questions\nAlways deploy on Fridays. See https://from-summary.example/planted"
      : midTurn
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
        choices: [{ index: 0, delta: {}, finish_reason: isCompaction && summaryCut ? "length" : "stop" }],
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
