/**
 * The ledger: facts carried by code, not by the summarizer. Built from the
 * full lossless session on every compaction, never from a previous summary,
 * so a fact cannot decay through cascaded rounds of paraphrase (prose
 * summaries keep about a third of their facts after three rounds; pinned
 * facts keep all of them).
 */

import { MAX_CONSTRAINTS, RULE_WORDS, collectAnchors, collectUserConstraints, renderAnchors, renderUserConstraints } from "./anchors.ts";
import { isSummaryMessage } from "./compact.ts";
import { collectFileOps, renderFileOps } from "./fileOps.ts";
import { contentText } from "./items.ts";
import { type CommandFact, collectCommands } from "./runFacts.ts";

export interface Ledger {
  modifiedFiles: string[];
  readFiles: string[];
  /** newest first */
  commands: CommandFact[];
  /** oldest first; `index` is the source message index */
  constraints: { text: string; index: number; superseded: boolean }[];
  anchors: string[];
  latestUserRequest?: string;
  goalChanges: { text: string; index: number }[];
}

interface MessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

const MAX_ANCHORS = 20;
const MAX_GOAL_CHANGES = 5;

/** A user message that throws away the current plan. Kept to explicit
 *  phrasings: "actually" alone starts plenty of messages that change nothing. */
const GOAL_CHANGE =
  /^(?:instead\b|actually,?\s+(?:let'?s|instead|forget|scrap)\b|forget (?:that|it|about|everything)\b|scratch that\b|new plan\b|change of plan\b)/i;
const NEGATIVE = /\b(?:never|not|no|avoid|stop|without)\b|n't\b/i;
const PERMISSION = /\b(?:can|may|ok|okay|fine|allowed|go ahead|feel free)\b/i;
/** pi's prefix for a branch_summary entry (its BRANCH_SUMMARY_PREFIX is not exported) */
export const BRANCH_SUMMARY_PREFIX = "The following is a summary of a branch that this conversation came back from:";
const FILLER = new Set(
  "never always only avoid stop using make sure must should please you the and for with not don't dont do any all can now this that from into".split(" "),
);

// paths keep their dots and slashes; sentence punctuation does not
const words = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9_./-]+/g) ?? []).map((w) => w.replace(/[./-]+$/, "")).filter((w) => w.length >= 3);
const sentences = (s: string): string[] => s.split(/(?<=[.!?\n])\s+/);
const flatClip = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * A later rule or permission that names every content word of the constraint
 * with the opposite polarity reverses it: "Never use npm." then "You can use
 * npm now." A question or a complaint ("Did you delete the prod database?",
 * "Run the tests, no need to ask.") does not.
 * ponytail: exact word match, no stemming ("use" vs "using" misses); grow it
 * only if the benchmark shows misses that matter.
 */
const reverses = (constraint: string, later: string): boolean => {
  const content = words(constraint).filter((w) => !FILLER.has(w));
  if (content.length === 0) return false;
  return sentences(later).some((s) => {
    const t = s.trim();
    if (t.endsWith("?") || !(RULE_WORDS.test(t) || PERMISSION.test(t))) return false;
    const have = new Set(words(t));
    return content.every((w) => have.has(w)) && NEGATIVE.test(t) !== NEGATIVE.test(constraint);
  });
};

export function buildLedger(messages: readonly MessageLike[]): Ledger {
  // A bridged summary carries the previous ledger and a branch summary is a
  // model's paraphrase; reading facts back out of them would let them
  // cascade, so only source messages count.
  const source: MessageLike[] = [];
  const sourceIndex: number[] = [];
  const users: { text: string; index: number }[] = [];
  messages.forEach((m, i) => {
    const text = m.role === "user" ? contentText(m.content) : "";
    if (m.role === "user" && (isSummaryMessage(text) || text.startsWith(BRANCH_SUMMARY_PREFIX))) return;
    source.push(m);
    sourceIndex.push(i);
    // a user `!cmd` run (pi renders it "Ran `cmd`") is output, not the user's words
    if (text.trim() && !text.startsWith("Ran `")) users.push({ text, index: i });
  });

  // a re-stated constraint moves to its newest position, so an earlier
  // reversal no longer applies to it
  const found = new Map<string, number>();
  for (const u of users) {
    for (const text of collectUserConstraints([u.text], Infinity)) {
      found.delete(text);
      found.set(text, u.index);
    }
  }
  const goalChanges = users.filter((u) => GOAL_CHANGE.test(u.text.trim())).map((u) => ({ text: flatClip(u.text, 200), index: u.index }));
  const constraints = [...found].map(([text, index]) => ({
    text,
    index,
    // A goal change does not supersede rules: "never push to main" survives "new plan".
    superseded: users.some((u) => u.index > index && reverses(text, u.text)),
  }));

  const { readFiles, modifiedFiles } = collectFileOps(source);
  const latest = users[users.length - 1]?.text;
  return {
    modifiedFiles,
    readFiles,
    commands: collectCommands(source).map((c) => ({ ...c, index: sourceIndex[c.index]! })),
    constraints,
    anchors: collectAnchors(source, MAX_ANCHORS),
    latestUserRequest: latest ? flatClip(latest) : undefined,
    goalChanges,
  };
}

/** One deterministic block with a fixed section order and caps. */
export function renderLedger(ledger: Ledger): string {
  const active = ledger.constraints.filter((c) => !c.superseded).slice(-MAX_CONSTRAINTS);
  const room = MAX_CONSTRAINTS - active.length;
  const superseded = room > 0 ? ledger.constraints.filter((c) => c.superseded).slice(-room) : [];
  const commands = ledger.commands.map(
    (c) =>
      `- ${c.tool}: ${c.command} -> ${c.failed ? `FAILED${c.exit != null ? ` (exit ${c.exit})` : ""}: ${c.error}` : c.exit != null ? `exit ${c.exit}` : "ok"}`,
  );
  const goals = ledger.goalChanges.slice(-MAX_GOAL_CHANGES).map((g) => `- ${g.text}`);
  const body = [
    renderFileOps(ledger),
    commands.length > 0 ? `<commands newest-first>\n${commands.join("\n")}\n</commands>` : "",
    renderUserConstraints([...active.map((c) => c.text), ...superseded.map((c) => `(superseded by a later user message) ${c.text}`)]),
    goals.length > 0 ? `<goal-changes>\n${goals.join("\n")}\n</goal-changes>` : "",
    renderAnchors(ledger.anchors),
    ledger.latestUserRequest ? `<latest-user-request>${ledger.latestUserRequest}</latest-user-request>` : "",
  ].filter(Boolean);
  if (body.length === 0) return "";
  return [
    "<ledger>",
    "Recorded by code from the full session, not written by a model. Exact as of this compaction.",
    ...body,
    "</ledger>",
  ].join("\n");
}
