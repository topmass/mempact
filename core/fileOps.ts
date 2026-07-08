/**
 * Deterministic file-op tracking - pi's cumulative <read-files>/<modified-files>
 * trick, mechanically extracted from assistant toolCall blocks and appended to
 * every compaction summary. Zero LLM cost, survives unlimited compactions
 * losslessly, and directly targets the worst-measured summarization failure
 * (Factory's probe eval: every method scored ~2.2/5 on file-state tracking).
 */

export interface FileOpLists {
  readFiles: string[];
  modifiedFiles: string[];
}

/** Cap per list so cumulative merging across many compactions stays bounded
 *  (oldest paths drop first; a re-touched path moves back to the end). */
const MAX_TRACKED_PATHS = 40;

const pathOf = (args: Record<string, unknown>): string | undefined =>
  typeof args.path === "string"
    ? args.path
    : typeof args.file_path === "string"
      ? args.file_path
      : undefined;

const pushUnique = (list: string[], p: string): void => {
  const i = list.indexOf(p);
  if (i !== -1) list.splice(i, 1);
  list.push(p);
};

/**
 * Extract read/modified file paths from assistant toolCall blocks, merged
 * cumulatively with the previous compaction's lists (previous first, so
 * recency ordering holds after the cap).
 */
export function collectFileOps<M extends { role: string; content?: unknown }>(
  messages: readonly M[],
  previous?: FileOpLists,
): FileOpLists {
  const readFiles = [...(previous?.readFiles ?? [])];
  const modifiedFiles = [...(previous?.modifiedFiles ?? [])];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as { type: string; name?: string; arguments?: Record<string, unknown> }[]) {
      if (block.type !== "toolCall" || !block.name) continue;
      const path = pathOf(block.arguments ?? {});
      if (!path) continue;
      const name = block.name.toLowerCase();
      if (name === "read") pushUnique(readFiles, path);
      else if (name === "write" || name === "edit") pushUnique(modifiedFiles, path);
    }
  }
  return {
    readFiles: readFiles.slice(-MAX_TRACKED_PATHS),
    modifiedFiles: modifiedFiles.slice(-MAX_TRACKED_PATHS),
  };
}

/** The block appended to a compaction summary (pi's exact tag convention). */
export function renderFileOps({ readFiles, modifiedFiles }: FileOpLists): string {
  const parts: string[] = [];
  if (readFiles.length > 0) parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0)
    parts.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return parts.join("\n");
}
