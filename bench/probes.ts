/**
 * Model-made probes for real transcripts, which have no planted facts. At
 * each compaction boundary the model reads the messages drained that round
 * and writes the questions a resuming agent would need answered, with
 * reference answers. Each condition answers every probe so far from its own
 * compacted context, and the model judges each answer against the reference.
 */

import type { Message } from "@earendil-works/pi-ai";
import { OverflowError } from "../core/pipeline.ts";
import { userMessage } from "./conditions.ts";

/** system prompt, messages, max tokens -> reply text; thinking off */
export type Ask = (systemPrompt: string, messages: Message[], maxTokens: number) => Promise<string>;

export const PROBE_KINDS = ["rationale", "rule", "state"] as const;
export interface Probe {
  kind: (typeof PROBE_KINDS)[number];
  question: string;
  answer: string;
  /** the round whose drained messages it came from */
  round: number;
}
export type Verdict = "correct" | "partial" | "wrong";
export const VERDICT_SCORE: Record<Verdict, number> = { correct: 1, partial: 0.5, wrong: 0 };

const MAX_PROBES = 8;
const UNSURE = /\b(?:unknown|unclear|uncertain|not sure|not stated|not specified)\b/i;

const PROBE_PROMPT = `The conversation above is one stretch of a coding session. The agent will soon lose it and keep only a compacted summary. Write up to ${MAX_PROBES} question/answer pairs that an agent resuming this session later would need answered, in three kinds:
- "rationale": why a decision was made, or what approach failed and why.
- "rule": something the user told the agent to do or never do, and whether it was later lifted.
- "state": which files were changed, the last failing command and its error, or the current goal.
Each question must stand alone: name the file, feature or command it is about, never "this" or "above". Each answer must be short, specific, and stated in the conversation. Skip anything you are not sure of. Do not invent.
Reply with only a JSON array: [{"kind": "rationale" | "rule" | "state", "question": "...", "answer": "..."}]`;

export function parseProbes(text: string, round: number): Probe[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p): p is Omit<Probe, "round"> =>
        PROBE_KINDS.includes(p?.kind) && typeof p.question === "string" && typeof p.answer === "string" && p.answer.trim().length >= 10 && !UNSURE.test(p.answer),
    )
    .slice(0, MAX_PROBES)
    .map((p) => ({ kind: p.kind, question: p.question.trim(), answer: p.answer.trim(), round }));
}

export async function generateProbes(ask: Ask, drained: Message[], round: number): Promise<Probe[]> {
  try {
    return parseProbes(await ask("", [...drained, userMessage(PROBE_PROMPT)], 2048), round);
  } catch (error) {
    if (error instanceof OverflowError) return [];
    throw error;
  }
}

const ANSWER_SYSTEM = "You are a coding agent resuming a session. Answer questions about the session from the conversation only.";
const JUDGE_SYSTEM = "You grade answers. Reply with exactly one word: correct, partial or wrong.";

export async function judge(ask: Ask, question: string, reference: string, candidate: string, criterion = "Does the candidate answer agree with the reference answer?"): Promise<Verdict> {
  if (!candidate.trim() || /^\W*unknown\b/i.test(candidate)) return "wrong";
  const reply = await ask(
    JUDGE_SYSTEM,
    [userMessage(`Question: ${question}\nReference: ${reference}\nCandidate: ${candidate}\n\n${criterion} Reply correct, partial (right but missing part of the reference), or wrong (contradicts it, or does not answer).`)],
    16,
  );
  return (/\b(correct|partial|wrong)\b/i.exec(reply)?.[1]?.toLowerCase() as Verdict | undefined) ?? "wrong";
}

/** Answer every probe back to back against one context (the server's prefix
 *  cache keeps it), then judge them. */
export async function scoreProbes(ask: Ask, context: readonly Message[], probes: readonly Probe[]): Promise<{ answers: string[]; verdicts: Verdict[] }> {
  const answers: string[] = [];
  for (const p of probes)
    answers.push(
      (await ask(ANSWER_SYSTEM, [...context, userMessage(`Question about this session: ${p.question}\nAnswer in one or two sentences from the context only. If the context does not say, reply "unknown".`)], 300)).trim(),
    );
  const verdicts: Verdict[] = [];
  for (const [i, p] of probes.entries()) verdicts.push(await judge(ask, p.question, p.answer, answers[i]!));
  return { answers, verdicts };
}

/** Mean score overall, per kind, and over probes from earlier rounds
 *  (facts that have survived at least one further compaction). */
export function probeMetrics(probes: readonly Probe[], verdicts: readonly Verdict[], round: number): Record<string, number | undefined> {
  const mean = (keep: (p: Probe) => boolean) => {
    const xs = probes.flatMap((p, i) => (keep(p) ? [VERDICT_SCORE[verdicts[i]!]] : []));
    return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  return {
    probe_count: probes.length,
    probe_score: mean(() => true),
    ...Object.fromEntries(PROBE_KINDS.map((k) => [`probe_score_${k}`, mean((p) => p.kind === k)])),
    probe_score_age1plus: mean((p) => p.round < round),
  };
}
