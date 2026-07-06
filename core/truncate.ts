/**
 * Ported from codex-rs/utils/string/src/truncate.rs (verbatim algorithm).
 *
 * Truncates large output while preserving a prefix and suffix on UTF-8
 * boundaries. All byte math is UTF-8 byte length (Rust `str::len()`), not
 * UTF-16 code units; "chars" are Unicode scalar values (JS code points).
 */

// truncate.rs:4
export const APPROX_BYTES_PER_TOKEN = 4;

const encoder = new TextEncoder();

function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

function codePointUtf8Len(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/** truncate.rs:7 truncate_middle_chars */
export function truncateMiddleChars(s: string, maxBytes: number): string {
  return truncateWithByteEstimate(s, maxBytes, /*useTokens*/ false);
}

/**
 * truncate.rs:15 truncate_middle_with_token_budget
 * Returns [possibly truncated string, original token count if truncated else null].
 */
export function truncateMiddleWithTokenBudget(
  s: string,
  maxTokens: number,
): [string, number | null] {
  if (s.length === 0) {
    return ["", null];
  }

  if (maxTokens > 0 && utf8Len(s) <= approxBytesForTokens(maxTokens)) {
    return [s, null];
  }

  const truncated = truncateWithByteEstimate(s, approxBytesForTokens(maxTokens), /*useTokens*/ true);
  const totalTokens = approxTokenCount(s);

  return truncated === s ? [truncated, null] : [truncated, totalTokens];
}

/** truncate.rs:38 truncate_with_byte_estimate */
function truncateWithByteEstimate(s: string, maxBytes: number, useTokens: boolean): string {
  if (s.length === 0) {
    return "";
  }

  const totalBytes = utf8Len(s);
  let totalChars = 0;
  for (const _ of s) totalChars++;

  if (maxBytes === 0) {
    return formatTruncationMarker(useTokens, removedUnits(useTokens, totalBytes, totalChars));
  }

  if (totalBytes <= maxBytes) {
    return s;
  }

  const [leftBudget, rightBudget] = splitBudget(maxBytes);
  const [removedChars, left, right] = splitString(s, leftBudget, rightBudget);
  const marker = formatTruncationMarker(
    useTokens,
    removedUnits(useTokens, Math.max(0, totalBytes - maxBytes), removedChars),
  );

  return left + marker + right;
}

/** truncate.rs:71 approx_token_count: ceil(utf8ByteLen / 4) */
export function approxTokenCount(text: string): number {
  const len = utf8Len(text);
  return Math.floor((len + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN);
}

/** truncate.rs:76 approx_bytes_for_tokens */
export function approxBytesForTokens(tokens: number): number {
  return tokens * APPROX_BYTES_PER_TOKEN;
}

/** truncate.rs:80 approx_tokens_from_byte_count */
export function approxTokensFromByteCount(bytes: number): number {
  return Math.floor((bytes + (APPROX_BYTES_PER_TOKEN - 1)) / APPROX_BYTES_PER_TOKEN);
}

/**
 * truncate.rs:86 split_string - byte-budgeted prefix/suffix split on
 * code-point boundaries. Returns [removedChars, prefix, suffix].
 * Exported for parity tests (codex unit-tests it directly).
 */
export function splitString(
  s: string,
  beginningBytes: number,
  endBytes: number,
): [number, string, string] {
  if (s.length === 0) {
    return [0, "", ""];
  }

  const len = utf8Len(s);
  const tailStartTarget = Math.max(0, len - endBytes);
  let prefixEndJs = 0; // JS index (code units) matching prefixEnd byte offset
  let suffixStartJs = s.length;
  let prefixEndByte = 0;
  let suffixStartByte = len;
  let removedChars = 0;
  let suffixStarted = false;

  let byteIdx = 0;
  let jsIdx = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const charBytes = codePointUtf8Len(cp);
    const charEnd = byteIdx + charBytes;
    if (charEnd <= beginningBytes) {
      prefixEndByte = charEnd;
      prefixEndJs = jsIdx + ch.length;
    } else if (byteIdx >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStartByte = byteIdx;
        suffixStartJs = jsIdx;
        suffixStarted = true;
      }
    } else {
      removedChars += 1;
    }
    byteIdx = charEnd;
    jsIdx += ch.length;
  }

  if (suffixStartByte < prefixEndByte) {
    suffixStartJs = prefixEndJs;
  }

  return [removedChars, s.slice(0, prefixEndJs), s.slice(suffixStartJs)];
}

/** truncate.rs:126 split_budget: left = budget/2 (floor), right = remainder */
function splitBudget(budget: number): [number, number] {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

/** truncate.rs:131 format_truncation_marker */
function formatTruncationMarker(useTokens: boolean, removedCount: number): string {
  return useTokens ? `…${removedCount} tokens truncated…` : `…${removedCount} chars truncated…`;
}

/** truncate.rs:139 removed_units */
function removedUnits(useTokens: boolean, removedBytes: number, removedChars: number): number {
  return useTokens ? approxTokensFromByteCount(removedBytes) : removedChars;
}
