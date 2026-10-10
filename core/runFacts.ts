/**
 * Deterministic command facts for the ledger: every shell-like tool run with
 * its command, sniffed exit code, and the line that names the error.
 * Summarizers drop these often, and code can read them straight off the
 * tool records.
 */

import { contentText } from "./items.ts";

export interface CommandFact {
  tool: string;
  command: string;
  /** sniffed exit code, if the output printed one */
  exit?: number;
  failed: boolean;
  /** the line that names the error, only when the run failed */
  error?: string;
  /** index of the toolResult message in the input */
  index: number;
}

const clipLine = (s: string, max = 200): string => {
  const first = (s.split("\n", 1)[0] ?? "").trim();
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
};

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

/** The most informative line of a failing output: the first typed error
 *  ("AssertionError: ...", "error[E0433]:", "panicked", "TS2345"), else the
 *  first line that names an error, else the first line. A test runner's
 *  "FAIL test/x > case" header comes before the line that says why. pi's bash
 *  appends "Command exited with code N" AFTER the body, so the first line
 *  alone is usually just a command echo. */
const errorLine = (text: string): string => {
  const lines = text.split("\n");
  const hit =
    lines.find((l) => /\w*(?:Error|Exception)\b:|\berror(?:\[\w+\])?:|\bpanicked\b|\bTS\d{4}\b/.test(l)) ??
    lines.find((l) => /\b(err|error|fail(ed|ure)?|exception|panic|traceback|fatal)\b/i.test(l));
  return clipLine(hit ?? text);
};

const RUN_TOOL = /bash|shell|exec|run|terminal|command/i;

/** Test/build/deploy family, matched as a whole command word so paths
 *  (`cat test/a.json`, `build.log`) and `git checkout` do not count. */
const SIGNIFICANT =
  /(?<![\w/.-])(?:test|vitest|jest|pytest|build|tsc|typecheck|lint|deploy|compile|check|install|migrate)(?![\w/.-])/i;

/**
 * Run-tool results (bash/shell/exec/terminal) newest first, one per distinct
 * command so a re-run replaces the earlier result: a failing `pnpm test`
 * followed by a passing one reads as passing. Over the cap, failures and
 * test/build commands win over housekeeping like `ls` or `git status`.
 */
export function collectCommands(messages: readonly MessageLike[], max = 20): CommandFact[] {
  const commandsById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as { type: string; id?: string; arguments?: Record<string, unknown> }[]) {
      if (block.type !== "toolCall" || !block.id) continue;
      const raw = block.arguments?.command ?? block.arguments?.cmd; // codex uses "cmd"
      const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(" ") : undefined;
      if (command) commandsById.set(block.id, command);
    }
  }

  const all: CommandFact[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    // only run output carries an exit status; a file read that contains
    // "exit 1" is file content
    if (m.role !== "toolResult" || !RUN_TOOL.test(m.toolName ?? "")) continue;
    const command = m.toolCallId ? commandsById.get(m.toolCallId) : undefined;
    if (!command || seen.has(command)) continue;
    seen.add(command);
    const text = contentText(m.content);
    const exit = sniffExit(text);
    const failed = m.isError === true || (exit != null && exit !== 0);
    all.push({ tool: m.toolName!, command: clipLine(command, 160), exit, failed, error: failed ? errorLine(text) : undefined, index: i });
  }
  const keep = new Set(all.filter((c) => c.failed || SIGNIFICANT.test(c.command)).slice(0, max));
  for (const c of all) if (keep.size < max) keep.add(c);
  return all.filter((c) => keep.has(c));
}
