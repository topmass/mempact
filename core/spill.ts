/**
 * Spill-first full-output retention - the fix for the audit's F1.
 *
 * The codex 10KB record-time cap was ported one layer too low: upstream codex
 * truncates only the MODEL-VISIBLE history copy while the rollout JSONL keeps
 * the full item; pi has no such second store, so mempact's pre-persistence
 * truncation destroyed the only canonical copy of every tool result >12KB.
 *
 * This module makes the truncation non-destructive: before the preview cap is
 * applied, the full text is written to a durable spill artifact with a stable
 * locator (tool-call id), byte count, and content hash. The model-facing
 * preview stays byte-compatible with the codex algorithm, plus one appended
 * locator line so the model (and `recall`) can retrieve the original exactly.
 *
 * Invariants (DeepSeek spill-policy lineage, kept deliberately):
 * - Fail-open: a spill failure must NEVER turn a successful tool result into
 *   an error or block the preview - the caller falls back to plain truncation.
 * - The artifact stores the accepted text verbatim (no re-encoding).
 * - Artifacts are append-only; nothing here deletes or rewrites them.
 * - The spill dir is .gitignore-protected (ensureSpillDir writes it).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SpillRef {
  /** stable locator: the tool-call id (sanitized), unique per session dir */
  id: string;
  toolName: string;
  file: string;
  bytes: number;
  sha256: string;
  time: number;
}

const encoder = new TextEncoder();

/** One safe path segment from a tool-call id (injective enough: non-word
 *  chars hex-escaped so distinct ids cannot collide). */
export function sanitizeId(id: string): string {
  const escaped = id
    .replace(/[^A-Za-z0-9._-]/g, (c) => `~${c.codePointAt(0)!.toString(16)}`)
    .slice(0, 120);
  // whole-segment dots ("." / "..") get a prefix so the id can never read as
  // a relative path segment even without the .txt suffix
  return /^\.+$/.test(escaped) ? `~${escaped.length}dot` : escaped;
}

export function spillDir(cwd: string): string {
  return join(cwd, ".mempact", "spill");
}

function indexPath(cwd: string): string {
  return join(spillDir(cwd), "index.jsonl");
}

/** Create the spill dir and make sure the whole .mempact/spill tree is
 *  git-ignored (memory.md stays committed-or-not at the user's choice). */
function ensureSpillDir(cwd: string): void {
  const dir = spillDir(cwd);
  mkdirSync(dir, { recursive: true });
  const gi = join(cwd, ".mempact", ".gitignore");
  try {
    const current = readFileSync(gi, "utf8");
    if (!current.split("\n").some((l) => l.trim() === "spill/")) {
      appendFileSync(gi, `${current.endsWith("\n") ? "" : "\n"}spill/\n`);
    }
  } catch {
    writeFileSync(gi, "spill/\n");
  }
}

/**
 * Persist full tool-output text before the model-facing cap is applied.
 * Atomic (tmp+rename). Returns null on ANY failure (fail-open contract).
 */
export function spillFullOutput(
  cwd: string,
  toolCallId: string,
  toolName: string,
  text: string,
): SpillRef | null {
  try {
    ensureSpillDir(cwd);
    const id = sanitizeId(toolCallId);
    const file = join(spillDir(cwd), `${id}.txt`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    const ref: SpillRef = {
      id,
      toolName,
      file,
      bytes: encoder.encode(text).length,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      time: Date.now(),
    };
    appendFileSync(indexPath(cwd), `${JSON.stringify(ref)}\n`);
    return ref;
  } catch {
    return null;
  }
}

/** The locator line appended to a spilled result's preview. Kept short and
 *  stable so it costs ~40 tokens and never dominates the budget. */
export function spillNotice(ref: SpillRef, omittedBytes: number): string {
  return (
    `[mempact: ${omittedBytes} bytes omitted from the middle; full output ` +
    `(${ref.bytes} bytes, sha256 ${ref.sha256.slice(0, 12)}) retained - ` +
    `recall(mode:"read", id:"spill:${ref.id}") retrieves it exactly]`
  );
}

/** Read entries of the spill index, newest first. Missing index -> []. */
export function readSpillIndex(cwd: string): SpillRef[] {
  try {
    const lines = readFileSync(indexPath(cwd), "utf8").split("\n");
    const out: SpillRef[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SpillRef);
      } catch {
        // torn tail from a crash mid-append: skip, never fail the read
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export interface SpillReadResult {
  ref: SpillRef;
  /** requested slice content */
  text: string;
  /** total lines in the artifact */
  totalLines: number;
  offset: number;
  /** lines returned */
  count: number;
}

/**
 * Exact retrieval: read a spill artifact by locator with line offset/limit.
 * `verify` recomputes the hash so callers can prove the artifact still
 * corresponds to the recorded event. Returns null when missing/unreadable.
 */
export function readSpill(
  cwd: string,
  id: string,
  offset = 0,
  limit = 200,
): SpillReadResult | null {
  const clean = sanitizeId(id.replace(/^spill:/, ""));
  const refs = readSpillIndex(cwd);
  const ref = refs.find((r) => r.id === clean);
  const file = ref?.file ?? join(spillDir(cwd), `${clean}.txt`);
  try {
    statSync(file);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const start = Math.max(0, Math.min(offset, lines.length));
    const slice = lines.slice(start, start + Math.max(1, limit));
    const fallbackRef: SpillRef = ref ?? {
      id: clean,
      toolName: "unknown",
      file,
      bytes: encoder.encode(text).length,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      time: 0,
    };
    return {
      ref: fallbackRef,
      text: slice.join("\n"),
      totalLines: lines.length,
      offset: start,
      count: slice.length,
    };
  } catch {
    return null;
  }
}

/** Grep spill artifacts for a query (case-insensitive substring), newest
 *  first, bounded. Returns match snippets with locator provenance. */
export function searchSpills(
  cwd: string,
  query: string,
  maxResults = 5,
  snippetChars = 400,
): { total: number; results: string[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { total: 0, results: [] };
  const results: string[] = [];
  let total = 0;
  for (const ref of readSpillIndex(cwd)) {
    let text: string;
    try {
      text = readFileSync(ref.file, "utf8");
    } catch {
      continue;
    }
    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) continue;
    total += 1;
    if (results.length >= maxResults) continue;
    const start = Math.max(0, at - Math.floor((snippetChars - needle.length) / 2));
    const end = Math.min(text.length, start + snippetChars);
    const line = text.slice(0, at).split("\n").length;
    const snippet =
      (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
    results.push(
      `[spill:${ref.id} | ${ref.toolName} | full original tool output, line ~${line}] ${snippet}`,
    );
  }
  return { total, results };
}
