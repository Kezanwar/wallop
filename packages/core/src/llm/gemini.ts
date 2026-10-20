import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  LLMProviderError,
  type CompleteParams,
  type LLMProvider,
  type LLMProviderErrorKind,
} from "./types";

export type GeminiLLMConfig = {
  apiKey: string;
  /** Default for calls that don't name one. Overridable per call. */
  model?: string;
};

/**
 * The TEXT model, distinct from the image model in ../providers. Same SDK and
 * same GEMINI_API_KEY, different model and different job.
 *
 * NOT gemini-2.5-flash: the API now refuses it for new users with a 404
 * pointing here ("no longer available to new users"). Override per call or
 * with GEMINI_TEXT_MODEL when a cheaper or fuller model suits the task.
 */
export const DEFAULT_GEMINI_TEXT_MODEL = "gemini-3.8-flash";

/** Text calls are quick. Nothing here should ever sit for minutes. */
const DEFAULT_TIMEOUT_MS = 60_000;

export function createGeminiLLM(config: GeminiLLMConfig): LLMProvider {
  const defaultModel = config.model ?? DEFAULT_GEMINI_TEXT_MODEL;
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: { timeout: DEFAULT_TIMEOUT_MS },
  });

  return {
    async complete({
      prompt,
      system,
      model,
      maxOutputTokens,
      temperature,
      reasoning,
      onUsage,
      signal,
    }: CompleteParams): Promise<string> {
      const resolved = model ?? defaultModel;

      let response;
      try {
        // Non-streaming: resolves once with the whole answer.
        response = await ai.models.generateContent({
          model: resolved,
          contents: prompt,
          config: {
            // The SDK takes the system instruction in `config`, NOT as a
            // message with role "system" — there is no such role here.
            systemInstruction: system,
            maxOutputTokens,
            temperature,
            abortSignal: signal,
            ...(reasoning === "none"
              ? { thinkingConfig: minimalThinking(resolved) }
              : {}),
          },
        });
      } catch (err) {
        throw new LLMProviderError(
          `Gemini generateContent failed for model "${resolved}": ${errText(err)}`,
          { kind: classifyRequestError(err), cause: err },
        );
      }

      const usage = response.usageMetadata;
      onUsage?.({
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        thinkingTokens: usage?.thoughtsTokenCount,
        totalTokens: usage?.totalTokenCount,
      });

      const text = response.text;
      if (!text?.trim()) {
        const blockReason = response.promptFeedback?.blockReason;
        const finishReason = response.candidates?.[0]?.finishReason;
        throw new LLMProviderError(
          `Gemini returned no text (model "${resolved}"). ` +
            `blockReason=${blockReason ?? "none"} ` +
            `finishReason=${finishReason ?? "none"} ` +
            `thinkingTokens=${usage?.thoughtsTokenCount ?? 0}`,
          { kind: classifyNoText(blockReason, finishReason) },
        );
      }

      return text;
    },
  };
}

/**
 * Two generations of model, two knobs, and the API rejects both at once:
 * "You can only set only one of thinking budget and thinking level."
 *
 * Gemini 3 reads thinkingLevel; Gemini 2.x reads thinkingBudget, where 0 is
 * off. Gemini 3 cannot be told to stop thinking at all, and the floor is per
 * model — gemini-3.8-flash rejects MINIMAL outright ("not supported for this
 * model"), so LOW is as quiet as it gets.
 *
 * So reasoning: "none" means "as little as this model allows", and a caller
 * must still leave maxOutputTokens headroom for whatever thoughts remain.
 */
function minimalThinking(model: string) {
  return model.startsWith("gemini-3")
    ? { thinkingLevel: ThinkingLevel.LOW }
    : { thinkingBudget: 0 };
}

/**
 * The SDK throws ApiError (with .status) for any non-2xx. Anything else —
 * an AbortError from a timeout, `TypeError: fetch failed`, ECONNRESET —
 * never reached a verdict, so it's worth another try.
 */
function classifyRequestError(err: unknown): LLMProviderErrorKind {
  if (err instanceof ApiError) return classifyStatus(err.status);
  return "transient";
}

function classifyStatus(status: number): LLMProviderErrorKind {
  if (status === 408 || status === 429 || status >= 500) return "transient";
  // 400 covers a bad request and "API key not valid"; 401/403 are auth or
  // billing. Retrying fixes none of them.
  return "invalid";
}

const MODERATION_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
]);

/**
 * A 200 with no usable text.
 *
 * MAX_TOKENS is treated as retryable because its usual cause here is thinking
 * eating the whole output budget — a different budget or reasoning: "none"
 * fixes it, and failing loudly on the first attempt would be premature.
 * Anything unrecognised also falls through to transient: one more attempt is
 * cheaper than wrongly blaming the caller's prompt.
 */
function classifyNoText(
  blockReason: string | undefined,
  finishReason: string | undefined,
): LLMProviderErrorKind {
  if (blockReason) return "moderation";
  if (finishReason && MODERATION_FINISH_REASONS.has(finishReason)) {
    return "moderation";
  }
  return "transient";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
