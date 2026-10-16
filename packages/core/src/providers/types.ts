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

export class ImageProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImageProviderError";
  }
}
