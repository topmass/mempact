// Drive pi (RPC mode, ONE long-lived process) through the mempact extension
// against test/mock-llm.mjs, then print what the mock saw per request.
// Print mode (-p) exits the moment ctx.compact() aborts the loop, so mid-turn
// compaction and auto-continue are only observable this way.
//
// Setup (once):
//   PI_DIR=/tmp/mempact-e2e/agent with models.json -> http://127.0.0.1:8377/v1
//   (api "openai-completions", small contextWindow e.g. 22000) and
//   settings.json {"compaction":{"enabled":false}}; a scratch cwd for the tools.
//   FILLER_TOKENS=800 LOOP_CALLS=8 node test/mock-llm.mjs &
// Run:
//   PI_DIR=... WORK=... node test/rpc-drive.mjs <session.jsonl> "USE_BASH_LOOP" "USE_RECALL"
// Magic prompts: USE_BASH_LOOP (multi-step tool loop), USE_BASH_BIG, USE_READ_FILE,
// USE_RECALL, USE_UPDATE_MEMORY, USE_NEW_CONTEXT, USE_CONTEXT_REMAINING.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [session, ...prompts] = process.argv.slice(2);
if (!session || prompts.length === 0) {
  console.error('usage: node test/rpc-drive.mjs <session.jsonl> "<prompt>" [...]');
  process.exit(1);
}
const PI_DIR = process.env.PI_DIR ?? "/tmp/mempact-e2e/agent";
const WORK = process.env.WORK ?? "/tmp/mempact-e2e/work";
const REQUESTS = join(here, "requests.jsonl");
const QUIET_MS = 4000; // auto-continue starts a fresh agent run after compaction
const eventsLog = `${session}.events`;
writeFileSync(eventsLog, "");
writeFileSync(REQUESTS, "");

const pi = spawn(
  join(here, "..", "node_modules", ".bin", "pi"),
  ["--no-extensions", "-e", join(here, "..", "pi", "index.ts"), "--mode", "rpc", "--session", session],
  { cwd: WORK, env: { ...process.env, PI_CODING_AGENT_DIR: PI_DIR }, stdio: ["pipe", "pipe", "pipe"] },
);
pi.stderr.on("data", (d) => appendFileSync(eventsLog, `[stderr] ${d}`));
let buf = "";
let lastEvent = Date.now();
let idle = true;
const counts = {};
pi.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    appendFileSync(eventsLog, `${l}\n`);
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    lastEvent = Date.now();
    if (e.type === "agent_start" || e.type === "compaction_start") idle = false;
    if (e.type === "agent_end") idle = true;
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
for (const p of prompts) {
  idle = false;
  pi.stdin.write(`${JSON.stringify({ type: "prompt", message: p })}\n`);
  console.log(`> ${p}`);
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    await sleep(500);
    if (idle && Date.now() - lastEvent > QUIET_MS) break;
  }
}
pi.stdin.end();
pi.kill();
console.log(JSON.stringify(counts));

// Per-request view: kind, size, tool messages, cleared stubs, compaction markers.
const requests = readFileSync(REQUESTS, "utf8").split("\n").filter(Boolean);
requests.forEach((l, i) => {
  const { body } = JSON.parse(l);
  const msgs = body.messages ?? [];
  const flat = JSON.stringify(msgs);
  const tools = msgs.filter((m) => m.role === "tool");
  const cleared = tools.filter((m) => JSON.stringify(m.content ?? "").includes("tool output cleared by mempact")).length;
  const kind = flat.includes("CONTEXT CHECKPOINT COMPACTION")
    ? "COMPACTION"
    : flat.includes("Answer the questions below using ONLY")
      ? "quiz"
      : "turn";
  const cont = flat.includes("Resume the user's latest intent") ? " +continue" : "";
  const bridged = flat.includes("Another language model started to solve this problem") ? " +bridge" : "";
  console.log(`#${i} ${kind}${cont}${bridged} ~${Math.ceil(flat.length / 4)}tok msgs=${msgs.length} tools=${tools.length} cleared=${cleared}`);
});
