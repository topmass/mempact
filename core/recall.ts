/**
 * Recall search - the retrieval path over the append-only session history
 * that makes mechanical clearing and compaction self-healing: nothing is
 * deleted, only demoted, and the model can grep it back on demand (Claude
 * Code microcompaction / Cursor "context as files" lineage).
 *
 * ponytail: plain case-insensitive substring over in-memory entries; add a
 * SQLite FTS index only if sessions ever get big enough that this scan lags.
 */

export interface SearchableText {
  /** short provenance tag shown with the match, e.g. "[entry 12 toolResult]" */
  label: string;
  text: string;
}

const SNIPPET_CHARS = 400;

/** Case-insensitive substring search; returns formatted snippets centered on
 *  the first match per item, in the order items were given. */
export function searchTexts(
  items: readonly SearchableText[],
  query: string,
  maxResults = 5,
): { total: number; results: string[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { total: 0, results: [] };
  const results: string[] = [];
  let total = 0;
  for (const item of items) {
    const at = item.text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    total += 1;
    if (results.length >= maxResults) continue;
    const start = Math.max(0, at - Math.floor((SNIPPET_CHARS - needle.length) / 2));
    const end = Math.min(item.text.length, start + SNIPPET_CHARS);
    const snippet =
      (start > 0 ? "…" : "") + item.text.slice(start, end).trim() + (end < item.text.length ? "…" : "");
    results.push(`${item.label} ${snippet}`);
  }
  return { total, results };
}
