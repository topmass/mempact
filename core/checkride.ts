/**
 * The handoff checkride - closed-loop compaction verification.
 *
 * A compaction is a shift change: the next context window knows only what
 * the handoff carries. Every system ships that handoff unverified. The
 * checkride quizzes the ACTUAL post-compaction context against facts the
 * harness knows deterministically (file ops, exit codes, the user's last
 * message, the memory file), grades by string containment, and escalates:
 * fail once -> regenerate the summary with MUST-PRESERVE lines; fail twice
 * -> splice the raw facts in mechanically. Compaction is never blocked.
 *
 * Design contract (the "standard process" any model can follow):
 * - Probe QUESTIONS are fixed templates authored here, never model-written.
 * - Ground truth comes ONLY from harness data, never from a model.
 * - Grading is mechanical containment of distinctive tokens - no LLM judge.
 * - A probe with no ground truth is skipped, never guessed.
 * - The quiz-taker may be arbitrarily weak; a weak reader failing the quiz
 *   is signal (the handoff must survive the weakest resuming model).
 */

// ---------------------------------------------------------------------------
// Facts - everything the harness knows to be true at compaction time
// ---------------------------------------------------------------------------

export interface RunFact {
  command: string;
  /** sniffed exit code, if the output printed one */
  exit?: number;
  isError: boolean;
  /** first line of the output */
  firstLine: string;
}

export interface HandoffFacts {
  modifiedFiles?: string[];
  lastRun?: RunFact;
  /** most recent unresolved error line (only when the newest result failed) */
  lastError?: string;
  lastUserMessage?: string;
  memoryNext?: string;
  /** checked-off plan items, e.g. lines starting "[x]" */
  memoryDoneItems?: string[];
  memoryDecisions?: string[];
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** Evidence = groups of alternatives; a group matches if ANY of its strings
 *  appears (case-insensitive) in the answer; the probe passes when at least
 *  `minGroups` groups match (default: all). */
export interface Probe {
  id: string;
  question: string;
  groups: string[][];
  minGroups: number;
  /** verbatim fact line used for MUST-PRESERVE retry and the splice block */
  preserveLine: string;
}

const STOPWORDS = new Set(
  ("the this that with from have will your please would could should about them then than what when " +
    "where which there here into just like some more very been were they their also only make sure " +
    "want need going think know really thing things right good well work works").split(" "),
);

/** Distinctive tokens of a text: path-ish/digit-ish first, then longest. */
export function rareTokens(text: string, max = 8): string[] {
  const tokens = text.match(/[A-Za-z0-9_./-]{4,}/g) ?? [];
  const uniq: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (!STOPWORDS.has(lower) && !uniq.some((u) => u.toLowerCase() === lower)) uniq.push(t);
  }
  const score = (t: string): number => (/[/._\d-]/.test(t) ? 100 : 0) + t.length;
  return uniq.sort((a, b) => score(b) - score(a)).slice(0, max);
}

const clipLine = (s: string, max = 200): string => {
  const first = (s.split("\n", 1)[0] ?? "").trim();
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
};

const tokenGroups = (text: string, fraction: number): { groups: string[][]; minGroups: number } => {
  const groups = rareTokens(text).map((t) => [t]);
  return { groups, minGroups: Math.max(1, Math.ceil(fraction * groups.length)) };
};

const SUCCESS_WORDS = ["succeed", "success", "passed", "pass", "exit 0", "exit code 0", "worked", "no error", "completed", "created", "done", "without error"];
const FAILURE_WORDS = ["fail", "error", "non-zero", "nonzero", "crash", "broke"];

/**
 * Build the checklist from available facts. Order matters: worst-measured
 * industry failure first. Probes without ground truth are simply absent.
 */
export function buildProbes(facts: HandoffFacts): Probe[] {
  const probes: Probe[] = [];

  if (facts.modifiedFiles && facts.modifiedFiles.length > 0) {
    const files = facts.modifiedFiles.slice(-10);
    probes.push({
      id: "files",
      question: "Which files have been created or modified during this task? List every path.",
      // basename counts: an answer listing "checkride.ts" carries the fact
      groups: files.map((f) => {
        const base = f.split("/").pop();
        return base && base !== f ? [f, base] : [f];
      }),
      // 80%: recalling 8+ of 10 paths is a working handoff; all-or-nothing
      // failed answers that listed 9/10 (batch eval)
      minGroups: Math.max(1, Math.ceil(files.length * 0.8)),
      preserveLine: `Modified files (list each explicitly): ${files.join(", ")}`,
    });
  }

  if (facts.lastRun) {
    const { command, exit, isError } = facts.lastRun;
    const failed = isError || (exit != null && exit !== 0);
    const statusWords = failed
      ? [...FAILURE_WORDS, ...(exit != null && exit !== 0 ? [`exit ${exit}`] : [])]
      : SUCCESS_WORDS;
    // any distinctive command token counts - no answer quotes a 160-char
    // pipeline verbatim (first eval run against qwen proved this)
    const commandAlts = [command, ...rareTokens(command, 3)];
    probes.push({
      id: "verify",
      question:
        "What was the last significant command run (for example a test, build, or deploy), and did it succeed or fail?",
      groups: [commandAlts, statusWords],
      minGroups: 2,
      preserveLine: `Last command run: \`${command}\` -> ${failed ? `FAILED${exit != null ? ` (exit ${exit})` : ""}` : "succeeded"}`,
    });
  }

  if (facts.lastError) {
    const line = clipLine(facts.lastError);
    probes.push({
      id: "error",
      question: "Quote the most recent unresolved error message, if any.",
      groups: [rareTokens(line, 4)],
      minGroups: 1,
      preserveLine: `Current unresolved error: ${line}`,
    });
  }

  if (facts.lastUserMessage && facts.lastUserMessage.trim()) {
    const { groups, minGroups } = tokenGroups(facts.lastUserMessage, 0.6);
    if (groups.length > 0)
      probes.push({
        id: "intent",
        // demands a QUOTE: paraphrases of generic sentences cannot pass
        // containment grading (batch eval on real transcripts proved this)
        question:
          "Find the LAST message written by the user in the record above and quote it word-for-word, or as close as possible.",
        groups,
        minGroups,
        preserveLine: `Latest user request (verbatim): "${clipLine(facts.lastUserMessage, 300)}"`,
      });
  }

  if (facts.memoryDoneItems && facts.memoryDoneItems.length > 0) {
    const pooled = facts.memoryDoneItems.flatMap((l) => rareTokens(l, 3));
    if (pooled.length > 0)
      probes.push({
        id: "done",
        question: "Name at least one piece of work that is already finished and must not be redone.",
        groups: pooled.map((t) => [t]),
        minGroups: Math.min(2, pooled.length),
        preserveLine: `Already completed (do NOT redo): ${facts.memoryDoneItems.map((l) => clipLine(l, 120)).join("; ")}`,
      });
  }

  if (facts.memoryNext && facts.memoryNext.trim()) {
    const { groups, minGroups } = tokenGroups(facts.memoryNext, 0.6);
    if (groups.length > 0)
      probes.push({
        id: "next",
        question: "What is the exact next action to take?",
        groups,
        minGroups,
        preserveLine: `Exact next step: ${clipLine(facts.memoryNext, 300)}`,
      });
  }

  if (facts.memoryDecisions && facts.memoryDecisions.length > 0) {
    const recent = facts.memoryDecisions.slice(-3);
    const pooled = recent.flatMap((l) => rareTokens(l, 3));
    if (pooled.length > 0)
      probes.push({
        id: "constraints",
        question: "What standing decisions or constraints must be respected?",
        groups: pooled.map((t) => [t]),
        minGroups: Math.max(1, Math.ceil(0.4 * pooled.length)),
        preserveLine: `Standing decisions/constraints: ${recent.map((l) => clipLine(l, 120)).join("; ")}`,
      });
  }

  return probes;
}

// ---------------------------------------------------------------------------
// The quiz
// ---------------------------------------------------------------------------

/** Sent as the final user message AFTER the assembled post-compaction
 *  context, so the quiz-taker is in exactly the next window's position. */
export const QUIZ_INSTRUCTION = [
  "You are resuming a task. The messages above are your ONLY record of the work so far.",
  "Answer the questions below using ONLY that record. Do not use outside knowledge. Do not guess.",
  "If the record does not contain an answer, reply UNKNOWN for that question.",
  "Answer in numbered lines, one per question. Be specific: include exact file paths, commands, and error text where relevant.",
  "When a question asks you to quote, copy the exact words from the record.",
].join("\n");

export function formatQuiz(probes: readonly Probe[]): string {
  const questions = probes.map((p, i) => `${i + 1}. ${p.question}`).join("\n");
  return `${QUIZ_INSTRUCTION}\n\n${questions}\n\nAnswers:`;
}

/** Mechanical grading: containment of evidence tokens in the full answer
 *  text (cross-question credit is intentional - the quiz tests whether the
 *  context CARRIES a fact, not answer formatting). */
export function gradeQuiz(
  probes: readonly Probe[],
  answerText: string,
): { passed: Probe[]; failed: Probe[]; score: number } {
  const haystack = answerText.toLowerCase();
  const passed: Probe[] = [];
  const failed: Probe[] = [];
  for (const probe of probes) {
    const matched = probe.groups.filter((g) => g.some((s) => haystack.includes(s.toLowerCase()))).length;
    (matched >= probe.minGroups ? passed : failed).push(probe);
  }
  return { passed, failed, score: probes.length === 0 ? 1 : passed.length / probes.length };
}

// ---------------------------------------------------------------------------
// Escalation - retry prompt section, then mechanical splice
// ---------------------------------------------------------------------------

/** Appended to the summarization prompt on the single retry. */
export function mustPreserveSection(failed: readonly Probe[]): string {
  const lines = failed.map((p) => `- ${p.preserveLine}`).join("\n");
  return `CRITICAL: your summary MUST explicitly and verbatim state the following facts (a handoff verification failed without them):\n${lines}`;
}

/** Last resort: the facts appended to the summary mechanically - no model
 *  cooperation required, so the facts get through even if the summarizer is
 *  hopeless. */
export function handoffFactsBlock(failed: readonly Probe[]): string {
  const lines = failed.map((p) => p.preserveLine).join("\n");
  return `<handoff_facts>\n${lines}\n</handoff_facts>`;
}

/**
 * Deterministic run-state splice, appended to EVERY summary alongside the
 * file lists. Sweep data (14 real sessions): mechanically spliced facts
 * scored ~100% while summarizer-carried run state scored 4/11 - so the run
 * facts get the same treatment as files.
 */
export function runFactsBlock(facts: { lastRun?: RunFact; lastError?: string }): string {
  const lines: string[] = [];
  if (facts.lastRun) {
    const { command, exit, isError } = facts.lastRun;
    const failed = isError || (exit != null && exit !== 0);
    lines.push(
      `<last-run>${command} -> ${failed ? `FAILED${exit != null ? ` (exit ${exit})` : ""}` : "succeeded"}</last-run>`,
    );
  }
  if (facts.lastError) lines.push(`<unresolved-error>${facts.lastError}</unresolved-error>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fact extraction from host-neutral messages (pi shapes fit structurally)
// ---------------------------------------------------------------------------

interface MessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

const textOfBlocks = (content: unknown): string =>
  Array.isArray(content)
    ? (content as { type: string; text?: string }[])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

const sniffExit = (text: string): number | undefined => {
  // matches "exit code: 1", "exit 0", "exited with code 0" (codex phrasing)
  const m = text.match(/exit(?:ed)?(?:\s+with)?(?:\s+code)?[:=\s]+(-?\d+)/i);
  return m ? Number(m[1]) : undefined;
};

/** Newest run-tool result (bash/shell/exec/terminal) with its command, plus
 *  the newest unresolved error (only if the last tool result failed). */
export function extractRunFacts(messages: readonly MessageLike[]): {
  lastRun?: RunFact;
  lastError?: string;
} {
  const commandsById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
      if (block.type !== "toolCall" || !block.id) continue;
      const raw = block.arguments?.command ?? block.arguments?.cmd; // codex uses "cmd"
      const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(" ") : undefined;
      if (command) commandsById.set(block.id, command);
    }
  }

  // Prefer the newest SIGNIFICANT command (test/build/deploy family): the
  // literal last command is often housekeeping trivia no honest summary
  // would mention (batch eval on real transcripts proved this).
  const SIGNIFICANT = /test|vitest|jest|pytest|build|tsc|typecheck|lint|deploy|compile|check|install|migrate/i;
  let lastRun: RunFact | undefined;
  let significantRun: RunFact | undefined;
  let lastError: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "toolResult") continue;
    const text = textOfBlocks(m.content);
    if (lastError === undefined) {
      const exit = sniffExit(text);
      if (m.isError || (exit != null && exit !== 0)) lastError = clipLine(text);
      else lastError = ""; // newest result is fine -> no unresolved error
    }
    if (!significantRun && /bash|shell|exec|run|terminal|command/i.test(m.toolName ?? "")) {
      const command = (m.toolCallId && commandsById.get(m.toolCallId)) || undefined;
      if (command) {
        const run: RunFact = {
          command: clipLine(command, 160),
          exit: sniffExit(text),
          isError: m.isError ?? false,
          firstLine: clipLine(text),
        };
        lastRun ??= run;
        if (SIGNIFICANT.test(command)) significantRun = run;
      }
    }
    if (significantRun && lastError !== undefined) break;
  }
  return { lastRun: significantRun ?? lastRun, lastError: lastError || undefined };
}
