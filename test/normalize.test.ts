/**
 * Behavior tests for the normalize.rs port (pairing/orphan invariants),
 * covering the cases exercised in
 * reference/codex-rs/core/src/context_manager/history_tests.rs.
 */

import { describe, expect, it } from "vitest";
import {
  IMAGE_CONTENT_OMITTED_PLACEHOLDER,
  ensureCallOutputsPresent,
  removeCorrespondingFor,
  removeOrphanOutputs,
  stripImagesWhenUnsupported,
} from "../core/normalize.ts";
import { removeFirstItem } from "../core/history.ts";
import type { HistoryItem } from "../core/items.ts";

const call = (callId: string): HistoryItem => ({
  type: "function_call",
  name: "tool",
  arguments: "{}",
  callId,
});
const output = (callId: string, content = "ok"): HistoryItem => ({
  type: "function_call_output",
  callId,
  output: { content },
});
const user = (text: string): HistoryItem => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

describe("ensureCallOutputsPresent (normalize.rs:14)", () => {
  it("synthesizes an 'aborted' output immediately after an unanswered call", () => {
    const items = [call("c1"), user("next")];
    ensureCallOutputsPresent(items);
    expect(items).toEqual([call("c1"), output("c1", "aborted"), user("next")]);
  });

  it("leaves answered calls untouched", () => {
    const items = [call("c1"), output("c1")];
    ensureCallOutputsPresent(items);
    expect(items).toEqual([call("c1"), output("c1")]);
  });

  it("handles multiple missing outputs without index shifting", () => {
    const items = [call("c1"), call("c2"), user("x")];
    ensureCallOutputsPresent(items);
    expect(items).toEqual([
      call("c1"),
      output("c1", "aborted"),
      call("c2"),
      output("c2", "aborted"),
      user("x"),
    ]);
  });

  it("synthesizes for custom tool calls and local shell calls", () => {
    const items: HistoryItem[] = [
      { type: "custom_tool_call", name: "t", input: "", callId: "cu1" },
      { type: "local_shell_call", callId: "sh1", status: "completed" },
    ];
    ensureCallOutputsPresent(items);
    expect(items[1]).toEqual({
      type: "custom_tool_call_output",
      callId: "cu1",
      output: { content: "aborted" },
    });
    expect(items[3]).toEqual(output("sh1", "aborted"));
  });
});

describe("removeOrphanOutputs (normalize.rs:124)", () => {
  it("drops outputs whose call is gone", () => {
    const items = [output("ghost"), user("keep")];
    removeOrphanOutputs(items);
    expect(items).toEqual([user("keep")]);
  });

  it("keeps outputs matched by local shell calls", () => {
    const items: HistoryItem[] = [
      { type: "local_shell_call", callId: "sh1", status: "completed" },
      output("sh1"),
    ];
    removeOrphanOutputs(items);
    expect(items.length).toBe(2);
  });

  it("always keeps server-executed and id-less tool search outputs", () => {
    const items: HistoryItem[] = [
      { type: "tool_search_output", callId: "orphan", execution: "server" },
      { type: "tool_search_output" },
      { type: "tool_search_output", callId: "orphan2", execution: "client" },
    ];
    removeOrphanOutputs(items);
    expect(items).toEqual([
      { type: "tool_search_output", callId: "orphan", execution: "server" },
      { type: "tool_search_output" },
    ]);
  });
});

describe("removeCorrespondingFor (normalize.rs:199) via removeFirstItem", () => {
  it("removing a call from the front also removes its output", () => {
    const items = [call("c1"), output("c1"), user("keep")];
    removeFirstItem(items);
    expect(items).toEqual([user("keep")]);
  });

  it("removing an output also removes its call", () => {
    const items = [output("c1"), call("c1"), user("keep")];
    removeFirstItem(items);
    expect(items).toEqual([user("keep")]);
  });

  it("plain messages remove nothing else", () => {
    const items = [user("a"), user("b")];
    removeFirstItem(items);
    expect(items).toEqual([user("b")]);
  });

  it("custom tool pairs are removed together", () => {
    const items: HistoryItem[] = [
      { type: "custom_tool_call", name: "t", input: "", callId: "cu1" },
      { type: "custom_tool_call_output", callId: "cu1", output: { content: "ok" } },
      user("keep"),
    ];
    const removed = items.shift()!;
    removeCorrespondingFor(items, removed);
    expect(items).toEqual([user("keep")]);
  });
});

describe("stripImagesWhenUnsupported (normalize.rs:297)", () => {
  it("replaces message images with the placeholder", () => {
    const items: HistoryItem[] = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "look:" },
          { type: "input_image", imageUrl: "data:image/png;base64,AAAA" },
        ],
      },
    ];
    stripImagesWhenUnsupported(false, items);
    expect((items[0] as { content: unknown }).content).toEqual([
      { type: "input_text", text: "look:" },
      { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER },
    ]);
  });

  it("replaces tool output images", () => {
    const items: HistoryItem[] = [
      {
        type: "function_call_output",
        callId: "c1",
        output: {
          content: "",
          contentItems: [{ type: "input_image", imageUrl: "data:image/png;base64,AAAA" }],
        },
      },
    ];
    stripImagesWhenUnsupported(false, items);
    expect((items[0] as { output: { contentItems: unknown } }).output.contentItems).toEqual([
      { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER },
    ]);
  });

  it("does nothing when the model supports images", () => {
    const items: HistoryItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", imageUrl: "data:image/png;base64,AAAA" }],
      },
    ];
    stripImagesWhenUnsupported(true, items);
    expect((items[0] as { content: unknown[] }).content[0]).toEqual({
      type: "input_image",
      imageUrl: "data:image/png;base64,AAAA",
    });
  });
});
