import { describe, expect, it } from "vitest";
import { collectCommands } from "../core/runFacts.ts";

const run = (id: string, command: string, text: string, isError = false, toolName = "bash") => [
  { role: "assistant", content: [{ type: "toolCall", id, name: toolName, arguments: { command } }] },
  { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] },
];

describe("collectCommands", () => {
  it("records command, sniffed exit, and the typed error over a FAIL header", () => {
    const [c] = collectCommands(run("c1", "pnpm test", "> vitest run\n\n FAIL  test/x.test.ts > adds\nAssertionError: x\n\nCommand exited with code 1"));
    expect(c).toMatchObject({ tool: "bash", command: "pnpm test", exit: 1, failed: true, error: "AssertionError: x", index: 1 });
    const [d] = collectCommands(run("c2", "make", "make: *** [all] failed\nCommand exited with code 2"));
    expect(d!.error).toBe("make: *** [all] failed");
  });

  it("keeps only the newest result of a re-run command, newest first", () => {
    const cmds = collectCommands([...run("a", "pnpm test", "3 failed\nexit code: 1"), ...run("b", "ls", "x"), ...run("c", "pnpm test", "all green")]);
    expect(cmds.map((c) => [c.command, c.failed])).toEqual([["pnpm test", false], ["ls", false]]);
  });

  it("uses the last exit status in the output and ignores non-run tools", () => {
    const cmds = collectCommands([
      ...run("a", "make", "previous run: exit code: 1\nexit code: 0"),
      ...run("b", "x", "exit code: 1", false, "read"),
    ]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ exit: 0, failed: false });
  });

  it("handles codex shapes: cmd key and 'exited with code' phrasing", () => {
    const codex = [
      { role: "assistant", content: [{ type: "toolCall", id: "x1", name: "exec_command", arguments: { cmd: "rg --files" } }] },
      { role: "toolResult", toolCallId: "x1", toolName: "exec_command", isError: false, content: [{ type: "text", text: "Process exited with code 1\nno matches" }] },
    ];
    expect(collectCommands(codex)[0]).toMatchObject({ command: "rg --files", exit: 1 });
  });

  it("over the cap, test and build runs beat housekeeping", () => {
    const msgs = [...run("t", "pnpm vitest run", "ok"), ...run("a", "ls", "x"), ...run("b", "cat test/a.json", "x"), ...run("c", "git checkout main", "x")];
    expect(collectCommands(msgs, 2).map((c) => c.command)).toEqual(["git checkout main", "pnpm vitest run"]);
  });
});
