import { createGeminiLLM, DEFAULT_GEMINI_TEXT_MODEL } from "./gemini";
import type { LLMProvider } from "./types";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// The client holds a connection pool and should live for the process.
// The globalThis stash survives Next's hot reload, which would otherwise
// leak a new client on every file save.
const globalForLLM = globalThis as unknown as {
  __llmProvider?: LLMProvider;
};

/** The default text model. Any call may override it per request. */
export function resolveTextModel(): string {
  return process.env.GEMINI_TEXT_MODEL || DEFAULT_GEMINI_TEXT_MODEL;
}

/**
 * Resolved lazily, so importing anything in this module tree doesn't demand
 * an API key — only actually calling the model does.
 */
export function getLLMProvider(): LLMProvider {
  globalForLLM.__llmProvider ??= createGeminiLLM({
    apiKey: required("GEMINI_API_KEY"),
    model: resolveTextModel(),
  });
  return globalForLLM.__llmProvider;
}
