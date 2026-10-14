/**
 * Code carries what the model drops. Asked to keep a cumulative narrative,
 * the model still loses earlier decisions, findings and failed approaches
 * when it rewrites the checkpoint. After each round, prior items in those
 * sections that the new narrative no longer covers are appended to the same
 * section under a "Carried from earlier windows:" line, oldest dropped first
 * once the carried text passes its cap.
 */

import { NARRATIVE_SECTIONS, parseSections, sectionChunks } from "./summarySchema.ts";

/** Goal, Current work, Next step and Open questions are rewritten fresh */
const CARRIED_SECTIONS = ["decisions and why", "findings", "approaches that failed"];
export const CARRIED_NARRATIVE_TOKENS = 3_000;
export const CARRIED_LINE = "Carried from earlier windows:";
/** share of a prior item's words a new item must contain to count as kept */
const KEPT_OVERLAP = 0.6;

const BULLET = /^\s*(?:[-*]|\d+[.)])\s+/;
const CARRIED_MARK = /^\W*carried from earlier windows:?\W*$/i;
/** "None" and code notes such as "[checkpoint note: ...]" are not items */
const NOT_ITEM = /^(?:none\.?|\[.*\])$/i;

/** the same 3+ character words as core/ledger.ts */
const words = (s: string): Set<string> =>
  new Set((s.toLowerCase().match(/[a-z0-9_./-]+/g) ?? []).map((w) => w.replace(/[./-]+$/, "")).filter((w) => w.length >= 3));

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface Item {
  section: string;
  text: string;
  /** listed under a carried line, so older than the body items */
  old: boolean;
}

/** A bullet starts an item, a blank line ends one, and other lines continue
 *  it, so a section without bullets yields one item per paragraph. */
const sectionItems = (text: string): Item[] => {
  const out: Item[] = [];
  for (const [section, body] of parseSections(text)) {
    if (!CARRIED_SECTIONS.includes(section)) continue;
    let old = false;
    let current: Item | undefined;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (CARRIED_MARK.test(t)) old = true;
      if (!t || CARRIED_MARK.test(t)) current = undefined;
      else if (BULLET.test(line) || !current) out.push((current = { section, text: t.replace(BULLET, ""), old }));
      else current.text += ` ${t}`;
    }
  }
  return out.filter((i) => !NOT_ITEM.test(i.text) && words(i.text).size > 0);
};

const kept = (item: Item, current: Set<string>[]): boolean => {
  const w = words(item.text);
  return current.some((c) => [...w].filter((x) => c.has(x)).length >= KEPT_OVERLAP * w.size);
};

/** `narrative` with the items of `previous` it dropped appended under a
 *  carried line in their sections, at most CARRIED_NARRATIVE_TOKENS of them. */
export function carryDroppedItems(previous: string, narrative: string): string {
  const current = sectionItems(narrative).map((i) => words(i.text));
  // stable sort: carried before body items, otherwise section and line order
  const dropped = sectionItems(previous)
    .filter((i) => !kept(i, current))
    .sort((a, b) => Number(b.old) - Number(a.old));
  let total = dropped.reduce((n, i) => n + estimateTokens(`- ${i.text}`), 0);
  while (total > CARRIED_NARRATIVE_TOKENS) total -= estimateTokens(`- ${dropped.shift()!.text}`);
  if (dropped.length === 0) return narrative;

  const chunks = sectionChunks(narrative);
  for (const section of CARRIED_SECTIONS) {
    const bullets = dropped.filter((i) => i.section === section).map((i) => `- ${i.text}`);
    if (bullets.length === 0) continue;
    let chunk = chunks.findLast((c) => c.name === section);
    if (!chunk) {
      chunks.at(-1)!.lines.push("");
      chunks.push((chunk = { name: section, lines: [`## ${NARRATIVE_SECTIONS.find((s) => s.toLowerCase() === section)}`] }));
    }
    const lines = chunk.lines;
    let end = lines.length;
    while (end > 1 && !lines[end - 1]!.trim()) end--;
    const marked = lines.slice(1, end).some((l) => CARRIED_MARK.test(l.trim()));
    lines.splice(end, 0, ...(marked ? [] : ["", CARRIED_LINE]), ...bullets);
  }
  return chunks.flatMap((c) => c.lines).join("\n");
}
