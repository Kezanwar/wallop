// Provider-agnostic image generation. No Gemini (or any SDK) types cross this
// line — we expect to A/B other providers behind the same interface.

export type ImageResolution = "1K" | "2K" | "4K";

export interface GenerateParams {
  prompt: string;

  /** Passed straight through, e.g. "3:4". Providers reject what they can't do. */
  aspectRatio: string;

  resolution: ImageResolution;

  /**
   * When set, this is an EDIT: the parent design's image goes to the model
   * alongside the prompt. When absent, fresh text-to-image. This one field is
   * how the iterate loop works.
   */
  parentImageUrl?: string;

  /**
   * Abandons the call client-side (the job's expiry fires it). The provider
   * may still finish — and bill — server-side; this only stops us waiting.
   */
  signal?: AbortSignal;
}

export interface GenerateResult {
  imageData: Buffer | Uint8Array;
  mimeType: string;
  /** Resolved model identity as the provider reports it, for audit. */
  model: string;
  /** Only when the provider exposes one. Gemini does not. */
  seed?: string;
}

export interface ImageProvider {
  generate(params: GenerateParams): Promise<GenerateResult>;
}

/**
 * How a failed generation should be handled — the pipeline's retry/refund
 * split hangs off this, so every provider must classify its own errors.
 *
 * - `moderation`: the provider refused the content. Terminal; retrying the
 *   same prompt just pays for the same refusal.
 * - `invalid`:    the request itself is wrong (4xx, bad prompt, no image for
 *   a non-image prompt, auth/billing). Terminal.
 * - `transient`:  timeout, network, 5xx, rate limit. Worth retrying.
 */
export type ImageProviderErrorKind = "moderation" | "invalid" | "transient";

export class ImageProviderError extends Error {
  readonly kind: ImageProviderErrorKind;

  constructor(
    message: string,
    options: { kind: ImageProviderErrorKind; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "ImageProviderError";
    this.kind = options.kind;
  }

  get retryable(): boolean {
    return this.kind === "transient";
  }
}
