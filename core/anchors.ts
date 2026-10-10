/**
 * Two more mechanical staples, same philosophy as fileOps: facts that every
 * measured summarizer drops, extracted by code and appended to the summary.
 *
 * - Anchor index (Hermes lineage, their regex "Anchor Index" lifted
 *   closed-book recall 23% -> 60%): URLs, commit SHAs, PR/issue refs, error
 *   codes and ALL_CAPS identifiers, ranked by how many messages mention them.
 * - User constraints (ConstraintRot, arXiv 2606.22528: rule survival after
 *   compaction is binary and "constraint pinning" restores 0% violations;
 *   OpenClaw's required Constraints/Rules heading): sentences in real user
 *   messages that state a rule, quoted verbatim and carried cumulatively
 *   across compactions like the file lists.
 */

import { contentText } from "./items.ts";

export const MAX_ANCHORS = 12;
export const MAX_CONSTRAINTS = 16;
const CONSTRAINT_CLIP = 200;

interface MessageLike {
  role: string;
  content?: unknown;
}

const ANCHOR_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)"'<>\]\\]+/g, // URLs (escaped tool output puts backslashes right after them)
  // git SHAs: hex with both digits and letters, not glued into a path or
  // filename (pi's /tmp/pi-bash-<hex>.log pointers are not commits), not a
  // #rrggbbaa color, and not a word plus a number ("cafe123", "facade1")
  /(?<![-/#\w])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])(?![a-f]+\d+\b|\d+[a-f]+\b)[0-9a-f]{7,40}\b/g,
  // PR / issue refs. A bare "#" needs a line start, space, bracket, or
  // owner/repo before it ("&#42;" is an HTML entity), and six bare digits
  // read as a hex color (#123456) rather than a PR
  /(?:\bPR\s?#?|\bissue\s?#?|(?<=^|[\s([]|[\w.-]\/[\w.-]+)#(?!\d{6}\b))\d{2,6}\b/gim,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g, // ERR_MODULE_NOT_FOUND, DWR_VIEW_ONLY (underscore = identifier, not shouting)
  // errno names by list: a length rule either misses EPIPE/EIO or admits EXISTS
  /\bE(?:NOENT|ACCES|PERM|PIPE|IO|BUSY|EXIST|INVAL|AGAIN|MFILE|NOSPC|ISDIR|NOTDIR|NOTEMPTY|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|HOSTUNREACH|NETUNREACH|LIFECYCLE)\b/g,
  /\b(?:TS|E|ERR)\d{3,5}\b/g, // TS2345, E0433, ERR404
];

/**
 * Identifiers ranked by weighted document frequency: one count per message
 * (a single log dump cannot flood the index), and a mention in user or
 * assistant text counts 3x a mention inside tool output, so the PR numbers
 * and SHAs the conversation talked about outrank ten unique CI-run URLs
 * from one `gh run list`. Ties break by first appearance.
 */
export function collectAnchors(messages: readonly MessageLike[], max = MAX_ANCHORS): string[] {
  const df = new Map<string, number>();
  for (const m of messages) {
    const weight = m.role === "user" || m.role === "assistant" ? 3 : 1;
    // UUIDs (session ids in harness wrappers) would otherwise shed hex
    // fragments that look like commit SHAs
    const text = contentText(m.content).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ");
    if (!text.trim()) continue;
    const seen = new Set<string>();
    for (const re of ANCHOR_PATTERNS) {
      for (const hit of text.match(re) ?? []) {
        // "PR #42", "issue 42" and "#42" are one identifier
        const token = hit.replace(/[.,;:]+$/, "").replace(/^(?:PR|issue)\s?#?/i, "#");
        if (token.length >= 3 && (token.startsWith("#") || token.length >= 5)) seen.add(token);
      }
    }
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + weight);
  }
  return [...df.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([token]) => token);
}

/** Rule-shaped phrasing, sentence-first only: mid-sentence rule words are
 *  mostly narration ("I don't know why", "we must have broken it", a pasted
 *  "TypeError: value must not be null"). An optional "please" or "you" may
 *  lead; "don't worry/mind/bother" is reassurance, not a rule. */
const RULE_WORDS =
  /^(?:please\s+|you\s+)?(?:never|always|only|avoid|stop using|make sure|do not|don't(?!\s+(?:worry|mind|bother)\b)|must|should(?:n't| not| never| always))\b/i;
/** Longer than this is a ramble, not a rule; questions are not rules either. */
const RULE_MAX_CHARS = 240;

/**
 * Sentences from REAL user messages that read like standing rules. Merged
 * cumulatively with the previous compaction's list (previous first, dedup,
 * newest kept on overflow).
 */
export function collectUserConstraints(
  userTexts: readonly string[],
  previous: readonly string[] = [],
  max = MAX_CONSTRAINTS,
): string[] {
  const out = [...previous];
  for (const text of userTexts) {
    // unwrap hard-wrapped prose: a line with no terminal punctuation continues
    // on the next line unless that line starts a bullet, heading, or paragraph
    const unwrapped = text.replace(/([^\n.!?:])\n(?![-*#\d\n])/g, "$1 ");
    for (const raw of unwrapped.split(/(?<=[.!?\n])\s+|\n+/)) {
      const sentence = raw.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim();
      if (sentence.length < 12 || sentence.length > RULE_MAX_CHARS || sentence.endsWith("?")) continue;
      if (!RULE_WORDS.test(sentence)) continue;
      const clipped = sentence.length <= CONSTRAINT_CLIP ? sentence : `${sentence.slice(0, CONSTRAINT_CLIP - 1)}…`;
      if (!out.includes(clipped)) out.push(clipped);
    }
  }
  return out.slice(-max);
}

export function renderAnchors(anchors: readonly string[]): string {
  return anchors.length > 0 ? `<anchors>\n${anchors.join("\n")}\n</anchors>` : "";
}

export function renderUserConstraints(constraints: readonly string[]): string {
  return constraints.length > 0
    ? `<user-constraints>\n${constraints.map((c) => `- ${c}`).join("\n")}\n</user-constraints>`
    : "";
}
