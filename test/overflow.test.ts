import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "../pi/index.ts";

/**
 * Audit F4 regression: the fallback overflow classifier must recognize the
 * error strings of the providers mempact is actually used with. Ground-truth
 * strings from pi-ai 0.84.2 utils/overflow.ts documentation.
 */
describe("isContextOverflowError fallback classifier", () => {
  const overflowMessages = [
    // llama.cpp - the string the ORIGINAL regex missed (the user's own backend)
    "the request exceeds the available context size, try increasing it",
    // LM Studio
    "input is greater than the context length of this model",
    // Anthropic
    "prompt is too long: 210000 tokens > 200000 maximum",
    // OpenAI
    "This model's maximum context length is 128000 tokens, your messages exceeds the context window",
    "Your input exceeds the model's maximum context length of 128000 tokens",
    // Google
    "The input token count exceeds the maximum number of tokens allowed",
    // Groq
    "Please reduce the length of the messages or functions",
    // xAI
    "maximum prompt length is 131072 but request contains 150000 tokens",
    // generic phrasings the old regex already caught
    "context window exceeded",
    "too many tokens in the request",
  ];
  for (const msg of overflowMessages) {
    it(`matches: ${msg.slice(0, 55)}...`, () => {
      expect(isContextOverflowError(new Error(msg))).toBe(true);
    });
  }

  const nonOverflow = [
    "connection refused",
    "rate limit exceeded, retry after 60s",
    "invalid api key",
    "model not found",
    "server overloaded, please retry",
  ];
  for (const msg of nonOverflow) {
    it(`does not match: ${msg}`, () => {
      expect(isContextOverflowError(new Error(msg))).toBe(false);
    });
  }
});
