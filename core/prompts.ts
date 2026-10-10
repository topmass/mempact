/**
 * Ported from codex-rs/prompts/templates/compact/summary_prefix.md, the
 * bridge text that introduces a summary. codex's summarization prompt was
 * replaced by the structured narrative in core/summarySchema.ts.
 *
 * The constant MUST stay byte-identical to core/prompts/summary_prefix.md
 * (the verbatim template copy); test/prompts.test.ts enforces this. It is
 * inlined because Rust's include_str! has no jiti equivalent.
 */

// codex-rs/prompts/templates/compact/summary_prefix.md (no trailing newline in the template)
export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;
