/**
 * Guards the verbatim-fidelity contract: the inlined bridge text must stay
 * byte-identical to the vendored codex template file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUMMARY_PREFIX } from "../core/prompts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the bridge constant matches the vendored codex templates byte-for-byte", () => {
  it("SUMMARY_PREFIX === reference summary_prefix.md === core/prompts/summary_prefix.md", () => {
    const reference = read("reference/codex-rs/prompts/templates/compact/summary_prefix.md");
    expect(SUMMARY_PREFIX).toBe(reference);
    expect(read("core/prompts/summary_prefix.md")).toBe(reference);
  });
});
