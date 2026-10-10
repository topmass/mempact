/**
 * Deterministic run-state facts, appended to every compaction summary next
 * to the file lists: the last significant command and its result, the
 * newest unresolved error, and the user's latest request. Summarizers drop
 * these often, and code can read them straight off the tool records.
 */

import { contentText } from "./items.ts";

export interface RunFact {
  command: string;
  /** sniffed exit code, if the output printed one */
  exit?: number;
  isError: boolean;
  /** first line of the output */
  firstLine: string;
}

const clipLine = (s: string, max = 200): string => {
  const first = (s.split("\n", 1)[0] ?? "").trim();
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
};

const flatClip = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function runFactsBlock(facts: {
  lastRun?: RunFact;
  lastError?: string;
  lastUserMessage?: string;
}): string {
  const lines: string[] = [];
  if (facts.lastRun) {
    const { command, exit, isError } = facts.lastRun;
    const failed = isError || (exit != null && exit !== 0);
    lines.push(
      `<last-run>${command} -> ${failed ? `FAILED${exit != null ? ` (exit ${exit})` : ""}` : "succeeded"}</last-run>`,
    );
  }
  if (facts.lastError) lines.push(`<unresolved-error>${facts.lastError}</unresolved-error>`);
  // the retained history carries this verbatim but unlabeled, and resuming
  // models fumble which message is the live request
  if (facts.lastUserMessage && facts.lastUserMessage.trim())
    lines.push(`<latest-user-request>${flatClip(facts.lastUserMessage)}</latest-user-request>`);
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

const sniffExit = (text: string): number | undefined => {
  // "exit code: 1", "exited with code 0", "exit status 2". A bare "exit 1" is
  // usually a script body being printed, not a status. The last match wins:
  // pi's bash appends its status after the output.
  const m = [...text.matchAll(/exit(?:ed)?(?:\s+with)?\s+(?:code|status)[:=\s]+(-?\d+)/gi)].pop();
  return m ? Number(m[1]) : undefined;
};

/** The most informative line of a failing output: the first line that names
 *  an error, else the first line. pi's bash appends "Command exited with code
 *  N" AFTER the body, so the first line alone is usually just a command echo. */
const errorLine = (text: string): string => {
  const hit = text.split("\n").find((l) => /\b(err|error|fail(ed|ure)?|exception|panic|traceback|fatal)\b/i.test(l));
  return clipLine(hit ?? text);
};

const RUN_TOOL = /bash|shell|exec|run|terminal|command/i;

/** Test/build/deploy family, matched as a whole command word so paths
 *  (`cat test/a.json`, `build.log`) and `git checkout` do not count. */
const SIGNIFICANT =
  /(?<![\w/.-])(?:test|vitest|jest|pytest|build|tsc|typecheck|lint|deploy|compile|check|install|migrate)(?![\w/.-])/i;

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

  // Prefer the newest SIGNIFICANT command: the literal last command is often
  // housekeeping no honest summary would mention.
  let lastRun: RunFact | undefined;
  let significantRun: RunFact | undefined;
  let lastError: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "toolResult") continue;
    const text = contentText(m.content);
    const isRun = RUN_TOOL.test(m.toolName ?? "");
    if (lastError === undefined) {
      // only run output carries an exit status; a file read that contains
      // "exit 1" is file content
      const exit = isRun ? sniffExit(text) : undefined;
      if (m.isError || (exit != null && exit !== 0)) lastError = errorLine(text);
      // a successful read/grep/edit after a failed run does not resolve the
      // failure - only the newest successful RUN clears it
      else if (isRun) lastError = "";
    }
    if (!significantRun && isRun) {
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
