/**
 * Ported from codex-rs/core/src/context_manager/normalize.rs (verbatim
 * algorithm). Send-time invariants: every tool call has an output, every
 * output has a call, images stripped for text-only models. Codex runs these
 * on a clone of history just before building the model prompt; raw stored
 * history is never mutated for the model's benefit.
 */

import type { HistoryItem } from "./items.ts";

// normalize.rs:11
export const IMAGE_CONTENT_OMITTED_PLACEHOLDER =
  "image content omitted because you do not support image input";

/**
 * normalize.rs:14 ensure_call_outputs_present - synthesize an "aborted"
 * output immediately after any tool call that lacks one. Mutates `items`.
 */
export function ensureCallOutputsPresent(items: HistoryItem[]): void {
  const functionOutputIds = new Set<string>();
  const toolSearchOutputIds = new Set<string>();
  const customToolOutputIds = new Set<string>();
  for (const item of items) {
    if (item.type === "function_call_output") functionOutputIds.add(item.callId);
    else if (item.type === "tool_search_output" && item.callId != null)
      toolSearchOutputIds.add(item.callId);
    else if (item.type === "custom_tool_call_output") customToolOutputIds.add(item.callId);
  }

  // Insertion position (index of call) + synthetic item, applied in reverse
  // order to avoid index shifting (normalize.rs:36-39,118-121).
  const missingOutputsToInsert: Array<[number, HistoryItem]> = [];

  items.forEach((item, idx) => {
    if (item.type === "function_call" && !functionOutputIds.has(item.callId)) {
      missingOutputsToInsert.push([
        idx,
        { type: "function_call_output", callId: item.callId, output: { content: "aborted" } },
      ]);
    } else if (
      item.type === "tool_search_call" &&
      item.callId != null &&
      !toolSearchOutputIds.has(item.callId)
    ) {
      missingOutputsToInsert.push([
        idx,
        { type: "tool_search_output", callId: item.callId, execution: "client" },
      ]);
    } else if (item.type === "custom_tool_call" && !customToolOutputIds.has(item.callId)) {
      missingOutputsToInsert.push([
        idx,
        { type: "custom_tool_call_output", callId: item.callId, output: { content: "aborted" } },
      ]);
    } else if (
      // LocalShellCall is represented in upstream streams by a FunctionCallOutput
      item.type === "local_shell_call" &&
      item.callId != null &&
      !functionOutputIds.has(item.callId)
    ) {
      missingOutputsToInsert.push([
        idx,
        { type: "function_call_output", callId: item.callId, output: { content: "aborted" } },
      ]);
    }
  });

  for (let i = missingOutputsToInsert.length - 1; i >= 0; i--) {
    const [idx, outputItem] = missingOutputsToInsert[i]!;
    items.splice(idx + 1, 0, outputItem);
  }
}

/**
 * normalize.rs:124 remove_orphan_outputs - drop outputs whose call is gone.
 * Server-executed and call-id-less tool-search outputs are always kept.
 * Mutates `items`.
 */
export function removeOrphanOutputs(items: HistoryItem[]): void {
  const functionCallIds = new Set<string>();
  const toolSearchCallIds = new Set<string>();
  const localShellCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();
  for (const i of items) {
    if (i.type === "function_call") functionCallIds.add(i.callId);
    else if (i.type === "tool_search_call" && i.callId != null) toolSearchCallIds.add(i.callId);
    else if (i.type === "local_shell_call" && i.callId != null) localShellCallIds.add(i.callId);
    else if (i.type === "custom_tool_call") customToolCallIds.add(i.callId);
  }

  const keep = (item: HistoryItem): boolean => {
    switch (item.type) {
      case "function_call_output":
        return functionCallIds.has(item.callId) || localShellCallIds.has(item.callId);
      case "custom_tool_call_output":
        return customToolCallIds.has(item.callId);
      case "tool_search_output":
        if (item.execution === "server") return true;
        if (item.callId != null) return toolSearchCallIds.has(item.callId);
        return true;
      default:
        return true;
    }
  };

  let write = 0;
  for (let read = 0; read < items.length; read++) {
    if (keep(items[read]!)) items[write++] = items[read]!;
  }
  items.length = write;
}

/**
 * normalize.rs:199 remove_corresponding_for - when an item is removed from
 * the front of history, delete its paired partner so no orphan halves remain.
 * Mutates `items`.
 */
export function removeCorrespondingFor(items: HistoryItem[], item: HistoryItem): void {
  switch (item.type) {
    case "function_call":
      removeFirstMatching(
        items,
        (i) => i.type === "function_call_output" && i.callId === item.callId,
      );
      break;
    case "function_call_output": {
      let pos = items.findIndex((i) => i.type === "function_call" && i.callId === item.callId);
      if (pos === -1) {
        pos = items.findIndex((i) => i.type === "local_shell_call" && i.callId === item.callId);
      }
      if (pos !== -1) items.splice(pos, 1);
      break;
    }
    case "tool_search_call":
      if (item.callId != null) {
        const callId = item.callId;
        removeFirstMatching(items, (i) => i.type === "tool_search_output" && i.callId === callId);
      }
      break;
    case "tool_search_output":
      if (item.callId != null) {
        const callId = item.callId;
        removeFirstMatching(items, (i) => i.type === "tool_search_call" && i.callId === callId);
      }
      break;
    case "custom_tool_call":
      removeFirstMatching(
        items,
        (i) => i.type === "custom_tool_call_output" && i.callId === item.callId,
      );
      break;
    case "custom_tool_call_output":
      removeFirstMatching(items, (i) => i.type === "custom_tool_call" && i.callId === item.callId);
      break;
    case "local_shell_call":
      if (item.callId != null) {
        const callId = item.callId;
        removeFirstMatching(
          items,
          (i) => i.type === "function_call_output" && i.callId === callId,
        );
      }
      break;
    default:
      break;
  }
}

function removeFirstMatching(items: HistoryItem[], predicate: (i: HistoryItem) => boolean): void {
  const pos = items.findIndex(predicate);
  if (pos !== -1) items.splice(pos, 1);
}

/**
 * normalize.rs:297 strip_images_when_unsupported - replace image content
 * with a text placeholder when the model lacks image input. Mutates items.
 */
export function stripImagesWhenUnsupported(supportsImages: boolean, items: HistoryItem[]): void {
  if (supportsImages) {
    return;
  }

  for (const item of items) {
    if (item.type === "message") {
      item.content = item.content.map((c) =>
        c.type === "input_image"
          ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
          : c,
      );
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (item.output.contentItems) {
        item.output.contentItems = item.output.contentItems.map((c) =>
          c.type === "input_image"
            ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
            : c,
        );
      }
    }
  }
}
