/**
 * Guards the verbatim-fidelity contract: the inlined prompt constants must
 * stay byte-identical to the vendored codex template files.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUMMARIZATION_PROMPT, SUMMARY_PREFIX } from "../core/prompts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("prompt constants match the vendored codex templates byte-for-byte", () => {
  it("SUMMARIZATION_PROMPT === reference prompt.md === core/prompts/prompt.md", () => {
    const reference = read("reference/codex-rs/prompts/templates/compact/prompt.md");
    expect(SUMMARIZATION_PROMPT).toBe(reference);
    expect(read("core/prompts/prompt.md")).toBe(reference);
  });

  it("SUMMARY_PREFIX === reference summary_prefix.md === core/prompts/summary_prefix.md", () => {
    const reference = read("reference/codex-rs/prompts/templates/compact/summary_prefix.md");
    expect(SUMMARY_PREFIX).toBe(reference);
    expect(read("core/prompts/summary_prefix.md")).toBe(reference);
  });
});
