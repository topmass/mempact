import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readSpill,
  readSpillIndex,
  sanitizeId,
  searchSpills,
  spillDir,
  spillFullOutput,
  spillNotice,
} from "../core/spill.ts";
import { truncateMiddleChars } from "../core/truncate.ts";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mempact-spill-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const MARKER = "UNIQUE-MARKER-ZEBRA-9137-XRAY";

function bigTextWithMiddleMarker(lines = 1400): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(`line ${String(i).padStart(5, "0")} ${"x".repeat(60)}`);
  out[Math.floor(lines / 2)] = `line 00700 ${MARKER} buried deep in the middle`;
  return out.join("\n");
}

describe("sanitizeId", () => {
  it("keeps safe chars and escapes the rest injectively", () => {
    expect(sanitizeId("call_abc-123.XY")).toBe("call_abc-123.XY");
    expect(sanitizeId("a/b")).not.toBe(sanitizeId("a_b"));
    expect(sanitizeId("../../etc/passwd")).not.toContain("/");
    expect(sanitizeId("..")).not.toBe("..");
  });
});

describe("spillFullOutput", () => {
  it("persists the exact bytes with hash and byte count", () => {
    const text = bigTextWithMiddleMarker();
    const ref = spillFullOutput(cwd, "call-1", "bash", text)!;
    expect(ref).not.toBeNull();
    expect(readFileSync(ref.file, "utf8")).toBe(text);
    expect(ref.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    // no tmp litter left behind (atomic rename)
    expect(readdirSync(spillDir(cwd)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes a .gitignore protecting the spill dir", () => {
    spillFullOutput(cwd, "c", "bash", "x");
    const gi = readFileSync(join(cwd, ".mempact", ".gitignore"), "utf8");
    expect(gi).toContain("spill/");
  });

  it("does not duplicate the gitignore line and preserves user content", () => {
    spillFullOutput(cwd, "c1", "bash", "x");
    appendFileSync(join(cwd, ".mempact", ".gitignore"), "custom-line\n");
    spillFullOutput(cwd, "c2", "bash", "y");
    const gi = readFileSync(join(cwd, ".mempact", ".gitignore"), "utf8");
    expect(gi.split("\n").filter((l) => l.trim() === "spill/")).toHaveLength(1);
    expect(gi).toContain("custom-line");
  });

  it("fails open (returns null) when the target is not writable", () => {
    // a FILE at .mempact makes mkdir fail
    writeFileSync(join(cwd, ".mempact"), "not a dir");
    const ref = spillFullOutput(cwd, "call-1", "bash", "text");
    expect(ref).toBeNull();
  });

  it("preserves multi-byte UTF-8 exactly", () => {
    const text = `héllo ${"🦓".repeat(1000)} — ${MARKER} — ${"字".repeat(1000)}`;
    const ref = spillFullOutput(cwd, "call-utf8", "bash", text)!;
    expect(readFileSync(ref.file, "utf8")).toBe(text);
    expect(ref.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });
});

describe("middle-of-output recovery (definition-of-done #1, unit level)", () => {
  it("recovers a marker the preview cap destroyed", () => {
    const text = bigTextWithMiddleMarker();
    const preview = truncateMiddleChars(text, 10_000);
    expect(preview).not.toContain(MARKER); // the old behavior lost it
    const ref = spillFullOutput(cwd, "call-mid", "bash", text)!;
    // search finds it with provenance
    const { total, results } = searchSpills(cwd, MARKER);
    expect(total).toBe(1);
    expect(results[0]).toContain("spill:call-mid");
    expect(results[0]).toContain(MARKER);
    // exact read returns the original line verbatim
    const line = Number(/line ~(\d+)/.exec(results[0])![1]);
    const read = readSpill(cwd, `spill:${ref.id}`, line - 2, 4)!;
    expect(read.text).toContain(`${MARKER} buried deep in the middle`);
    expect(read.ref.sha256).toBe(ref.sha256);
  });

  it("survives a simulated process restart (fresh read of index from disk)", () => {
    const text = bigTextWithMiddleMarker();
    spillFullOutput(cwd, "call-restart", "bash", text);
    // a new "process" only has cwd - index and artifact must be self-sufficient
    const refs = readSpillIndex(cwd);
    expect(refs).toHaveLength(1);
    const read = readSpill(cwd, refs[0]!.id, 0, 2000)!;
    expect(read.text).toContain(MARKER);
  });
});

describe("readSpill", () => {
  it("honors offset/limit line windows", () => {
    const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
    spillFullOutput(cwd, "call-win", "bash", text);
    const r = readSpill(cwd, "call-win", 40, 5)!;
    expect(r.text).toBe("L40\nL41\nL42\nL43\nL44");
    expect(r.totalLines).toBe(100);
    expect(r.offset).toBe(40);
    expect(r.count).toBe(5);
  });

  it("clamps offset past the end and returns null for missing artifacts", () => {
    spillFullOutput(cwd, "call-x", "bash", "a\nb");
    expect(readSpill(cwd, "call-x", 999, 10)!.count).toBe(0);
    expect(readSpill(cwd, "spill:nope", 0, 10)).toBeNull();
  });
});

describe("readSpillIndex", () => {
  it("returns newest first and skips a torn trailing line", () => {
    spillFullOutput(cwd, "old", "bash", "old text");
    spillFullOutput(cwd, "new", "bash", "new text");
    appendFileSync(join(spillDir(cwd), "index.jsonl"), '{"id":"torn"');
    const refs = readSpillIndex(cwd);
    expect(refs.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("returns [] when nothing was ever spilled", () => {
    expect(readSpillIndex(cwd)).toEqual([]);
  });
});

describe("searchSpills", () => {
  it("is case-insensitive, newest-first, and bounded", () => {
    for (let i = 0; i < 8; i++) spillFullOutput(cwd, `c${i}`, "bash", `needle-${i} HAYSTACK`);
    const { total, results } = searchSpills(cwd, "haystack", 3);
    expect(total).toBe(8);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("spill:c7");
  });

  it("returns nothing for empty queries", () => {
    spillFullOutput(cwd, "c", "bash", "text");
    expect(searchSpills(cwd, "  ").total).toBe(0);
  });
});

describe("spillNotice", () => {
  it("carries locator, byte count, hash prefix and omitted count", () => {
    const ref = spillFullOutput(cwd, "call-n", "bash", "some text")!;
    const notice = spillNotice(ref, 12345);
    expect(notice).toContain('recall(mode:"read", id:"spill:call-n")');
    expect(notice).toContain("12345 bytes omitted");
    expect(notice).toContain(ref.sha256.slice(0, 12));
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThan(300);
  });
});
