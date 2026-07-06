/**
 * Ported from codex-rs/core/src/context_manager/history.rs - the
 * token-estimation, record-time truncation, and reconciliation subset the
 * compaction engine depends on. Turn-rollback and world-state plumbing are
 * codex-session specific and intentionally not ported.
 */

import type {
  ContentItem,
  FunctionCallOutputContentItem,
  FunctionCallOutputPayload,
  HistoryItem,
} from "./items.ts";
import type { TruncationPolicy } from "./outputTruncation.ts";
import {
  SERIALIZATION_BUDGET_MULTIPLIER,
  mulPolicy,
  truncateFunctionOutputItemsWithPolicy,
  truncateText,
} from "./outputTruncation.ts";
import { approxTokenCount, approxTokensFromByteCount } from "./truncate.ts";
import { removeCorrespondingFor } from "./normalize.ts";

const encoder = new TextEncoder();
const utf8Len = (s: string): number => encoder.encode(s).length;

/** history.rs:518 - fixed per-image byte estimate (≈1,844 tokens). */
export const RESIZED_IMAGE_BYTES_ESTIMATE = 7373;

/** history.rs:497 estimate_reasoning_length: base64-decoded size minus fixed overhead. */
export function estimateReasoningLength(encodedLen: number): number {
  return Math.max(0, Math.floor((encodedLen * 3) / 4) - 650);
}

/** history.rs:505 estimate_encrypted_function_output_length: ceil(len*9/16). */
export function estimateEncryptedFunctionOutputLength(encodedLen: number): number {
  return Math.ceil((encodedLen * 9) / 16);
}

/**
 * history.rs:575 parse_base64_image_data_url - payload of a
 * `data:image/...;base64,...` URL (case-insensitive markers), else null.
 */
export function parseBase64ImageDataUrl(url: string): string | null {
  if (!url.slice(0, 5).toLowerCase().startsWith("data:")) return null;
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) return null;
  const metadata = url.slice(0, commaIndex);
  const payload = url.slice(commaIndex + 1);
  const metadataWithoutScheme = metadata.slice("data:".length);
  const metadataParts = metadataWithoutScheme.split(";");
  const mimeType = metadataParts[0] ?? "";
  const hasBase64Marker = metadataParts.slice(1).some((p) => p.toLowerCase() === "base64");
  if (!mimeType.slice(0, "image/".length).toLowerCase().startsWith("image/")) return null;
  if (!hasBase64Marker) return null;
  return payload;
}

/**
 * history.rs:644 image_data_url_estimate_adjustment - [payloadBytes to
 * subtract, replacementBytes to add] for inline base64 images.
 *
 * ponytail: codex's `detail:"original"` path decodes the image and counts
 * 32px patches (history.rs:604). We always use RESIZED_IMAGE_BYTES_ESTIMATE;
 * add patch counting if original-detail images ever matter here.
 */
function imageDataUrlEstimateAdjustment(item: HistoryItem): [number, number] {
  let payloadBytes = 0;
  let replacementBytes = 0;

  const accumulate = (imageUrl: string) => {
    const payload = parseBase64ImageDataUrl(imageUrl);
    if (payload != null) {
      payloadBytes += utf8Len(payload);
      replacementBytes += RESIZED_IMAGE_BYTES_ESTIMATE;
    }
  };

  if (item.type === "message") {
    for (const c of item.content) {
      if (c.type === "input_image") accumulate(c.imageUrl);
    }
  } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    for (const c of item.output.contentItems ?? []) {
      if (c.type === "input_image") accumulate(c.imageUrl);
    }
  }

  return [payloadBytes, replacementBytes];
}

/** history.rs:687 encrypted_function_output_estimate_adjustment */
function encryptedFunctionOutputEstimateAdjustment(item: HistoryItem): [number, number] {
  if (item.type !== "function_call_output" || !item.output.contentItems) return [0, 0];
  let payloadBytes = 0;
  let replacementBytes = 0;
  for (const c of item.output.contentItems) {
    if (c.type === "encrypted_content") {
      payloadBytes += utf8Len(c.encryptedContent);
      replacementBytes += estimateEncryptedFunctionOutputLength(utf8Len(c.encryptedContent));
    }
  }
  return [payloadBytes, replacementBytes];
}

/** history.rs:536 estimate_response_item_model_visible_bytes */
export function estimateItemModelVisibleBytes(item: HistoryItem): number {
  if (
    (item.type === "reasoning" && item.encryptedContent != null) ||
    (item.type === "compaction" && item.encryptedContent != null)
  ) {
    return estimateReasoningLength(utf8Len(item.encryptedContent!));
  }
  let raw = utf8Len(JSON.stringify(item));
  const [imagePayload, imageReplacement] = imageDataUrlEstimateAdjustment(item);
  const [encPayload, encReplacement] = encryptedFunctionOutputEstimateAdjustment(item);
  raw = Math.max(0, raw - imagePayload) + imageReplacement;
  return Math.max(0, raw - encPayload) + encReplacement;
}

/** history.rs:509 estimate_item_token_count */
export function estimateItemTokenCount(item: HistoryItem): number {
  return approxTokensFromByteCount(estimateItemModelVisibleBytes(item));
}

/** history.rs:163 estimate_token_count_with_base_instructions */
export function estimateTokenCountWithBaseInstructions(
  items: readonly HistoryItem[],
  baseInstructions: string,
): number {
  const baseTokens = approxTokenCount(baseInstructions);
  return items.reduce((sum, item) => sum + estimateItemTokenCount(item), baseTokens);
}

/** history.rs:454 truncate_function_output_payload */
export function truncateFunctionOutputPayload(
  output: FunctionCallOutputPayload,
  policy: TruncationPolicy,
): FunctionCallOutputPayload {
  if (output.contentItems) {
    return {
      ...output,
      contentItems: truncateFunctionOutputItemsWithPolicy(output.contentItems, policy),
    };
  }
  return { ...output, content: truncateText(output.content, policy) };
}

/**
 * history.rs:362 process_item - record-time truncation. Only tool outputs
 * are capped (policy × 1.2 serialization slack); everything else verbatim.
 */
export function processItem(item: HistoryItem, policy: TruncationPolicy): HistoryItem {
  const policyWithSerializationBudget = mulPolicy(policy, SERIALIZATION_BUDGET_MULTIPLIER);
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return {
      ...item,
      output: truncateFunctionOutputPayload(item.output, policyWithSerializationBudget),
    };
  }
  return item;
}

/** history.rs:476 is_api_message - what belongs in model-visible history. */
export function isApiMessage(item: HistoryItem): boolean {
  switch (item.type) {
    case "message":
      return item.role !== "system";
    case "compaction_trigger":
    case "other":
      return false;
    default:
      return true;
  }
}

/** history.rs:712 is_model_generated_item */
export function isModelGeneratedItem(item: HistoryItem): boolean {
  switch (item.type) {
    case "message":
      return item.role === "assistant";
    case "reasoning":
    case "function_call":
    case "tool_search_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "compaction":
    case "context_compaction":
      return true;
    default:
      return false;
  }
}

/** history.rs:733 is_user_turn_boundary (inter-agent variants not ported). */
export function isUserTurnBoundary(item: HistoryItem): boolean {
  return item.type === "message" && item.role === "user";
}

/**
 * history.rs:309 items_after_last_model_generated_item - local items the
 * server-reported usage has not counted yet.
 */
export function itemsAfterLastModelGeneratedItem(items: readonly HistoryItem[]): HistoryItem[] {
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    if (isModelGeneratedItem(items[i]!)) {
      start = i + 1;
      break;
    }
  }
  return items.slice(start);
}

/**
 * history.rs:320 get_total_token_usage - trust the server's last-reported
 * total as the baseline; add cheap estimates only for items appended locally
 * since the last model response.
 */
export function getTotalTokenUsage(
  items: readonly HistoryItem[],
  serverReportedLastTotal: number,
): number {
  return itemsAfterLastModelGeneratedItem(items).reduce(
    (sum, item) => sum + estimateItemTokenCount(item),
    serverReportedLastTotal,
  );
}

/**
 * history.rs:179 remove_first_item - drop the oldest item together with its
 * call/output partner so pairing invariants hold without a full
 * normalization pass. Mutates `items`.
 */
export function removeFirstItem(items: HistoryItem[]): void {
  if (items.length > 0) {
    const removed = items.shift()!;
    removeCorrespondingFor(items, removed);
  }
}

export type { ContentItem, FunctionCallOutputContentItem };
