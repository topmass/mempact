/**
 * Neutral history-item model mirroring codex's ResponseItem
 * (codex-rs/protocol/src/models.rs), reduced to the variants the ported
 * compaction/normalization functions operate on. Field names follow the
 * Rust serde wire names where they matter (`type` discriminants), otherwise
 * camelCase. The pi layer maps pi AgentMessages to and from this model.
 */

// codex FunctionCallOutputContentItem (protocol/src/models.rs)
export type FunctionCallOutputContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; imageUrl: string; detail?: string }
  | { type: "encrypted_content"; encryptedContent: string };

// codex FunctionCallOutputPayload: `content` is the plain-text body,
// `contentItems` the structured body (at most one is meaningful).
export interface FunctionCallOutputPayload {
  content: string;
  contentItems?: FunctionCallOutputContentItem[];
  success?: boolean;
}

export type ContentItem =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; imageUrl: string; detail?: string };

export type HistoryItem =
  | {
      type: "message";
      role: "user" | "assistant" | "developer" | "system";
      content: ContentItem[];
      id?: string;
    }
  | { type: "reasoning"; encryptedContent?: string; id?: string }
  | { type: "function_call"; name: string; arguments: string; callId: string; id?: string }
  | { type: "function_call_output"; callId: string; output: FunctionCallOutputPayload }
  | { type: "custom_tool_call"; name: string; input: string; callId: string; id?: string }
  | { type: "custom_tool_call_output"; callId: string; output: FunctionCallOutputPayload }
  | { type: "local_shell_call"; callId?: string; id?: string; status: string }
  | { type: "tool_search_call"; callId?: string; id?: string }
  | { type: "tool_search_output"; callId?: string; execution?: "client" | "server" }
  // Opaque compaction markers (codex ResponseItem::Compaction / ContextCompaction).
  | { type: "compaction"; encryptedContent?: string; id?: string }
  | { type: "context_compaction"; id?: string }
  | { type: "compaction_trigger" }
  | { type: "other" };

/** Port of codex content_items_to_text (codex-rs/core/src/compact.rs:445). */
export function contentItemsToText(content: ContentItem[]): string | null {
  const pieces: string[] = [];
  for (const item of content) {
    if ((item.type === "input_text" || item.type === "output_text") && item.text.length > 0) {
      pieces.push(item.text);
    }
  }
  return pieces.length === 0 ? null : pieces.join("\n");
}

/**
 * Message text as seen by codex's TurnItem::UserMessage::message() /
 * get_last_assistant_message_from_turn: joined text content.
 */
export function messageText(item: HistoryItem): string | null {
  return item.type === "message" ? contentItemsToText(item.content) : null;
}
