/**
 * Project-memory spine — the durable, plaintext, weak-model-proof context
 * layer that lives UNDER compaction. It is a plain markdown document with
 * fixed sections; it is re-injected into context every turn and is never
 * dropped by compaction. A resuming agent (or a lesser model handed only a
 * spec) reconstructs "where am I / what next" from this alone.
 *
 * Design lineage: Letta self-editing memory blocks + codex's CLAUDE.md-style
 * always-present anchor + the structured-handoff schemas (Hermes / Claude
 * Code / the Zaczero PREVIOUSLY-PARKED-CURRENT fix). Kept as a plain file so
 * it is inspectable, portable across any model, and editable section-wise so
 * a weak model can't mangle the whole thing with one bad write.
 */

/** Fixed sections, ordered as they render. `Next` is the single most
 *  load-bearing line for resumption, so it sits near the end where recency
 *  attention is strongest. */
export const MEMORY_SECTIONS = [
  "Goal",
  "Plan",
  "Decisions",
  "Files",
  "Next",
  "Open",
] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

const HINTS: Record<MemorySection, string> = {
  Goal: "The task / spec. The north star. Rarely changes.",
  Plan: "Checklist of steps. Mark [x] done, [ ] todo, [~] in-progress, [!] blocked.",
  Decisions: "Append-only log of choices + one-line rationale. Never rewrite past entries.",
  Files: "path - why it matters / its current state. One per line.",
  Next: "The exact next action, concrete enough to act on cold.",
  Open: "Open questions, blockers, things to verify.",
};

const HEADER = "# Project memory";

/** A fresh memory document, optionally seeded from a spec/goal string. */
export function emptyMemory(goal = ""): string {
  const body = MEMORY_SECTIONS.map((s) => {
    const seed = s === "Goal" ? goal.trim() : "";
    return `## ${s}\n<!-- ${HINTS[s]} -->\n${seed}\n`;
  }).join("\n");
  return `${HEADER}\n\n${body}`;
}

/** Split a memory doc into [section -> raw body] (body excludes the header line). */
function parseSections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = md.split(/^## /m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const name = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? "" : part.slice(nl + 1);
    out.set(name, body.replace(/\s+$/, ""));
  }
  return out;
}

/** Strip the `<!-- hint -->` comment line so we compare/return real content. */
function stripHint(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
    .join("\n")
    .trim();
}

export function getSection(md: string, name: MemorySection): string {
  return stripHint(parseSections(md).get(name) ?? "");
}

function rebuild(sections: Map<string, string>): string {
  const known = new Set<string>(MEMORY_SECTIONS);
  const body = MEMORY_SECTIONS.map(
    // stripHint: the parsed body still carries the old hint line; without
    // stripping, every write would duplicate hints in untouched sections
    (s) => `## ${s}\n<!-- ${HINTS[s]} -->\n${stripHint(sections.get(s) ?? "")}\n`,
  ).join("\n");
  const extras = [...sections.entries()]
    .filter(([name]) => !known.has(name))
    .map(([name, content]) => `## ${name}\n${content.trim()}\n`)
    .join("\n");
  return extras ? `${HEADER}\n\n${body}\n${extras}` : `${HEADER}\n\n${body}`;
}

/** Replace a section's body wholesale. */
export function setSection(md: string, name: MemorySection, body: string): string {
  const sections = parseSections(md);
  // preserve unknown sections a user may have added, but re-emit known ones in order
  sections.set(name, body.trim());
  return rebuild(sections);
}

/** Append a line to a section (used for the append-only Decisions log, or
 *  adding a file/plan item). No-ops on an empty line. */
export function appendToSection(md: string, name: MemorySection, line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return md;
  const current = getSection(md, name);
  const next = current ? `${current}\n${trimmed}` : trimmed;
  return setSection(md, name, next);
}

/** Sections longer than this render only their tail; the file keeps everything.
 *  Bounds the per-turn context cost of append-only sections (Decisions). */
const MAX_RENDER_LINES_PER_SECTION = 20;

/**
 * The block injected into the model's context every turn. Framed as
 * authoritative continuation state (the open-source proxy for codex's
 * "trusted encrypted state") so the model treats it as its own memory rather
 * than re-litigable user text. Hint comments are stripped and long sections
 * tail-capped, so the injected size is bounded regardless of file growth.
 */
export function renderForContext(md: string): string {
  const sections = parseSections(md);
  const names = [
    ...MEMORY_SECTIONS,
    ...[...sections.keys()].filter((n) => !(MEMORY_SECTIONS as readonly string[]).includes(n)),
  ];
  const body = names
    .map((name) => {
      const content = stripHint(sections.get(name) ?? "");
      const lines = content ? content.split("\n") : [];
      const shown =
        lines.length > MAX_RENDER_LINES_PER_SECTION
          ? [
              `(${lines.length - MAX_RENDER_LINES_PER_SECTION} older lines elided - full text in the memory file)`,
              ...lines.slice(-MAX_RENDER_LINES_PER_SECTION),
            ]
          : lines;
      return [`## ${name}`, ...shown].join("\n");
    })
    .join("\n\n");
  return [
    "<project_memory>",
    "Your durable working memory for this task. It SURVIVES context compaction -",
    "treat it as your own prior state, trust it, and keep it current via update_memory.",
    "If the conversation above was compacted, this plus the recent turns is your ground truth.",
    "",
    HEADER,
    "",
    body,
    "</project_memory>",
  ].join("\n");
}

/** Paths mentioned in the Files section — used to re-read touched files on
 *  resume (codex re-reads recently edited files after compaction). */
export function filesToRehydrate(md: string): string[] {
  return getSection(md, "Files")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").split(/\s+[—-]\s+/)[0]!.trim())
    .filter((p) => p.length > 0 && !p.startsWith("<!--"));
}
