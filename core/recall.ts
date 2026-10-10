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

/**
 * Artifacts: tool outputs over the record-time cap are saved whole to
 * .mempact/artifacts/<id>.txt by the host before truncation. The marker
 * below goes into the truncated text, and cleared-output stubs repeat the
 * id, so the model can always page the full output back.
 */
export const artifactNote = (id: string, bytes: number): string =>
  `[full output saved as artifact ${id}, ${bytes} bytes; use recall with artifact=${id} and a line range]`;

export const artifactIdIn = (text: string): string | undefined => /saved as artifact ([0-9a-f]{12})\b/.exec(text)?.[1];

const MAX_ARTIFACT_LINES = 400;

/** Numbered lines for a 1-based inclusive range like "120-180" or "42",
 *  capped so one call cannot pull a whole log back into context. */
export function sliceLines(text: string, range = "1-200"): string {
  const lines = text.split("\n");
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range.trim());
  if (!m) return `Bad line range "${range}"; use a form like 120-180.`;
  const from = Math.max(1, Number(m[1]));
  if (from > lines.length) return `Line ${from} is past the end (${lines.length} lines).`;
  const to = Math.min(lines.length, m[2] ? Number(m[2]) : from, from + MAX_ARTIFACT_LINES - 1);
  const body = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`);
  return [`lines ${from}-${to} of ${lines.length}:`, ...body].join("\n");
}

/** Numbered lines containing `query` (case-insensitive), so the model can
 *  find the error in a long log before asking for a range. */
export function grepLines(text: string, query: string, max = 20): string {
  const needle = query.trim().toLowerCase();
  const hits: string[] = [];
  let total = 0;
  text.split("\n").forEach((l, i) => {
    if (!needle || !l.toLowerCase().includes(needle)) return;
    total += 1;
    if (hits.length < max) hits.push(`${i + 1}| ${l.length > 300 ? `${l.slice(0, 299)}…` : l}`);
  });
  return total === 0
    ? `No lines match "${query}".`
    : [`${total} matching line(s)${total > max ? `, first ${max}` : ""}:`, ...hits].join("\n");
}
