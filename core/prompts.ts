/**
 * Ported from codex-rs/prompts/src/compact.rs and
 * codex-rs/prompts/templates/compact/{prompt.md,summary_prefix.md}.
 *
 * The string constants below MUST stay byte-identical to
 * core/prompts/prompt.md and core/prompts/summary_prefix.md (the verbatim
 * template copies); test/prompts.test.ts enforces this. They are inlined
 * because Rust's include_str! has no jiti equivalent.
 */

// codex-rs/prompts/templates/compact/prompt.md (trailing newline included, as include_str! sees it)
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`;

// codex-rs/prompts/templates/compact/summary_prefix.md (no trailing newline in the template)
export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;
