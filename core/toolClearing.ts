/**
 * Mechanical tool-output clearing - the cheap context-editing tier BELOW the
 * compaction threshold. Lineage: Anthropic's context editing
 * ("clear_tool_uses_2025_06_27"): mechanically clearing stale tool results
 * beats summarizing them, at zero LLM cost.
 *
 * mempact applies it per-request and non-destructively: the session file
 * keeps full outputs; only the SENT request is stubbed. The tool call itself
 * (name, arguments) stays in the conversation and the stub keeps the
 * output's first line, so the facts of what ran survive - only prose goes.
 * Because stubs are recomputed deterministically from the persisted
 * originals, old positions stay byte-identical across requests (prompt-cache
 * friendly); only the boundary near the tail moves.
 */

export const CLEARED_OUTPUT_NOTE =
  "[tool output cleared by mempact to free context (recall tool has the full text)";

export interface ClearableMessage {
  role: string;
  content?: unknown;
}

interface TextBlockLike {
  type: string;
  text?: string;
}

/** One-line stub keeping the original output's first line, clipped. */
export function clearedStub(originalText: string, maxChars = 160): string {
  const first = (originalText.split("\n", 1)[0] ?? "").trim();
  const clipped = first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
  return clipped ? `${CLEARED_OUTPUT_NOTE}; first line was: ${clipped}]` : `${CLEARED_OUTPUT_NOTE}]`;
}

/**
 * The clearing boundary advances in batches of this many results. Audit
 * finding (92k live run): advancing per-result rewrites one mid-context
 * message every turn, invalidating the entire KV-cache suffix behind it
 * (~50k tokens re-prefilled per turn at scale). Batching trades holding up
 * to `CLEAR_BATCH-1` extra full results for cache invalidation once per
 * batch instead of once per turn.
 */
export const CLEAR_BATCH = 4;

/**
 * Replace the content of all but the newest `keepRecent` toolResult messages
 * with a one-line stub (Anthropic's default keeps the last 3 tool uses).
 * The cleared count is rounded down to a multiple of `batch` so the stub
 * boundary is byte-stable across `batch` consecutive requests.
 * Pure: returns new message objects; the input array is untouched.
 */
export function clearOldToolOutputs<M extends ClearableMessage>(
  messages: readonly M[],
  keepRecent: number,
  batch: number = CLEAR_BATCH,
): { messages: M[]; cleared: number } {
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "toolResult") toolIndexes.push(i);
  }
  const rawClearCount = toolIndexes.length - Math.max(0, keepRecent);
  const step = Math.max(1, batch);
  const clearCount = Math.floor(rawClearCount / step) * step;
  if (clearCount <= 0) return { messages: [...messages], cleared: 0 };

  const out = [...messages];
  for (const i of toolIndexes.slice(0, clearCount)) {
    const msg = out[i]!;
    const blocks = Array.isArray(msg.content) ? (msg.content as TextBlockLike[]) : [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    out[i] = { ...msg, content: [{ type: "text", text: clearedStub(text) }] } as M;
  }
  return { messages: out, cleared: clearCount };
}
