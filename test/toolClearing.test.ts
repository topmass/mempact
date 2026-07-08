import { describe, expect, it } from "vitest";
import {
  CLEARED_OUTPUT_NOTE,
  clearOldToolOutputs,
  clearedStub,
} from "../core/toolClearing.ts";

const tool = (text: string) => ({
  role: "toolResult",
  content: [{ type: "text", text }],
});
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

describe("mechanical tool-output clearing", () => {
  it("clears all but the newest keepRecent tool results", () => {
    const messages = [user("q"), tool("out 1"), tool("out 2"), tool("out 3"), tool("out 4")];
    const { messages: out, cleared } = clearOldToolOutputs(messages, 3);
    expect(cleared).toBe(1);
    expect((out[1]!.content as { text: string }[])[0]!.text).toContain(CLEARED_OUTPUT_NOTE);
    expect((out[2]!.content as { text: string }[])[0]!.text).toBe("out 2");
    expect((out[4]!.content as { text: string }[])[0]!.text).toBe("out 4");
  });

  it("keeps the first line of the cleared output as the deterministic skeleton", () => {
    const messages = [tool("exit code: 1\nlong noise\nmore noise"), tool("b"), tool("c"), tool("d")];
    const { messages: out } = clearOldToolOutputs(messages, 3);
    const text = (out[0]!.content as { text: string }[])[0]!.text;
    expect(text).toContain("first line was: exit code: 1");
    expect(text).not.toContain("long noise");
  });

  it("is a no-op at or under keepRecent", () => {
    const messages = [user("q"), tool("a"), tool("b"), tool("c")];
    const { messages: out, cleared } = clearOldToolOutputs(messages, 3);
    expect(cleared).toBe(0);
    expect(out).toEqual(messages);
  });

  it("never touches non-toolResult messages", () => {
    const messages = [user("q1"), tool("a"), user("q2"), tool("b"), tool("c"), tool("d"), tool("e")];
    const { messages: out } = clearOldToolOutputs(messages, 3);
    expect(out[0]).toBe(messages[0]);
    expect(out[2]).toBe(messages[2]);
  });

  it("collapses image blocks in cleared results to the text stub", () => {
    const withImage = {
      role: "toolResult",
      content: [
        { type: "text", text: "screenshot taken" },
        { type: "image", data: "AAAA" },
      ],
    };
    const { messages: out } = clearOldToolOutputs([withImage, tool("b"), tool("c"), tool("d")], 3);
    expect(out[0]!.content).toHaveLength(1);
    expect((out[0]!.content as { text: string }[])[0]!.text).toContain("screenshot taken");
  });

  it("clips absurd first lines in the stub", () => {
    expect(clearedStub("x".repeat(500)).length).toBeLessThan(250);
    expect(clearedStub("")).toBe(`${CLEARED_OUTPUT_NOTE}]`);
  });
});
