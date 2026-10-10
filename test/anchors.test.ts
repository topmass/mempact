import { describe, expect, it } from "vitest";
import {
  collectAnchors,
  collectUserConstraints,
  renderAnchors,
  renderUserConstraints,
} from "../core/anchors.ts";

const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });

describe("anchor index", () => {
  it("extracts URLs, SHAs, PR refs, identifiers and errno names, ranked by messages mentioning them", () => {
    const anchors = collectAnchors([
      msg("user", "look at https://github.com/o/r/pull/42 (issue 42) and commit d2912a4f"),
      msg("toolResult", "Error: ECONNREFUSED 127.0.0.1:5199\nsee PR #42\nCLERK_ALLOWED_ORIGINS unset"),
      msg("assistant", "PR #42 is the one; d2912a4f reverted it; error TS2304"),
    ]);
    expect(anchors[0]).toBe("#42"); // 3 messages; "issue 42" / "PR #42" / "#42" normalize to one token
    expect(anchors).toContain("https://github.com/o/r/pull/42");
    expect(anchors).toContain("d2912a4f");
    expect(anchors).toContain("ECONNREFUSED");
    expect(anchors).toContain("CLERK_ALLOWED_ORIGINS");
    expect(anchors).toContain("TS2304");
  });

  it("ignores shouting words, short hex, and UUID fragments", () => {
    const anchors = collectAnchors([
      msg("user", "IMPORTANT: session 0b2c332d-123a-417c-af0d-75d3d8188aff FAILED at abc123"),
    ]);
    expect(anchors).toEqual([]);
  });

  it("caps the index and counts a token once per message", () => {
    const flood = msg("toolResult", Array.from({ length: 50 }, () => "https://x.io/a").join("\n"));
    const anchors = collectAnchors([flood, msg("user", "https://x.io/b"), msg("assistant", "https://x.io/b")]);
    expect(anchors[0]).toBe("https://x.io/b"); // 2 messages beat 50 mentions in one
    expect(collectAnchors(Array.from({ length: 30 }, (_, i) => msg("user", `https://x.io/${i}`)))).toHaveLength(12);
  });
});

describe("user constraints", () => {
  it("keeps rule-shaped sentences verbatim, unwraps hard-wrapped prose, skips questions and rambles", () => {
    const rules = collectUserConstraints([
      "Never start a second dev server beside a running\ncontainer (`just host-dev` refuses; do not bypass).\n\nShould I also restart it? Only touch src/.",
      `I don't know, ${"blah ".repeat(60)}`,
    ]);
    expect(rules).toEqual([
      "Never start a second dev server beside a running container (`just host-dev` refuses; do not bypass).",
      "Only touch src/.",
    ]);
  });

  it("ignores rule words that do not start the sentence, and reassurance", () => {
    expect(
      collectUserConstraints([
        "I don't know why the build fails now. We must have broken something. Don't worry about the lint warnings.",
        "TypeError: value must not be null",
      ]),
    ).toEqual([]);
    expect(collectUserConstraints(["Please don't push to main. You must run tests first."])).toEqual([
      "Please don't push to main.",
      "You must run tests first.",
    ]);
  });

  it("merges cumulatively with dedup and keeps the newest on overflow", () => {
    const prev = ["Do not merge without approval."];
    const rules = collectUserConstraints(["Do not merge without approval. Always run tests first."], prev);
    expect(rules).toEqual(["Do not merge without approval.", "Always run tests first."]);
    const many = Array.from({ length: 20 }, (_, i) => `Never touch file${i}.`);
    expect(collectUserConstraints(many)).toHaveLength(16);
    expect(collectUserConstraints(many)[15]).toBe("Never touch file19.");
  });

  it("renders tag blocks, empty when nothing found", () => {
    expect(renderAnchors([])).toBe("");
    expect(renderUserConstraints([])).toBe("");
    expect(renderAnchors(["#42"])).toBe("<anchors>\n#42\n</anchors>");
    expect(renderUserConstraints(["Never X."])).toBe("<user-constraints>\n- Never X.\n</user-constraints>");
  });
});

describe("anchor ranking", () => {
  it("weights conversation over tool output", () => {
    const ranked = collectAnchors([
      msg("toolResult", "https://ci.io/run/1\nhttps://ci.io/run/2"),
      msg("assistant", "the fix is in https://ci.io/run/2"),
    ]);
    expect(ranked[0]).toBe("https://ci.io/run/2");
  });

  it("skips hex colors, HTML entities, and word-plus-number hex", () => {
    const anchors = collectAnchors([
      msg("user", "set color: #123456; and #ff00aa80, star is &#42; and cafe123 facade1 ok"),
    ]);
    expect(anchors).toEqual([]);
    expect(collectAnchors([msg("user", "fixed in topmass/mempact#87 and (#91)")])).toEqual(["#87", "#91"]);
  });
});
