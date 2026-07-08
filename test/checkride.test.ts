import { describe, expect, it } from "vitest";
import {
  buildProbes,
  extractRunFacts,
  formatQuiz,
  gradeQuiz,
  handoffFactsBlock,
  mustPreserveSection,
  rareTokens,
} from "../core/checkride.ts";

describe("checkride probes", () => {
  it("builds only probes with ground truth, ordered files-first", () => {
    const probes = buildProbes({
      modifiedFiles: ["src/a.ts"],
      lastUserMessage: "please wire the compaction checkride into the extension",
    });
    expect(probes.map((p) => p.id)).toEqual(["files", "intent"]);
  });

  it("no facts, no probes", () => {
    expect(buildProbes({})).toEqual([]);
  });

  it("files probe requires every path", () => {
    const [probe] = buildProbes({ modifiedFiles: ["src/a.ts", "src/b.ts"] });
    expect(gradeQuiz([probe!], "1. modified src/a.ts and src/b.ts").failed).toHaveLength(0);
    expect(gradeQuiz([probe!], "1. modified src/a.ts only").failed).toHaveLength(1);
  });

  it("verify probe needs the command AND correct status family", () => {
    const [probe] = buildProbes({
      lastRun: { command: "pnpm vitest run", exit: 1, isError: false, firstLine: "..." },
    });
    expect(gradeQuiz([probe!], "1. ran pnpm vitest run and it failed").failed).toHaveLength(0);
    expect(gradeQuiz([probe!], "1. ran vitest, it passed cleanly").failed).toHaveLength(1);
    expect(gradeQuiz([probe!], "1. something failed").failed).toHaveLength(1);
  });

  it("intent probe passes on close paraphrase, fails on UNKNOWN", () => {
    const [probe] = buildProbes({
      lastUserMessage: "add the recall tool over the session history and commit it",
    });
    expect(
      gradeQuiz([probe!], "1. the user asked to add a recall tool searching session history and commit").failed,
    ).toHaveLength(0);
    expect(gradeQuiz([probe!], "1. UNKNOWN").failed).toHaveLength(1);
  });

  it("score reflects passed/asked", () => {
    const probes = buildProbes({
      modifiedFiles: ["x.ts"],
      memoryNext: "run the eval against qwen and record scores",
    });
    const { score } = gradeQuiz(probes, "1. x.ts was modified 2. UNKNOWN");
    expect(score).toBe(0.5);
  });

  it("quiz text carries instruction, numbered questions, UNKNOWN escape", () => {
    const probes = buildProbes({ modifiedFiles: ["a.ts"] });
    const quiz = formatQuiz(probes);
    expect(quiz).toContain("ONLY that record");
    expect(quiz).toContain("1. Which files");
    expect(quiz).toContain("UNKNOWN");
  });

  it("escalation templates carry the verbatim facts", () => {
    const probes = buildProbes({ modifiedFiles: ["core/x.ts"] });
    expect(mustPreserveSection(probes)).toContain("MUST explicitly");
    expect(mustPreserveSection(probes)).toContain("core/x.ts");
    expect(handoffFactsBlock(probes)).toContain("<handoff_facts>");
    expect(handoffFactsBlock(probes)).toContain("core/x.ts");
  });
});

describe("rareTokens", () => {
  it("prefers paths and digits, dedupes, skips stopwords", () => {
    const t = rareTokens("please make sure the file src/auth.ts returns exit 0 the file src/auth.ts");
    expect(t[0]).toBe("src/auth.ts");
    expect(t.filter((x) => x === "src/auth.ts")).toHaveLength(1);
    expect(t).not.toContain("please");
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

  it("a healthy newest result clears lastError", () => {
    const ok = [...messages, { role: "toolResult", toolCallId: "c2", toolName: "read", isError: false, content: [{ type: "text", text: "file contents" }] }];
    expect(extractRunFacts(ok).lastError).toBeUndefined();
  });

  it("prefers the newest significant command over housekeeping trivia", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm vitest run" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: "all passed\nexit code: 0" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "gh pr ready 1400 --undo | tail -1" } }] },
      { role: "toolResult", toolCallId: "t2", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] },
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
