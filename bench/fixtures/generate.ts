/**
 * Deterministic synthetic coding sessions with planted facts. Every fact the
 * script states is recorded next to the messages, so scoring is a substring
 * check, not a judgment call. Same seed and size, same bytes.
 *
 * Write the checked-in fixtures:
 *   node --experimental-strip-types bench/fixtures/generate.ts
 */

import { writeFileSync } from "node:fs";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export type FactKind = "constraint" | "reversal" | "file" | "command" | "error" | "anchor" | "goal" | "next";

export interface Fact {
  kind: FactKind;
  text: string;
  /** index of the message that states it; live at boundaries after it */
  liveAfter?: number;
  /** index after which it no longer applies (a fixed error) */
  until?: number;
  /** regex sources that must all match one line, word-bounded, for a paraphrase to count */
  keys?: string[];
  /** for a reversal: the constraint text it cancels */
  supersedes?: string;
}

export interface Fixture {
  name: string;
  seed: number;
  messages: Message[];
  /** absent for imported transcripts */
  facts?: Fact[];
}

export const FIXTURES = {
  small: { seed: 11, tokens: 60_000 },
  medium: { seed: 22, tokens: 150_000 },
  large: { seed: 33, tokens: 400_000 },
} as const;

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FILLER_FILES = [
  "src/cache/store.ts",
  "src/server/routes.ts",
  "src/server/middleware.ts",
  "src/config/env.ts",
  "src/db/pool.ts",
  "src/util/hash.ts",
  "test/cache/store.test.ts",
  "docs/architecture.md",
];
const FILLER_COMMANDS = ["pnpm build --verbose", "rg -n cache src", "tail -n 400 logs/server.log", "git diff --stat HEAD~3"];
const WORDS =
  "session entry value key ttl size limit evict touch hit miss store client pool route handler config request response retry backoff timer queue buffer index node list map".split(
    " ",
  );

export function generateFixture(name: string, seed: number, targetTokens: number): Fixture {
  // pass 1 measures the scripted messages and the filler weights, pass 2
  // spreads what is left of the target across the weighted filler slots
  const dry = session(seed, () => 0);
  const scripted = dry.messages.reduce((n, m) => n + estimateTokens(m), 0);
  const perWeight = Math.max(0, targetTokens - scripted) / dry.weights;
  return { name, seed, ...session(seed, (w) => w * perWeight) };
}

function session(seed: number, fillBudget: (weight: number) => number): { messages: Message[]; facts: Fact[]; weights: number } {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const messages: Message[] = [];
  const facts: Fact[] = [];
  const seenFiles = new Set<string>();
  let calls = 0;
  const ts = () => 1_760_000_000_000 + messages.length * 1000;

  const fact = (kind: FactKind, text: string, extra: Partial<Fact> = {}) => facts.push({ kind, text, liveAfter: messages.length - 1, ...extra });
  const user = (text: string) => messages.push({ role: "user", content: [{ type: "text", text }], timestamp: ts() });
  const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) =>
    messages.push({
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "bench",
      model: "synthetic",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      timestamp: ts(),
    });
  const say = (text: string) => assistant([{ type: "text", text }], "stop");
  const tool = (toolName: string, args: Record<string, string>, output: string, isError = false) => {
    const id = `call_${++calls}`;
    assistant([{ type: "toolCall", id, name: toolName, arguments: args }], "toolUse");
    messages.push({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: output }], isError, timestamp: ts() });
    if (args.path && !seenFiles.has(args.path)) {
      seenFiles.add(args.path);
      fact("file", args.path);
    }
  };
  const read = (path: string, lines = 40) => tool("read", { path }, code(lines));
  const write = (path: string) => tool("write", { path, content: code(20) }, `Wrote ${path}`);
  const edit = (path: string) => tool("edit", { path, oldText: "return entry;", newText: "return touch(entry);" }, `Edited ${path}`);
  const bash = (command: string, output: string, exit = 0) =>
    tool("bash", { command }, exit === 0 ? output : `${output}\n\nCommand exited with code ${exit}`, exit !== 0);

  const code = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => {
      const a = pick(WORDS);
      const b = pick(WORDS);
      return i % 6 === 0
        ? `export function ${a}${b[0]!.toUpperCase()}${b.slice(1)}(${a}: ${b === "size" ? "number" : "string"}) {`
        : `  const ${a}${i} = ${b}.get(${a}) ?? ${Math.floor(rand() * 1000)}; // ${pick(WORDS)} ${pick(WORDS)}`;
    }).join("\n");
  const log = (lines: number): string =>
    Array.from(
      { length: lines },
      (_, i) =>
        `2026-10-0${1 + (i % 9)}T12:${String(i % 60).padStart(2, "0")}:0${i % 10}Z INFO ${pick(WORDS)} id=${Math.floor(rand() * 100000)} path=/api/v1/${pick(WORDS)}/${Math.floor(rand() * 500)} status=${pick([200, 200, 200, 304, 404])} dur=${Math.floor(rand() * 90)}ms`,
    ).join("\n");

  // Filler: long reads and command outputs that carry no planted fact
  // (files read still count as file facts).
  let weights = 0;
  const fill = (weight: number) => {
    weights += weight;
    let budget = fillBudget(weight);
    while (budget > 1500) {
      const start = messages.length;
      if (rand() < 0.4) read(pick(FILLER_FILES), 150 + Math.floor(rand() * 300));
      else bash(pick(FILLER_COMMANDS), log(60 + Math.floor(rand() * 120)));
      if (rand() < 0.3) say(`That output shows nothing unusual for ${pick(WORDS)} ${pick(WORDS)}; moving on.`);
      for (const m of messages.slice(start)) budget -= estimateTokens(m);
    }
  };

  // --- topic 1: LRU eviction ---
  user(
    "We need LRU eviction in the session cache, starting in src/cache/store.ts. Issue #517 has the details: https://github.com/acme/cachekit/issues/517. Never use npm for installs. Always run pnpm test before you commit.",
  );
  fact("goal", "LRU eviction in the session cache", { keys: ["lru", "evict\\w*"] });
  fact("constraint", "Never use npm for installs", { keys: ["npm", "never|not|don't|no"] });
  fact("constraint", "Always run pnpm test before you commit", { keys: ["pnpm test", "commit\\w*"] });
  fact("anchor", "#517");
  fact("anchor", "https://github.com/acme/cachekit/issues/517");
  read("src/cache/store.ts", 120);
  read("package.json", 30);
  bash("git log --oneline -5", "a1b2c3d4e5 cache: add ttl\n9e8d7c6b5a server: log latency\n4f3e2d1c0b db: pool size from env\n7a6b5c4d3e docs: architecture\n2b3c4d5e6f init");
  fact("command", "git log --oneline -5");
  fill(1);
  say("The store keeps a plain Map with no ordering. I'll add an LRU list next to it and evict from the tail when size passes the limit.");
  write("src/cache/lru.ts");
  edit("src/cache/store.ts");
  bash(
    "pnpm test",
    "RUN v3.2.4 /repo\n\n ✓ test/server/routes.test.ts (12 tests)\n FAIL test/cache/store.test.ts > evicts least recently used entry\nAssertionError: expected 'session-7' to be undefined\n ❯ test/cache/store.test.ts:88:31\n\nTest Files 1 failed | 13 passed (14)",
    1,
  );
  fact("command", "pnpm test");
  const errorAt = facts.push({ kind: "error", text: "expected 'session-7' to be undefined", keys: ["session-7"], liveAfter: messages.length - 1 }) - 1;
  say("The eviction test fails: the LRU touches an entry on read before the size check, so the oldest entry survives. Next I'll fix the touch order in src/cache/lru.ts.");
  fact("next", "fix the touch order in src/cache/lru.ts", { keys: ["touch order"] });

  // --- topic 2: PR review, with the failing test parked; npm allowed again ---
  user(
    "Park that failing test for now. Do not touch the public API in src/index.ts. First look at PR #482, the retry middleware review: https://github.com/acme/cachekit/pull/482",
  );
  fact("constraint", "Do not touch the public API in src/index.ts", { keys: ["public api"] });
  fact("anchor", "#482");
  fact("anchor", "https://github.com/acme/cachekit/pull/482");
  fact("next", "address the review comments on PR #482", { keys: ["482", "review\\w*|comment\\w*"] });
  bash(
    "gh pr view 482 --comments",
    "title: retry middleware with jittered backoff\nstate: OPEN\n--\nreviewer: the backoff ignores Retry-After headers\nreviewer: max attempts should come from config, not a literal 5",
  );
  fact("command", "gh pr view 482 --comments");
  read("src/server/middleware.ts", 80);
  write("src/server/retry.ts");
  fill(2);
  user("Never push directly to main. Open the fix as a branch.");
  fact("constraint", "Never push directly to main", { keys: ["push\\w*", "main"] });
  bash("git checkout -b fix/retry-backoff", "Switched to a new branch 'fix/retry-backoff'");
  fact("command", "git checkout -b fix/retry-backoff");
  bash("git push -u origin fix/retry-backoff", "To github.com:acme/cachekit.git\n * [new branch] fix/retry-backoff -> fix/retry-backoff");
  fact("command", "git push -u origin fix/retry-backoff");

  user("You can use npm for installs now, the lockfile issue is fixed.");
  fact("reversal", "You can use npm for installs now", { keys: ["npm", "can|allowed|okay|ok|fine|lifted"], supersedes: "Never use npm for installs" });
  bash("npm install --save-dev autocannon", "added 14 packages in 2s");
  fact("command", "npm install --save-dev autocannon");
  fill(1);

  // --- topic 3: goal change to Redis ---
  user(
    "Change of plan: drop the LRU work and move the session cache to Redis instead. Use the client in src/db/redis.ts. Only use Node built-ins for hashing.",
  );
  fact("goal", "move the session cache to Redis", { keys: ["redis", "session cache|session store|sessions?"] });
  fact("constraint", "Only use Node built-ins for hashing", { keys: ["built-?ins?", "hash\\w*"] });
  read("src/db/pool.ts", 60);
  write("src/db/redis.ts");
  edit("src/cache/store.ts");
  bash("pnpm typecheck", "> tsc --noEmit");
  fact("command", "pnpm typecheck");
  say("Typecheck passes. Next I'll add the connection pool to src/db/redis.ts.");
  fact("next", "add the connection pool to src/db/redis.ts", { keys: ["connection pool"] });
  fill(2);
  edit("src/db/redis.ts");
  say("Pool is in. Next I'll wire the Redis store into src/server/routes.ts behind the CACHE_BACKEND flag.");
  fact("next", "wire the Redis store into src/server/routes.ts", { keys: ["CACHE_BACKEND"] });
  fact("anchor", "CACHE_BACKEND");
  edit("src/server/routes.ts");
  edit("src/config/env.ts");
  fill(1.5);

  // --- topic 4: back to the eviction test, parked since topic 1 ---
  user("OK, back to the failing eviction test. It has to pass on the Redis store too. The regression came in with 3f9c2ab71e, so compare against that commit.");
  fact("anchor", "3f9c2ab71e");
  say("Next I'll fix the touch order in src/cache/lru.ts and rerun the suite.");
  fact("next", "fix the touch order in src/cache/lru.ts", { keys: ["touch order"] });
  fill(1.5);
  edit("src/cache/lru.ts");
  bash("pnpm test", "RUN v3.2.4 /repo\n\n ✓ test/server/routes.test.ts (12 tests)\n ✓ test/cache/store.test.ts (9 tests)\n\nTest Files 14 passed (14)");
  facts[errorAt]!.until = messages.length - 1;

  // --- topic 5: changelog ---
  user("Before you finish, update docs/CHANGELOG.md with the Redis change and reference #517.");
  fact("next", "update docs/CHANGELOG.md", { keys: ["changelog"] });
  fill(1);
  edit("docs/CHANGELOG.md");
  bash("pnpm test", "RUN v3.2.4 /repo\n\n ✓ test/cache/store.test.ts (11 tests)\n\nTest Files 14 passed (14)");
  say("CHANGELOG updated and the suite passes. Ready for you to review the branch.");

  return { messages, facts, weights };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, { seed, tokens }] of Object.entries(FIXTURES)) {
    const fx = generateFixture(name, seed, tokens);
    const json = JSON.stringify(fx);
    const path = new URL(`./${name}.json`, import.meta.url);
    writeFileSync(path, json);
    const size = fx.messages.reduce((n, m) => n + estimateTokens(m), 0);
    console.log(`${name}: ${fx.messages.length} messages, ${size} tokens, ${(json.length / 1e6).toFixed(2)} MB, ${fx.facts!.length} facts`);
  }
}
