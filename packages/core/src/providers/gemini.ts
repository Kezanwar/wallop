import { GoogleGenAI, createPartFromBase64, createPartFromText } from "@google/genai";
import type { Part } from "@google/genai";
import {
  ImageProviderError,
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
    }: GenerateParams): Promise<GenerateResult> {
      const parts: Part[] = [createPartFromText(prompt)];

      // Gemini takes image input as inline base64 bytes (or a Files API URI).
      // It will NOT fetch an arbitrary http URL, so we pull the parent down
      // ourselves — a signed R2 URL works fine here.
      if (parentImageUrl) {
        const parent = await fetchImageAsBase64(parentImageUrl);
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
          },
        });
      } catch (err) {
        throw new ImageProviderError(
          `Gemini generateContent failed for model "${model}": ${errText(err)}`,
          { cause: err },
        );
      }

      const candidate = response.candidates?.[0];

      // Thought parts carry the model's reasoning and can themselves be
      // images — skip them or we'd return a scratchpad render as the design.
      const image = candidate?.content?.parts?.find(
        (part) => part.thought !== true && part.inlineData?.data,
      )?.inlineData;

      if (!image?.data) {
        throw new ImageProviderError(
          `Gemini returned no image (model "${model}"). ` +
            `blockReason=${response.promptFeedback?.blockReason ?? "none"} ` +
            `finishReason=${candidate?.finishReason ?? "none"} ` +
            `text=${truncate(response.text)}`,
        );
      }

      return {
        imageData: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType ?? "image/png",
        // modelVersion pins the exact served revision behind the alias.
        model: response.modelVersion ?? model,
        // Gemini exposes no seed on image responses.
        seed: undefined,
      };
    },
  };
}

async function fetchImageAsBase64(url: string) {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ImageProviderError(`Could not fetch parent image: ${errText(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new ImageProviderError(
      `Could not fetch parent image: ${res.status} ${res.statusText}`,
    );
  }
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
  if (!contentType?.startsWith("image/")) {
    throw new ImageProviderError(
      `Parent image URL did not return an image (content-type: ${contentType ?? "none"})`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { data: buffer.toString("base64"), mimeType: contentType };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string | undefined, max = 200): string {
  if (!value) return "none";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
