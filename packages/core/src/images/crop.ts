import sharp from "sharp";

export type CropFormat = "webp" | "png" | "jpeg";

export type CroppedImage = {
  data: Buffer;
  width: number;
  height: number;
  format: CropFormat;
  mimeType: string;
};

const MIME: Record<CropFormat, string> = {
  webp: "image/webp",
  png: "image/png",
  jpeg: "image/jpeg",
};

/**
 * Centre-crop an image to `targetRatio` (width / height), trimming whichever
 * axis is too long. Never upscales or pads — the output is always a subregion
 * of the input.
 *
 * Why: providers only do a fixed set of ratios (Gemini's nearest to A-series
 * is 3:4 = 0.75), and prints are A-series (1:√2 ≈ 0.7071). A 3:4 portrait is
 * too WIDE for A-series, so the width gets trimmed equally from both sides.
 *
 * Output defaults to webp (previews); prints will want png.
 */
export async function cropToAspect(
  imageBytes: Buffer | Uint8Array,
  targetRatio: number,
  format: CropFormat = "webp",
): Promise<CroppedImage> {
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) {
    throw new Error(`cropToAspect: invalid target ratio ${targetRatio}`);
  }

  // Dimensions as DISPLAYED (EXIF orientation applied), matching the
  // autoOrient() below — so a sideways-tagged photo crops the right axis.
  const { autoOrient } = await sharp(imageBytes).metadata();
  const { width: srcW, height: srcH } = autoOrient;

  const { width, height } = cropBox(srcW, srcH, targetRatio);
  const left = Math.floor((srcW - width) / 2);
  const top = Math.floor((srcH - height) / 2);

  // One decode, one encode: orient → extract → encode, no lossy round trip.
  let pipeline = sharp(imageBytes)
    .autoOrient()
    .extract({ left, top, width, height });
  pipeline =
    format === "webp"
      ? pipeline.webp({ quality: 90 })
      : format === "png"
        ? pipeline.png()
        : pipeline.jpeg({ quality: 92, mozjpeg: true });

  const out = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data: out.data,
    width: out.info.width,
    height: out.info.height,
    format,
    mimeType: MIME[format],
  };
}

/** The largest box of `ratio` that fits inside srcW x srcH. Exported for tests. */
export function cropBox(
  srcW: number,
  srcH: number,
  ratio: number,
): { width: number; height: number } {
  if (srcW / srcH > ratio) {
    // Too wide — keep full height, trim width.
    return { width: Math.min(srcW, Math.round(srcH * ratio)), height: srcH };
  }
  // Too tall (or exact) — keep full width, trim height.
  return { width: srcW, height: Math.min(srcH, Math.round(srcW / ratio)) };
}
