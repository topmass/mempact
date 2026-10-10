/**
 * Mechanical scoring of one post-compaction context against the planted
 * facts. No model: a fact counts when its text appears (case-insensitive) or
 * when all of its keys match one line, which lets a paraphrase count.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { Fact } from "./fixtures/generate.ts";

export const contextText = (messages: readonly Message[]): string =>
  messages
    .map((m) =>
      m.role === "toolResult" || m.role === "user"
        ? typeof m.content === "string"
          ? m.content
          : m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
        : m.content.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `${c.name} ${JSON.stringify(c.arguments)}` : "")).join("\n"),
    )
    .join("\n");

/** a line that marks an old rule as no longer in force */
const SUPERSEDED = /supersed|revers|no longer|lifted|overridden|allowed now|now allowed/i;

export function scoreContext(text: string, facts: readonly Fact[], boundary: number): Record<string, number | undefined> {
  const lower = text.toLowerCase();
  const lines = lower.split("\n");
  const keyLine = (f: Fact) => f.keys && lines.find((l) => f.keys!.every((k) => new RegExp(`(?<!\\w)(?:${k})(?!\\w)`, "i").test(l)));
  const present = (f: Fact) => lower.includes(f.text.toLowerCase()) || keyLine(f) !== undefined;
  const live = facts.filter((f) => (f.liveAfter ?? -1) < boundary && (f.until == null || f.until >= boundary));
  const of = (kind: Fact["kind"]) => live.filter((f) => f.kind === kind);
  const rate = (fs: Fact[]) => (fs.length === 0 ? undefined : fs.filter(present).length / fs.length);
  const latest = (kind: Fact["kind"]) => of(kind).slice(-1);

  const reversals = of("reversal");
  const reversed = new Set(reversals.map((r) => r.supersedes));
  const constraints = of("constraint");
  // stale: the cancelled rule reads as live, and its reversal is nowhere in sight
  const stale = reversals.filter((r) => {
    const c = constraints.find((f) => f.text === r.supersedes);
    if (!c || present(r)) return false;
    const hits = lines.filter((l) => l.includes(c.text.toLowerCase()) || (c.keys && c.keys.every((k) => new RegExp(`(?<!\\w)(?:${k})(?!\\w)`, "i").test(l))));
    return hits.some((l) => !SUPERSEDED.test(l));
  });

  return {
    files: rate(of("file")),
    live_constraints: rate(constraints.filter((c) => !reversed.has(c.text))),
    reversal_present: rate(reversals),
    stale: reversals.length === 0 ? undefined : stale.length / reversals.length,
    commands: rate(of("command")),
    error: rate(of("error")),
    anchors: rate(of("anchor")),
    goal: rate(latest("goal")),
    next_step: rate(latest("next")),
  };
}
