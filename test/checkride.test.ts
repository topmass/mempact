import { describe, expect, it } from "vitest";
import {
  buildProbes,
  extractRunFacts,
  formatQuiz,
  gradeQuiz,
  handoffFactsBlock,
  mustPreserveSection,
  rareTokens,
  runFactsBlock,
} from "../core/checkride.ts";

describe("checkride probes", () => {
  it("builds only probes with ground truth, ordered files-first", () => {
    const probes = buildProbes({
      modifiedFiles: ["src/a.ts"],
      lastUserMessage: "please wire the compaction checkride into the extension",
    });
    expect(probes.map((p) => p.id)).toEqual(["files", "intent"]);
  });

  it("rules probe cannot be satisfied by one rule when all share a leading word", () => {
    const [probe] = buildProbes({
      userConstraints: [
        "Never edit files under vendor/.",
        "Never commit secrets to the repo.",
        "Never merge without approval.",
        "Never restart the dev server.",
      ],
    });
    expect(probe!.id).toBe("rules");
    expect(gradeQuiz([probe!], "Never edit files under vendor/.").failed).toHaveLength(1);
    expect(
      gradeQuiz([probe!], "Never edit files under vendor/. Never commit secrets to the repo.").failed,
    ).toHaveLength(0);
  });

  it("a rule with no distinct token still counts: quoting 1 of 3 fails, 2 of 3 passes", () => {
    const [probe] = buildProbes({
      userConstraints: ["Never use npm.", "Never use yarn.", "Never use pnpm."],
    });
    expect(probe!.groups).toHaveLength(3);
    expect(probe!.minGroups).toBe(2);
    expect(gradeQuiz([probe!], "Never use yarn.").failed).toHaveLength(1);
    expect(gradeQuiz([probe!], "Never use npm. Never use yarn.").failed).toHaveLength(0);
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

  it("run-facts splice renders last run, unresolved error, and labeled user request", () => {
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

  it("intent grading only demands tokens inside the spliced 300-char window", () => {
    const long = "please fix the login bug " + "filler words here ".repeat(40) + "UNIQUETAILTOKEN";
    const [probe] = buildProbes({ lastUserMessage: long });
    expect(probe!.preserveLine).not.toContain("UNIQUETAILTOKEN");
    expect(probe!.groups.flat().join(" ")).not.toContain("UNIQUETAILTOKEN");
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

  it("a healthy newest RUN clears lastError", () => {
    const ok = [...messages, { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: false, content: [{ type: "text", text: "all green" }] }];
    expect(extractRunFacts(ok).lastError).toBeUndefined();
  });

  it("a read after a failed run does not resolve the failure", () => {
    const investigating = [...messages, { role: "toolResult", toolCallId: "c2", toolName: "read", isError: false, content: [{ type: "text", text: "file contents" }] }];
    expect(extractRunFacts(investigating).lastError).toBe("3 failed");
  });

  it("picks the line that names the error, not the command echo (pi bash puts the exit status last)", () => {
    const piShape = [
      messages[0]!,
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "> mempact@0.2.0 test\n> vitest run\n\n FAIL  test/x.test.ts > adds\nAssertionError: expected 1 to be 2\n\nCommand exited with code 1" }] },
    ];
    expect(extractRunFacts(piShape).lastError).toBe("FAIL  test/x.test.ts > adds");
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
