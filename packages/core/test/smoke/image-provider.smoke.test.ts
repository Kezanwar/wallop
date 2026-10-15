import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGeminiProvider } from "../../src/providers/index";
import type { GenerateResult } from "../../src/providers/index";

// Hits the real, paid Gemini API. Skipped when the key is absent.
const hasGemini = !!process.env.GEMINI_API_KEY;

const OUT_DIR = join(import.meta.dirname, "output");

const FRESH_PROMPT =
  "Atmospheric dusk photograph of an ancient Mediterranean fig tree, its " +
  "enormous sculptural buttress roots sprawling across stone steps in the " +
  "foreground, beside a weathered pale-stone Gothic palazzo with tall arched " +
  "windows glowing warm amber from within. Soft golden evening light, muted " +
  "earthy tones, deep shadow, painterly and cinematic, shot on film, shallow " +
  "depth of field.";

const EDIT_PROMPT =
  "make it grainier with a subtle film grain and a soft faded vintage treatment";

describe.skipIf(!hasGemini)("Gemini image provider", () => {
  const provider = createGeminiProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: process.env.GEMINI_IMAGE_MODEL || undefined,
  });

  test("fresh generation, then a conversational edit of that image", async () => {
    mkdirSync(OUT_DIR, { recursive: true });

    // 1. Fresh text-to-image.
    const freshStart = Date.now();
    const fresh = await provider.generate({
      prompt: FRESH_PROMPT,
      aspectRatio: "3:4",
      resolution: "1K",
    });
    const freshMs = Date.now() - freshStart;
    const freshPath = join(OUT_DIR, `fresh${extFor(fresh.mimeType)}`);
    writeFileSync(freshPath, fresh.imageData);
    report("FRESH", fresh, freshMs, freshPath);

    expect(fresh.imageData.byteLength).toBeGreaterThan(1000);
    expect(fresh.mimeType).toMatch(/^image\//);
    expect(fresh.model).toBeTruthy();

    const freshSize = imageSize(fresh.imageData);
    expect(freshSize, "generated image header should be readable").not.toBeNull();
    // 3:4 portrait — taller than it is wide.
    expect(freshSize!.height).toBeGreaterThan(freshSize!.width);

    // 2. Edit: feed step 1's image back as the parent. The provider takes a
    //    URL, so serve the bytes locally rather than round-tripping to R2 —
    //    this test is about the provider, not storage.
    const { url, close } = await serveBytes(fresh.imageData, fresh.mimeType);
    try {
      const editStart = Date.now();
      const edited = await provider.generate({
        prompt: EDIT_PROMPT,
        aspectRatio: "3:4",
        resolution: "1K",
        parentImageUrl: url,
      });
      const editMs = Date.now() - editStart;
      const editPath = join(OUT_DIR, `edited${extFor(edited.mimeType)}`);
      writeFileSync(editPath, edited.imageData);
      report("EDIT ", edited, editMs, editPath);

      expect(edited.imageData.byteLength).toBeGreaterThan(1000);
      // A real edit returns different bytes, not an echo of the input.
      expect(Buffer.from(edited.imageData).equals(Buffer.from(fresh.imageData))).toBe(
        false,
      );

      const editSize = imageSize(edited.imageData);
      expect(editSize, "edited image header should be readable").not.toBeNull();
      // The edit must keep the 3:4 frame, not reframe the scene.
      expect(editSize!.width).toBe(freshSize!.width);
      expect(editSize!.height).toBe(freshSize!.height);

      console.log(
        `\nEyeball both images in ${OUT_DIR} — the edit should read as the same ` +
          `scene with visible grain and a faded vintage cast.\n`,
      );
    } finally {
      await close();
    }
  });
});

function report(
  label: string,
  result: GenerateResult,
  ms: number,
  path: string,
): void {
  const size = imageSize(result.imageData);
  console.log(
    `${label} ${(ms / 1000).toFixed(1)}s  ${result.mimeType}  ` +
      `${size ? `${size.width}x${size.height}` : "dimensions unknown"}  ` +
      `${(result.imageData.byteLength / 1024).toFixed(0)}KB  ` +
      `model=${result.model}  seed=${result.seed ?? "n/a"}  -> ${path}`,
  );
}

function extFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

/**
 * Dimensions straight from the file header. Gemini returns JPEG by default,
 * so this handles both rather than assuming PNG.
 */
function imageSize(
  bytes: Buffer | Uint8Array,
): { width: number; height: number } | null {
  const buf = Buffer.from(bytes);

  // PNG: IHDR is always the first chunk, width/height as big-endian uint32.
  if (buf.length >= 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: walk the segment chain to the start-of-frame, which carries the size.
  if (buf.length >= 4 && buf.readUInt16BE(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1]!;
      // SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC in that range.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }

  return null;
}

/** Minimal one-shot localhost server so the edit path has a real URL to fetch. */
async function serveBytes(bytes: Buffer | Uint8Array, mimeType: string) {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": mimeType });
    res.end(Buffer.from(bytes));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Could not bind local image server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/parent.png`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
