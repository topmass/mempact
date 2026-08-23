/**
 * Anchor index - mechanical needle-fact harvest (hermes-agent lineage,
 * adopted 2026-08-22). Exact identifiers that honest summarization at 10:1
 * reliably paraphrases away - commit SHAs, PR/issue refs, file paths, URLs,
 * error lines - are extracted by regex with no LLM in the loop and appended
 * to every compaction summary. Hermes measured +33pts closed-book recall
 * from this alone (evals/compaction/results/SCORECARD-2026-08-15.md).
 *
 * Deliberately conservative: hard per-category caps, a total char budget,
 * newest-first retention (the oldest anchors drop first), dedup. This
 * complements - never replaces - the structured staples (<modified-files>,
 * <last-run>, <unresolved-error>, <latest-user-request>, <git-state>).
 */

export interface AnchorIndex {
  commits: string[];
  refs: string[];
  files: string[];
  urls: string[];
  errors: string[];
}

const CAPS = { commits: 12, refs: 12, files: 24, urls: 8, errors: 8 } as const;
const TOTAL_CHAR_BUDGET = 2_000;
const ERROR_LINE_MAX = 140;

interface MessageLike {
  role: string;
  content?: unknown;
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as { type: string; text?: string }[])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

/** newest-first dedup keeping insertion order of the LAST occurrence */
function keepNewest(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < cap; i--) {
    const key = items[i]!.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(items[i]!);
  }
  return out.reverse();
}

/**
 * Harvest anchors from host-neutral messages (same shape extractRunFacts
 * accepts). Text of user, assistant, and toolResult messages is scanned.
 */
export function collectAnchors(messages: readonly MessageLike[]): AnchorIndex {
  const commits: string[] = [];
  const refs: string[] = [];
  const files: string[] = [];
  const urls: string[] = [];
  const errors: string[] = [];

  for (const m of messages) {
    const text = textOf(m.content);
    if (!text) continue;

    // commit SHAs: 7-40 hex chars, must contain a letter (else it's a number)
    for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      if (/[a-f]/.test(match[0]) && /\d/.test(match[0])) commits.push(match[0]);
    }
    // PR/issue refs: #123 style (2-6 digits)
    for (const match of text.matchAll(/(?<![\w&])#\d{2,6}\b/g)) refs.push(match[0]);
    // URLs first; they are removed from the path scan so a URL's tail can
    // never be misfiled as a repo path
    let pathText = text;
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      urls.push(match[0]);
      pathText = pathText.replace(match[0], " ");
    }
    // file paths: at least one slash + an extension
    for (const match of pathText.matchAll(/(?<![\/.\w])[\w@-][\w.@-]*(?:\/[\w.@-]+)+\.\w{1,8}\b/g)) {
      files.push(match[0]);
    }
    // error lines: first ERROR_LINE_MAX chars of lines carrying error-ish markers
    for (const line of text.split("\n")) {
      if (/(error|exception|traceback|panic|fatal|failed with)\b/i.test(line)) {
        const clipped = line.trim().slice(0, ERROR_LINE_MAX);
        if (clipped.length >= 8) errors.push(clipped);
      }
    }
  }

  return {
    commits: keepNewest(commits, CAPS.commits),
    refs: keepNewest(refs, CAPS.refs),
    files: keepNewest(files, CAPS.files),
    urls: keepNewest(urls, CAPS.urls),
    errors: keepNewest(errors, CAPS.errors),
  };
}

/** Render as the <anchor-index> splice block; "" when nothing was found.
 *  Categories are dropped whole (rarest-first kept) if the budget overflows. */
export function renderAnchors(index: AnchorIndex): string {
  const lines: string[] = [];
  if (index.commits.length) lines.push(`commits: ${index.commits.join(", ")}`);
  if (index.refs.length) lines.push(`refs: ${index.refs.join(", ")}`);
  if (index.files.length) lines.push(`files: ${index.files.join(", ")}`);
  if (index.urls.length) lines.push(`urls: ${index.urls.join(", ")}`);
  for (const e of index.errors) lines.push(`error: ${e}`);
  while (lines.length > 0 && lines.join("\n").length > TOTAL_CHAR_BUDGET) {
    lines.pop();
  }
  if (lines.length === 0) return "";
  return `<anchor-index>\n${lines.join("\n")}\n</anchor-index>`;
}
