import { describe, expect, it } from "vitest";
import { extractRunFacts, runFactsBlock } from "../core/runFacts.ts";

describe("runFactsBlock", () => {
  it("renders last run, unresolved error, and labeled user request", () => {
    const block = runFactsBlock({
      lastRun: { command: "pnpm test", exit: 1, isError: false, firstLine: "3 failed" },
      lastError: "3 failed",
      lastUserMessage: "fix the failing\n  auth test please",
    });
    expect(block).toBe(
      "<last-run>pnpm test -> FAILED (exit 1)</last-run>\n<unresolved-error>3 failed</unresolved-error>\n<latest-user-request>fix the failing auth test please</latest-user-request>",
    );
    expect(runFactsBlock({})).toBe("");
  });
});

describe("extractRunFacts", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm test" } }],
    },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "3 failed\nexit code: 1" }] },
  ];

  it("finds the newest run with sniffed exit and flags the unresolved error", () => {
    const { lastRun, lastError } = extractRunFacts(messages);
    expect(lastRun).toMatchObject({ command: "pnpm test", exit: 1 });
    expect(lastError).toBe("3 failed");
  });

  it("a healthy newest RUN clears lastError", () => {
    const ok = [...messages, { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "all green" }] }];
    expect(extractRunFacts(ok).lastError).toBeUndefined();
  });

  it("a read after a failed run does not resolve the failure", () => {
    const investigating = [...messages, { role: "toolResult", toolCallId: "c2", toolName: "read", isError: false, content: [{ type: "text", text: "file contents" }] }];
    expect(extractRunFacts(investigating).lastError).toBe("3 failed");
  });

  it("a file read containing an exit status is file content, not a failure", () => {
    const passed = [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm test" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: "all passed" }] },
      { role: "toolResult", toolCallId: "t2", toolName: "read", isError: false, content: [{ type: "text", text: "#!/bin/sh\necho deploying\nexit code: 1" }] },
    ];
    expect(extractRunFacts(passed).lastError).toBeUndefined();
  });

  it("uses the last exit status in the output", () => {
    const echoed = [
      messages[0]!,
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "previous run: exit code: 1\nall green\nexit code: 0" }] },
    ];
    expect(extractRunFacts(echoed)).toMatchObject({ lastRun: { exit: 0 }, lastError: undefined });
  });

  it("picks the line that names the error, not the command echo (pi bash puts the exit status last)", () => {
    const piShape = [
      messages[0]!,
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "> mempact@0.2.0 test\n> vitest run\n\n FAIL  test/x.test.ts > adds\nAssertionError: expected 1 to be 2\n\nCommand exited with code 1" }] },
    ];
    expect(extractRunFacts(piShape).lastError).toBe("FAIL  test/x.test.ts > adds");
  });

  it("prefers the newest significant command over housekeeping, and paths or checkout are not significant", () => {
    const run = (id: string, command: string) => [
      { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
      { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
    ];
    const msgs = [
      ...run("t1", "pnpm vitest run"),
      ...run("t2", "gh pr ready 1400 --undo | tail -1"),
      ...run("t3", "cat test/fixtures/a.json"),
      ...run("t4", "git checkout main"),
    ];
    expect(extractRunFacts(msgs).lastRun?.command).toBe("pnpm vitest run");
  });

  it("handles codex shapes: cmd key and 'exited with code' phrasing", () => {
    const codex = [
      { role: "assistant", content: [{ type: "toolCall", id: "x1", name: "exec_command", arguments: { cmd: "rg --files" } }] },
      { role: "toolResult", toolCallId: "x1", toolName: "exec_command", isError: false, content: [{ type: "text", text: "Process exited with code 1\nno matches" }] },
    ];
    const { lastRun } = extractRunFacts(codex);
    expect(lastRun).toMatchObject({ command: "rg --files", exit: 1 });
  });
});
