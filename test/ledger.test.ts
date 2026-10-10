import { describe, expect, it } from "vitest";
import { summaryBridgeText } from "../core/compact.ts";
import { buildLedger, renderLedger } from "../core/ledger.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, toolName: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  isError: false,
  content: [{ type: "text", text }],
});

describe("buildLedger", () => {
  it("collects files, commands, constraints, anchors and the latest request with source indexes", () => {
    const ledger = buildLedger([
      user("Fix PR #1234. Never use npm in this repo."),
      call("a", "edit", { path: "src/a.ts" }),
      call("b", "bash", { command: "pnpm test" }),
      result("b", "bash", "FAIL x\nexit code: 1"),
      user("now the docs"),
    ]);
    expect(ledger.modifiedFiles).toEqual(["src/a.ts"]);
    expect(ledger.commands[0]).toMatchObject({ command: "pnpm test", exit: 1, failed: true, index: 3 });
    expect(ledger.constraints).toEqual([{ text: "Never use npm in this repo.", index: 0, superseded: false }]);
    expect(ledger.anchors).toContain("#1234");
    expect(ledger.latestUserRequest).toBe("now the docs");
  });

  it("ignores a previous summary, so its facts cannot cascade", () => {
    const oldSummary = summaryBridgeText("narrative\n<user-constraints>\n- Never touch prod.\n</user-constraints>\nhttps://stale.example/x");
    const ledger = buildLedger([user(oldSummary), user("hello there")]);
    expect(ledger.constraints).toEqual([]);
    expect(ledger.anchors).toEqual([]);
    expect(ledger.latestUserRequest).toBe("hello there");
  });

  it("marks a constraint superseded by a reversal, not by a repeat or a goal change", () => {
    const reversed = buildLedger([user("Never use npm."), user("You can use npm now.")]);
    expect(reversed.constraints[0]).toMatchObject({ text: "Never use npm.", superseded: true });

    const repeated = buildLedger([user("Never use npm."), user("Never use npm, I said.")]);
    expect(repeated.constraints.every((c) => !c.superseded)).toBe(true);

    const restated = buildLedger([user("Never use npm."), user("You can use npm now."), user("Never use npm.")]);
    expect(restated.constraints.find((c) => c.text === "Never use npm.")).toMatchObject({ index: 2, superseded: false });

    const pivot = buildLedger([user("Always write tests first."), user("Scratch that, new plan: just prototype.")]);
    expect(pivot.constraints[0]!.superseded).toBe(false);
    expect(pivot.goalChanges).toEqual([{ text: "Scratch that, new plan: just prototype.", index: 1 }]);
  });
});

describe("renderLedger", () => {
  it("renders a fixed section order and marks superseded constraints", () => {
    const out = renderLedger(
      buildLedger([user("Never use npm."), user("You can use npm now."), call("a", "edit", { path: "b.ts" })]),
    );
    expect(out.startsWith("<ledger>\n")).toBe(true);
    expect(out.indexOf("<modified-files>")).toBeLessThan(out.indexOf("<user-constraints>"));
    expect(out.indexOf("<user-constraints>")).toBeLessThan(out.indexOf("<latest-user-request>"));
    expect(out).toContain("- (superseded by a later user message) Never use npm.");
    expect(renderLedger(buildLedger([]))).toBe("");
  });
});
