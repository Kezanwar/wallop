// Deliberately narrow and provider-agnostic: no Gemini types cross this line.
// The image side proved the value of that — we expect to A/B text models for
// the wand composer the same way, and swapping should mean writing one new
// file that returns this interface.

export type LLMUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Billed as output, and easy to forget. See `reasoning` below. */
  thinkingTokens?: number;
  totalTokens?: number;
};

export interface CompleteParams {
  /** The user message — the content being acted on. */
  prompt: string;

  /** System instruction: who the model is and what shape the answer takes. */
  system?: string;

  /**
   * Per-call model override. A title is a trivial task and can run on
   * something cheap; the composer will want a fuller model. Choosing per call
   * means neither needs a rebuild to change its mind.
   */
  model?: string;

  maxOutputTokens?: number;
  temperature?: number;

  /**
   * Whether the model may reason before answering. Agnostic on purpose —
   * every serious provider now has some form of this, under its own name.
   *
   * "none" is not only a cost saving. Reasoning tokens are drawn from the
   * SAME budget as the answer, so a small maxOutputTokens plus thinking can
   * burn the whole allowance on thoughts and return empty text. For short,
   * mechanical outputs, turn it off.
   */
  reasoning?: "none" | "default";

  /** Observability hook. Kept off the return type so callers get a plain string. */
  onUsage?: (usage: LLMUsage) => void;

  signal?: AbortSignal;
}

export type LLMProviderErrorKind =
  /** Worth another attempt: timeouts, 5xx, rate limits, dropped connections. */
  | "transient"
  /** Retrying pays for the same answer: bad key, bad request, bad model id. */
  | "invalid"
  /** The model refused on content grounds. */
  | "moderation";

export class LLMProviderError extends Error {
  readonly kind: LLMProviderErrorKind;
  constructor(
    message: string,
    options: { kind: LLMProviderErrorKind; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "LLMProviderError";
    this.kind = options.kind;
  }
  get retryable() {
    return this.kind === "transient";
  }
}

export interface LLMProvider {
  /** Resolves with the whole response — not a stream. */
  complete(params: CompleteParams): Promise<string>;

  // TODO: vision(image + text → text) lands here when reference-image style
  // extraction is built (prompt-engineering.md §3.5). Text only for now.
}
