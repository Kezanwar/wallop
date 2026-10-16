import {
  ApiError,
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";
import type { Part } from "@google/genai";
import {
  ImageProviderError,
  type ImageProviderErrorKind,
  type GenerateParams,
  type GenerateResult,
  type ImageProvider,
} from "./types";

export type GeminiConfig = {
  apiKey: string;
  /** Override for A/B-ing model versions without a code change. */
  model?: string;
};

/** Nano Banana 2. */
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

// Gemini 3 image models are "thinking" models — reasoning is always on and a
// single call runs ~12-23s at 1K, longer at 4K.
const DEFAULT_TIMEOUT_MS = 300_000;

export function createGeminiProvider(config: GeminiConfig): ImageProvider {
  const model = config.model ?? DEFAULT_GEMINI_IMAGE_MODEL;
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: { timeout: DEFAULT_TIMEOUT_MS },
  });

  return {
    async generate({
      prompt,
      aspectRatio,
      resolution,
      parentImageUrl,
      signal,
    }: GenerateParams): Promise<GenerateResult> {
      const parts: Part[] = [createPartFromText(prompt)];

      // Gemini takes image input as inline base64 bytes (or a Files API URI).
      // It will NOT fetch an arbitrary http URL, so we pull the parent down
      // ourselves — a signed R2 URL works fine here.
      if (parentImageUrl) {
        const parent = await fetchImageAsBase64(parentImageUrl, signal);
        parts.push(createPartFromBase64(parent.data, parent.mimeType));
      }

      let response;
      try {
        // Non-streaming: resolves once with the whole image.
        response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio, imageSize: resolution },
            abortSignal: signal,
          },
        });
      } catch (err) {
        throw new ImageProviderError(
          `Gemini generateContent failed for model "${model}": ${errText(err)}`,
          { kind: classifyRequestError(err), cause: err },
        );
      }

      const candidate = response.candidates?.[0];

      // Thought parts carry the model's reasoning and can themselves be
      // images — skip them or we'd return a scratchpad render as the design.
      const image = candidate?.content?.parts?.find(
        (part) => part.thought !== true && part.inlineData?.data,
      )?.inlineData;

      if (!image?.data) {
        const blockReason = response.promptFeedback?.blockReason;
        const finishReason = candidate?.finishReason;
        throw new ImageProviderError(
          `Gemini returned no image (model "${model}"). ` +
            `blockReason=${blockReason ?? "none"} ` +
            `finishReason=${finishReason ?? "none"} ` +
            `text=${truncate(response.text)}`,
          { kind: classifyNoImage(blockReason, finishReason) },
        );
      }

      const imageData = Buffer.from(image.data, "base64");

      return {
        imageData,
        // In practice Gemini always sets this (image/jpeg by default), but the
        // content-type we store in R2 has to be right, so never guess a default.
        mimeType: image.mimeType ?? sniffMimeType(imageData),
        // modelVersion pins the exact served revision behind the alias.
        model: response.modelVersion ?? model,
        // Gemini exposes no seed on image responses.
        seed: undefined,
      };
    },
  };
}

async function fetchImageAsBase64(url: string, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    throw new ImageProviderError(`Could not fetch parent image: ${errText(err)}`, {
      kind: "transient",
      cause: err,
    });
  }
  if (!res.ok) {
    throw new ImageProviderError(
      `Could not fetch parent image: ${res.status} ${res.statusText}`,
      { kind: classifyStatus(res.status) },
    );
  }
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
  if (!contentType?.startsWith("image/")) {
    throw new ImageProviderError(
      `Parent image URL did not return an image (content-type: ${contentType ?? "none"})`,
      { kind: "invalid" },
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString("base64"), mimeType: contentType };
}

/** Last resort when the API omits mimeType — magic bytes, not an assumption. */
function sniffMimeType(buf: Buffer): string {
  if (buf.length >= 2 && buf.readUInt16BE(0) === 0xffd8) return "image/jpeg";
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new ImageProviderError(
    "Gemini returned image bytes with no mimeType and an unrecognised header",
    { kind: "transient" },
  );
}

/**
 * The SDK throws ApiError (with .status) for any non-2xx. Anything else —
 * AbortError from a timeout or our signal, `TypeError: fetch failed`,
 * ECONNRESET — never reached a verdict, so it's worth another try.
 *
 * The SDK's own retries are OFF (we pass no retryOptions), so pg-boss is the
 * only retry layer and the timings stay predictable.
 */
function classifyRequestError(err: unknown): ImageProviderErrorKind {
  if (err instanceof ApiError) return classifyStatus(err.status);
  return "transient";
}

function classifyStatus(status: number): ImageProviderErrorKind {
  if (status === 408 || status === 429 || status >= 500) return "transient";
  // 400 covers both a bad request and Gemini's "API key not valid"; 401/403
  // are auth/billing. Retrying fixes none of them.
  return "invalid";
}

// Content refusals. Retrying the same prompt pays for the same answer.
const MODERATION_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

// The model answered but produced no image — typically a text-only reply to
// a prompt it didn't read as an image request. Deterministic enough that a
// retry would just pay twice.
const INVALID_FINISH_REASONS = new Set(["NO_IMAGE", "STOP", "MAX_TOKENS"]);

/**
 * A 200 with no image. Anything not recognised (OTHER, IMAGE_OTHER, a reason
 * added in a later SDK) falls through to transient: one more attempt is
 * cheaper than wrongly telling the user their prompt was the problem.
 */
function classifyNoImage(
  blockReason: string | undefined,
  finishReason: string | undefined,
): ImageProviderErrorKind {
  if (blockReason) return "moderation";
  if (finishReason && MODERATION_FINISH_REASONS.has(finishReason)) {
    return "moderation";
  }
  if (finishReason && INVALID_FINISH_REASONS.has(finishReason)) return "invalid";
  return "transient";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string | undefined, max = 200): string {
  if (!value) return "none";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
