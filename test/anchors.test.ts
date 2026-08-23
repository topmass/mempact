import { describe, expect, it } from "vitest";
import { collectAnchors, renderAnchors } from "../core/anchors.ts";

const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });

describe("anchor index (hermes lineage - mechanical needle-fact harvest)", () => {
  it("harvests commit SHAs, refs, files, urls, and error lines", () => {
    const a = collectAnchors([
      msg("assistant", "committed as 99e56e1af5 and pushed"),
      msg("toolResult", "Fixes #17251 via src/core/compact.ts and docs/notes.md"),
      msg("user", "see https://github.com/topmass/mempact/issues/42 please"),
      msg("toolResult", "Error: ENOENT no such file src/missing.ts\nall good otherwise"),
    ]);
    expect(a.commits).toEqual(["99e56e1af5"]);
    expect(a.refs).toEqual(["#17251"]);
    expect(a.files).toContain("src/core/compact.ts");
    expect(a.files).toContain("docs/notes.md");
    expect(a.urls[0]).toContain("github.com/topmass/mempact/issues/42");
    expect(a.errors[0]).toContain("ENOENT");
  });

  it("rejects pure-digit and pure-letter hex lookalikes", () => {
    const a = collectAnchors([msg("user", "call 12345678 or word abcdefab beefed99")]);
    expect(a.commits).toEqual(["beefed99"]);
  });

  it("dedups keeping the newest occurrence and caps per category", () => {
    const msgs = [];
    for (let i = 0; i < 30; i++) msgs.push(msg("toolResult", `touched pkg/f${i}.ts and pkg/f0.ts`));
    const a = collectAnchors(msgs);
    expect(a.files.length).toBeLessThanOrEqual(24);
    // f0 re-touched at the end stays; earliest-only files dropped first
    expect(a.files).toContain("pkg/f0.ts");
    expect(a.files).toContain("pkg/f29.ts");
    expect(a.files).not.toContain("pkg/f1.ts");
  });

  it("does not misfile URLs as file paths", () => {
    const a = collectAnchors([msg("user", "read https://example.com/a/b.html first")]);
    expect(a.files).toEqual([]);
    expect(a.urls).toEqual(["https://example.com/a/b.html"]);
  });

  it("clips error lines and skips trivial ones", () => {
    const a = collectAnchors([
      msg("toolResult", `TypeError: ${"x".repeat(300)}`),
      msg("toolResult", "error"),
    ]);
    expect(a.errors).toHaveLength(1);
    expect(a.errors[0]!.length).toBeLessThanOrEqual(140);
  });

  it("renders a bounded tag block, empty when nothing found", () => {
    expect(renderAnchors(collectAnchors([msg("user", "hello there")]))).toBe("");
    const block = renderAnchors(
      collectAnchors([msg("assistant", "fixed in deadbee1, see src/a/b.ts and #1234")]),
    );
    expect(block.startsWith("<anchor-index>")).toBe(true);
    expect(block).toContain("commits: deadbee1");
    expect(block).toContain("refs: #1234");
    expect(block.endsWith("</anchor-index>")).toBe(true);
    expect(block.length).toBeLessThan(2100);
  });
});
